# v0.3.0 效能 Benchmark（GPU 閒置時執行；全程持有全機 GPU 租約，不與任何 GPU 測試、渲染、截圖同時進行）
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/bench_v03.py [--project <PROJECT_DIR>-v03-e2e] [--runs 2]
#  B1 渲染（v0.2.1 render.mjs vs v0.3 render.mjs）：EP04-30fps 前 1800 幀、--fresh、同一個專案、交替執行
#  B2 配音（v0.2.1 vs v0.3 generate_voiceover_cosy.py）：EP04 同 6 句、--force、輸出到獨立資料夾（正式音檔不變）
#  B3 介面與渲染同時進行：v0.3 渲染時開著 Studio（導覽測試持續切換畫面），介面在內顯 vs 在獨顯，對照 B1
#  B4 時間軸（build_timeline v0.2.1 vs v0.3，試算模式）與 Studio 閒置 CPU／RAM（v0.2.1 EXE vs v0.3 EXE）
import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "out" / "v03" / "bench"
OLD = "e201e19"  # v0.2.1 + voice-speed fix (last commit before v0.3)
EXE_NEW = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
EXE_OLD = ROOT / "out" / "v03" / "before" / "PikaraScienceStudio-v0.2.1-debug.exe"
COSY_PY = ROOT / "tools" / "CosyVoice" / ".venv" / "Scripts" / "python.exe"
res: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "machine": {}, "B1": [], "B2": [], "B3": [], "B4": {}}


def sh(args, cwd, env=None, timeout=3600):
    t = time.time()
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env={**os.environ, **(env or {})})
    return r, time.time() - t


def gpu_idle_check():
    q = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,temperature.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout.strip()
    return [float(x) for x in q.split(",")]


