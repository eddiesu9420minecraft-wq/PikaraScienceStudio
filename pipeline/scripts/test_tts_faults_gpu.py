# 真實 CosyVoice（GPU）故障恢復測試：用 PIKARA_TTS_FAULT 在真正的配音程序裡注入故障，檢查恢復行為。
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/test_tts_faults_gpu.py [--cases a,b] [--soak-minutes N]
# 安全限制（通宵無人看管）：一次只跑 1 個配音程序；每個情境有時間上限；每次開始前檢查 RAM < 85%、GPU < 85°C、
# VRAM 剩 ≥ 2500 MiB，且使用者的 Studio（<PROJECT_DIR>）沒有在配音／算圖——不符合就等（最多 10 分鐘），仍不行就停止。
# 輸出：out/overnight/faults/RESULTS.md、results.json、各情境 log。
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / "tools" / "CosyVoice" / ".venv" / "Scripts" / "python.exe"
OUT = ROOT / "out" / "overnight" / "faults"
AUD = ROOT / "public" / "assets" / "audio" / "_overnight"  # 腳本要求輸出在 public 下；結束時移到 out/overnight
REF = ROOT / "tools" / "CosyVoice" / "reference"
USER_PROJECT = r"<PROJECT_DIR>\.studio\worktrees"

LINES = [
    "為什麼 GPU 不能取代 CPU？",
    "CUDA 是 NVIDIA 推出的平行運算平台。",
    "Python 程式可以在 Linux 和 Windows 上執行。",
    "配音系統每完成一句，就會立刻把音檔存起來。",
]
LONG = LINES + [
    "如果程序在中途停止，重新執行時只會補上還沒完成的句子，不會重新產生已經完成的部分。",
    "這一句比較長，用來確認長句子的合成時間仍在每句上限之內，而且心跳會持續回報進度。",
    "最後，我們檢查記憶體、顯示記憶體與溫度，確認長時間執行時沒有持續增加。",
    "這裡是 Pikara Science，我們下次見。",
]


def narration(seq: str, texts: list[str]) -> Path:
    p = OUT / f"nar_{seq}.json"
    p.write_text(json.dumps({"fps": 60, "sequences": {seq: {"title": seq, "scenes": [{"id": "s01", "title": seq, "lines": [
        {"id": f"{seq}-s01-{i + 1:02d}", "subtitle": t} for i, t in enumerate(texts)]}]}}}, ensure_ascii=False, indent=1), encoding="utf-8")
    return p