def render(proj, script, tag, env=None):
    r, secs = sh(["node", f"scripts/{script}", "gpu", "--comp", "EP04-30fps", "--frames", "0-1799", "--fresh", "--out", f"out/bench/{tag}.mp4", "--skip-check"], proj, env)
    rep_p = proj / "out" / "reports" / "EP04-30fps-1080p-gpu.json"
    rep = json.loads(rep_p.read_text(encoding="utf-8")) if rep_p.exists() and r.returncode == 0 else {}
    if rep:
        shutil.copy2(rep_p, OUT / f"{tag}.report.json")
    s = rep.get("seconds", {})
    row = {"tag": tag, "ok": r.returncode == 0, "wall": round(secs, 1), "render": s.get("render"), "encode": s.get("encode"),
           "renderFps": round(1800 / s["render"], 2) if s.get("render") else None, "encoder": rep.get("encoder"),
           "vramPeakMiB": rep.get("render", {}).get("vramPeakMiB"), "gpuAvg": rep.get("render", {}).get("gpuAvg"),
           "err": None if r.returncode == 0 else r.stdout[-400:] + r.stderr[-400:]}
    print(json.dumps(row, ensure_ascii=False), flush=True)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=r"<PROJECT_DIR>-v03-e2e")
    ap.add_argument("--runs", type=int, default=2)
    a = ap.parse_args()
    proj = Path(a.project)
    OUT.mkdir(parents=True, exist_ok=True)
    (proj / "out" / "bench").mkdir(parents=True, exist_ok=True)
    # v0.2.1 scripts next to the v0.3 ones (same project, same frames, same browser)
    for name in ["render.mjs", "build_timeline.py", "generate_voiceover_cosy.py"]:
        old = subprocess.run(["git", "show", f"{OLD}:scripts/{name}"], cwd=ROOT, capture_output=True).stdout
        (proj / "scripts" / f"_v021_{name}").write_bytes(old)
    hw = json.loads(subprocess.run([str(EXE_NEW), "--cli", "hw-info", "--data", str(ROOT / "out" / "v03" / "hw-data")], capture_output=True, text=True, encoding="utf-8").stdout)["hardware"]
    res["machine"] = {"gpus": [{k: g[k] for k in ("name", "kind", "dedicatedVramMib", "displayOutputs", "driverVersion")} for g in hw["snapshot"]["gpus"]], "assignment": {k: hw["assignment"][k]["gpuName"] for k in ("ui", "render", "ai")}}
    res["idleBefore"] = gpu_idle_check()
    print("GPU 閒置檢查（使用率%, VRAM MiB, °C）:", res["idleBefore"], flush=True)

    # B1 render: alternate old / new
    nv_env = {"PIKARA_RENDER_GPU_LUID": hw["assignment"]["render"]["luid"] or ""}
    for i in range(a.runs):
        res["B1"].append({"ver": "v0.2.1", **render(proj, "_v021_render.mjs", f"b1-v021-{i}")})
        res["B1"].append({"ver": "v0.3.0", **render(proj, "render.mjs", f"b1-v030-{i}", nv_env)})

    # B3 render while the Studio UI is open and busy (tour), UI on iGPU (auto) vs UI on dGPU
    data = ROOT / "out" / "v03" / "bench-ui-data"
    data.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(EXE_NEW), "--cli", "episode-list", "--project", str(proj), "--data", str(data)], capture_output=True)
    for ui in ["auto", "discrete"]:
        subprocess.run([str(EXE_NEW), "--cli", "settings-set", "--json", json.dumps({"hw": {**hw["prefs"], "uiGpu": ui}, "queueEnabled": False}), "--data", str(data)], capture_output=True)
        env = {**os.environ, "PIKARA_STUDIO_DATA": str(data), "PIKARA_UI_TOUR": "1", "PIKARA_UI_TOUR_STEP_MS": "1200"}
        p = subprocess.Popen([str(EXE_NEW)], env=env)
        time.sleep(6)
        try:
            row = render(proj, "render.mjs", f"b3-ui-{ui}", nv_env)
            u = json.loads(subprocess.run([str(EXE_NEW), "--cli", "hw-usage", "--ui-root", str(p.pid), "--ms", "2000", "--data", str(data)], capture_output=True, text=True, encoding="utf-8").stdout)["usage"]
            row["uiGpuMeasured"] = (u.get("roles") or {}).get("ui")
        finally:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
            time.sleep(3)
        res["B3"].append({"ui": ui, **row})

    # B2 TTS: 6 lines of EP04, old vs new generator, separate output folders (--force)
    lines = ["ep04-s01-01", "ep04-s02-01", "ep04-s03-02", "ep04-s04-01", "ep04-s05-02", "ep04-s06-01"]
    for ver, script in [("v0.2.1", "_v021_generate_voiceover_cosy.py"), ("v0.3.0", "generate_voiceover_cosy.py")]:
        outroot = f"public/assets/audio/_bench/tts-{ver}"  # under public/: the v0.2.1 script requires it (old path bug)
        shutil.rmtree(proj / outroot, ignore_errors=True)
        r, secs = sh([str(COSY_PY), "-u", f"scripts/{script}", "--seq", "ep04", "--only", *lines, "--force", "--out-root", outroot], proj,
                     {"PYTHONUTF8": "1", "KMP_DUPLICATE_LIB_OK": "TRUE"}, timeout=2400)
        metas = [json.loads(p.read_text(encoding="utf-8")) for p in (proj / outroot / "ep04").glob("*.json")]
        audio = sum(m.get("duration", 0) for m in metas)
        synth = sum((m.get("perf") or {}).get("seconds", 0) for m in metas)
        row = {"ver": ver, "ok": r.returncode == 0, "wall": round(secs, 1), "lines": len(metas), "audioSec": round(audio, 1), "synthSec": round(synth, 1),
               "rtf": round(synth / audio, 3) if audio else None, "vramPeakMiB": max([(m.get("perf") or {}).get("vram_peak_mib") or 0 for m in metas] or [0])}
        print(json.dumps(row, ensure_ascii=False), flush=True)
        res["B2"].append(row)

    # B4a timeline (dry run) old vs new
    tl = {}
    for ver, script in [("v0.2.1", "_v021_build_timeline.py"), ("v0.3.0", "build_timeline.py")]:
        times = []
        for _ in range(3):
            if ver == "v0.2.1":  # the old script has no --out: run it on a copy of the timeline file and restore
                tp = proj / "src" / "data" / "timeline.generated.json"
                bak = tp.read_bytes()
                _, s = sh(["py", "-3.11", f"scripts/{script}", "--seq", "ep04"], proj, {"PYTHONUTF8": "1"})
                tp.write_bytes(bak)
            else:
                _, s = sh(["py", "-3.11", f"scripts/{script}", "--seq", "ep04", "--out", "out/bench/tl.json"], proj, {"PYTHONUTF8": "1"})
            times.append(s)
        tl[ver] = round(statistics.median(times), 2)
    res["B4"]["timelineSec"] = tl

    # B4b Studio idle CPU / RAM (30 s on the dashboard)
    def tree_stats(root_pid):
        # Windows CIM: the process and all descendants — CPU time (user+kernel, 100 ns units) and working set
        ps = ("$all = Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize; "
              f"$ids = @({root_pid}); do {{ $n = $ids.Count; $ids = @($ids + ($all | ? {{ $ids -contains $_.ParentProcessId }} | % ProcessId) | Select -Unique) }} while ($ids.Count -ne $n); "
              "$s = $all | ? { $ids -contains $_.ProcessId }; "
              "[pscustomobject]@{ cpu = ($s | Measure-Object -Property UserModeTime -Sum).Sum + ($s | Measure-Object -Property KernelModeTime -Sum).Sum; ws = ($s | Measure-Object -Property WorkingSetSize -Sum).Sum; n = @($s).Count } | ConvertTo-Json -Compress")
        o = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60).stdout
        return json.loads(o)

    idle = {}
    for ver, exe in [("v0.2.1", EXE_OLD), ("v0.3.0", EXE_NEW)]:
        d = ROOT / "out" / "v03" / f"bench-idle-{ver}"
        d.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(exe), "--cli", "episode-list", "--project", str(proj), "--data", str(d)], capture_output=True)
        p = subprocess.Popen([str(exe)], env={**os.environ, "PIKARA_STUDIO_DATA": str(d)})
        time.sleep(12)
        a0, t0 = tree_stats(p.pid), time.time()
        time.sleep(30)
        a1, t1 = tree_stats(p.pid), time.time()
        cores = os.cpu_count() or 1
        cpu = (a1["cpu"] - a0["cpu"]) / 1e7 / (t1 - t0) * 100 / cores  # % of the whole CPU
        idle[ver] = {"cpuPctOfMachine": round(cpu, 2), "workingSetMiB": round(a1["ws"] / 1048576), "processes": a1["n"]}
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        time.sleep(3)
    res["B4"]["studioIdle"] = idle
    res["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    (OUT / "bench.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"B4": res["B4"]}, ensure_ascii=False))


if __name__ == "__main__":
    with gpu_lease("Benchmark v0.3.0"):
        main()