def smi(fields: str) -> list[str]:
    try:
        r = subprocess.run(["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return [x.strip() for x in r.stdout.strip().split(",")]
    except Exception:  # noqa: BLE001
        return []


def num(s) -> float:
    try:
        return float(str(s).strip())
    except ValueError:
        return 0.0


def ram() -> tuple[int, int]:
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("a", ctypes.c_ulonglong), ("b", ctypes.c_ulonglong),
                    ("c", ctypes.c_ulonglong), ("d", ctypes.c_ulonglong), ("e", ctypes.c_ulonglong)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return int(m.dwMemoryLoad), int((m.ullTotalPhys - m.ullAvailPhys) // 2**20)


def procs() -> list[tuple[int, int, str, str]]:
    ps = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)\" }"
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    out = []
    for l in r.stdout.splitlines():
        a = l.split("|", 3)
        if len(a) == 4 and a[0].isdigit():
            out.append((int(a[0]), int(a[1] or 0), a[2], a[3]))
    return out


def user_gpu_job(ps) -> str | None:
    for pid, _, name, cmd in ps:
        if USER_PROJECT.lower() in cmd.lower() and ("generate_voiceover" in cmd or "render.mjs" in cmd):
            return f"PID {pid} {cmd[:120]}"
    return None


def guard(log) -> str | None:
    """None = 可以開始；否則回傳不能開始的原因（等最多 10 分鐘）。"""
    t0 = time.time()
    while True:
        load, _ = ram()
        g = smi("temperature.gpu,memory.used,memory.total")
        temp = num(g[0]) if g else 0
        free = num(g[2]) - num(g[1]) if len(g) == 3 else 9999
        uj = user_gpu_job(procs())
        why = (f"RAM 使用率 {load}% ≥ 85%" if load >= 85 else f"GPU {temp}°C ≥ 85°C" if temp >= 85 else
               f"VRAM 只剩 {free} MiB" if free < 2500 else f"使用者的 Studio 正在用 GPU：{uj}" if uj else None)
        if not why:
            return None
        if time.time() - t0 > 600:
            return why
        log(f"  … 暫停：{why}，60 秒後再檢查")
        time.sleep(60)


class Sampler:
    def __init__(self):
        self.rows, self._stop = [], threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            g = smi("utilization.gpu,memory.used,temperature.gpu")
            load, used = ram()
            if len(g) == 3:
                self.rows.append({"t": time.time(), "gpu": num(g[0]), "vram": num(g[1]), "temp": num(g[2]), "ramPct": load, "ramMiB": used})
            self._stop.wait(2)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()

    def summary(self):
        if not self.rows:
            return {}
        k = lambda f: max(r[f] for r in self.rows)  # noqa: E731
        return {"peakVramMiB": k("vram"), "peakTempC": k("temp"), "peakRamPct": k("ramPct"), "peakRamMiB": k("ramMiB"),
                "avgGpu": round(sum(r["gpu"] for r in self.rows) / len(self.rows), 1)}


def run_gen(name, seq, nar, extra, env, timeout, log):
    lg = OUT / f"{name}.log"
    e = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "KMP_DUPLICATE_LIB_OK": "TRUE", "PIKARA_TTS_HEARTBEAT_SEC": "15", **env}
    cmd = [str(PY), "-u", "scripts/generate_voiceover_cosy.py", "--seq", seq, "--narration", str(nar), "--out-root", str(AUD),
           "--ref", str(REF / "reference.wav"), "--ref-text-file", str(REF / "reference.txt"), "--retry-bad", "0", *extra]
    t0 = time.time()
    with Sampler() as smp, open(lg, "w", encoding="utf-8") as f:
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, env=e)
        try:
            rc = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
            rc = "timeout"
    wall = round(time.time() - t0, 1)
    time.sleep(2)
    left = [(pid, n, c[:100]) for pid, par, n, c in procs() if ("generate_voiceover_cosy.py" in c and str(AUD) in c) or ("nvidia-smi" in n.lower() and "-l" in c.split())]
    text = lg.read_text(encoding="utf-8", errors="replace")
    log(f"  {name}: rc={rc} wall={wall}s 殘留程序={len(left)}")
    return {"rc": rc, "wall": wall, "left": left, "log": text, **smp.summary()}


def files(seq):
    d = AUD / seq
    return {p.stem: p.stat().st_mtime for p in sorted(d.glob("*.mp3"))} if d.exists() else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="")
    ap.add_argument("--soak-minutes", type=float, default=0)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    report, results = [], {}
    log = lambda s: (print(s, flush=True), report.append(s))  # noqa: E731
    nar = narration("ovn", LINES)
    nl = narration("ovl", LONG)
    ids = [f"ovn-s01-{i + 1:02d}" for i in range(len(LINES))]
    want = set(filter(None, a.cases.split(",")))

    def case(name, fn):
        if want and name not in want:
            return
        why = guard(log)
        if why:
            log(f"STOP {name}：{why}（安全限制，未執行其餘情境）")
            raise SystemExit(3)
        log(f"▶ {name}")
        try:
            results[name] = fn()
        except AssertionError as e:
            results[name] = {"pass": False, "why": str(e)}
        log(f"  → {'PASS' if results[name].get('pass') else 'FAIL'} {results[name].get('why', '')}")

    def fresh():
        shutil.rmtree(AUD / "ovn", ignore_errors=True)

    def c_normal():
        fresh()
        r = run_gen("01_normal", "ovn", nar, [], {}, 900, log)
        ok = r["rc"] == 0 and len(files("ovn")) == 4 and not r["left"]
        return {**r, "pass": ok, "why": "" if ok else f"rc={r['rc']} files={len(files('ovn'))}"}

    def c_cache():
        before = files("ovn")
        r = run_gen("02_cache_hit", "ovn", nar, [], {}, 300, log)
        ok = r["rc"] == 0 and "需要產生 0 句" in r["log"] and files("ovn") == before
        return {**r, "pass": ok, "why": "" if ok else "已完成的句子被重新產生或 rc≠0"}

    def c_oom_once():
        r = run_gen("03_oom_retry", "ovn", nar, ["--only", ids[1], "--force"], {"PIKARA_TTS_FAULT": f"oom:{ids[1]}:1"}, 600, log)
        ok = r["rc"] == 0 and "CUDA OOM" in r["log"] and f"✓ " in r["log"]
        return {**r, "pass": ok, "why": "" if ok else "OOM 一次後未重試成功"}

    def c_oom_fail():
        old = files("ovn")[ids[1]]
        r = run_gen("04_oom_persistent", "ovn", nar, ["--only", ids[1], "--force"], {"PIKARA_TTS_FAULT": f"oom:{ids[1]}:2"}, 600, log)
        kept = ids[1] in files("ovn") and files("ovn")[ids[1]] == old
        ok = r["rc"] == 1 and "CUDA 記憶體不足" in r["log"] and "保留上一次的音檔" in r["log"] and kept and "改用 CPU" not in r["log"]
        return {**r, "pass": ok, "why": "" if ok else "持續 OOM 時應寫明原因、不默默改 CPU、保留舊音檔"}

    def c_ffmpeg():
        old = files("ovn")[ids[2]]
        r = run_gen("05_ffmpeg_fail", "ovn", nar, ["--only", ids[2], "--force"], {"PIKARA_TTS_FAULT": f"ffmpeg:{ids[2]}"}, 600, log)
        ok = r["rc"] == 1 and "ffmpeg 失敗" in r["log"] and files("ovn").get(ids[2]) == old
        return {**r, "pass": ok, "why": "" if ok else "ffmpeg 失敗時應保留舊音檔"}

    def c_crash_resume():
        fresh()
        r1 = run_gen("06a_crash", "ovn", nar, [], {"PIKARA_TTS_FAULT": f"crash:{ids[2]}"}, 900, log)
        done1 = files("ovn")
        r2 = run_gen("06b_resume_after_crash", "ovn", nar, [], {}, 900, log)
        done2 = files("ovn")
        kept = all(done2.get(k) == v for k, v in done1.items())
        ok = r1["rc"] == 9 and set(done1) == set(ids[:2]) and r2["rc"] == 0 and len(done2) == 4 and kept and "需要產生 2 句" in r2["log"]
        return {"crash": {k: r1[k] for k in ("rc", "wall", "left")}, "resume": {k: r2[k] for k in ("rc", "wall", "left")}, "pass": ok,
                "why": "" if ok else f"crash rc={r1['rc']} 完成={sorted(done1)} 續跑 rc={r2['rc']} 完成={len(done2)} 舊檔不變={kept}"}

    def c_hang():
        r = run_gen("07_hang_watchdog", "ovn", nar, ["--only", ids[3], "--force"], {"PIKARA_TTS_FAULT": f"hang:{ids[3]}", "PIKARA_TTS_LINE_TIMEOUT": "30"}, 600, log)
        ok = r["rc"] == 4 and "[停滯]" in r["log"] and "inject_fault" in r["log"] and not r["left"] and ids[3] in files("ovn")
        return {**r, "pass": ok, "why": "" if ok else f"rc={r['rc']}（期望 4，有堆疊、無殘留、保留舊音檔）"}

    def c_long():
        shutil.rmtree(AUD / "ovl", ignore_errors=True)
        r = run_gen("08_long_multi", "ovl", nl, [], {}, 1500, log)
        per = [l for l in r["log"].splitlines() if "  ✓ " in l]
        ok = r["rc"] == 0 and len(files("ovl")) == len(LONG) and "♥" in r["log"]
        return {**r, "perLine": per, "pass": ok, "why": "" if ok else f"rc={r['rc']} files={len(files('ovl'))}"}

    def c_resident():
        """同一個程序、模型常駐連續合成 40 句：心跳裡的 RAM 與每句 VRAM 峰值不應持續上升（記憶體洩漏檢查）。"""
        nx = narration("ovx", LONG * 5)
        shutil.rmtree(AUD / "ovx", ignore_errors=True)
        r = run_gen("10_resident_40", "ovx", nx, [], {}, 3000, log)
        import re
        vr = [int(m) for m in re.findall(r"peakVRAM\(本程序\)=(\d+)MiB", r["log"])]
        rm = [int(m) for m in re.findall(r"♥ 合成 \S+ .*?RAM (\d+) MiB", r["log"])]
        steady = vr[2:]  # 前兩句含校準／暖機
        grow_v = (max(steady[-8:]) - max(steady[:8])) if len(steady) >= 16 else None
        grow_r = (rm[-1] - rm[0]) if len(rm) >= 2 else None
        ok = r["rc"] == 0 and len(files("ovx")) == 40 and grow_v is not None and grow_v <= 256 and (grow_r is None or grow_r <= 512)
        return {**r, "lineVram": vr, "heartbeatRam": rm, "vramGrowthMiB": grow_v, "ramGrowthMiB": grow_r, "pass": ok,
                "why": "" if ok else f"rc={r['rc']} files={len(files('ovx'))} VRAM 成長={grow_v} RAM 成長={grow_r}"}

    for n, f in (("10_resident_40", c_resident), ("01_normal", c_normal), ("02_cache_hit", c_cache), ("03_oom_retry", c_oom_once), ("04_oom_persistent", c_oom_fail),
                 ("05_ffmpeg_fail", c_ffmpeg), ("06_crash_resume", c_crash_resume), ("07_hang_watchdog", c_hang), ("08_long_multi", c_long)):
        case(n, f)

    if a.soak_minutes > 0:
        t_end, k, soak = time.time() + a.soak_minutes * 60, 0, []
        log(f"▶ soak {a.soak_minutes} 分鐘（每輪 --force 重做 8 句長文本）")
        while time.time() < t_end:
            why = guard(log)
            if why:
                log(f"STOP soak：{why}")
                break
            k += 1
            r = run_gen(f"09_soak_{k:02d}", "ovl", nl, ["--force"], {}, 1500, log)
            soak.append({x: r.get(x) for x in ("rc", "wall", "left", "peakVramMiB", "peakTempC", "peakRamPct", "peakRamMiB", "avgGpu")})
            if r["rc"] != 0:
                fails = sum(1 for s in soak if s["rc"] != 0)
                if fails >= 3:
                    log("STOP soak：同一情境失敗 3 次")
                    break
        results["09_soak"] = {"rounds": soak, "pass": bool(soak) and all(s["rc"] == 0 and not s["left"] for s in soak)}

    (OUT / "results.json").write_text(json.dumps({k: {x: y for x, y in v.items() if x != "log"} for k, v in results.items()}, ensure_ascii=False, indent=1), encoding="utf-8")
    dst = ROOT / "out" / "overnight" / "audio"
    if AUD.exists():
        shutil.rmtree(dst, ignore_errors=True)
        shutil.move(str(AUD), str(dst))
    passed = sum(1 for v in results.values() if v.get("pass"))
    log(f"\n{passed}/{len(results)} 情境通過")
    (OUT / "RESULTS.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gpu_lock import gpu_lease  # 全機 GPU 租約：不與其他 GPU 測試、渲染、截圖同時執行
    with gpu_lease(Path(__file__).name):
        sys.exit(main())
