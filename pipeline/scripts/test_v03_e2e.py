# v0.3 驗收測試：打開一集 → 只改一句旁白 → 重新配音 → 重新渲染 → 得到更新的影片（不跑完整製片流程）。
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/test_v03_e2e.py [--project <PROJECT_DIR>-v03-e2e] [--episode ep04] [--skip-baseline]
# 只用獨立的專案複本與沙盒資料夾（out/v03/e2e-data），透過真正的 Debug EXE（--cli enqueue / run-queue）執行。
# GPU 工作一次一個；每一步有時間上限；開始前與每一步之間檢查 RAM／溫度／VRAM，超過就停止。
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EXE = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
DATA = ROOT / "out" / "v03" / "e2e-data"
LOG = ROOT / "out" / "v03" / "e2e"
results: list[dict] = []
T0 = time.time()


def check(name, ok, **info):
    results.append({"test": name, "pass": bool(ok), "t": round(time.time() - T0), **info})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(info, ensure_ascii=False)[:600], flush=True)
    return ok


def sha(p: Path) -> str | None:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.is_file() else None


def cli(*args, timeout=300, env=None):
    r = subprocess.run([str(EXE), "--cli", *args, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, **(env or {})})
    txt = r.stdout.strip()
    i = txt.rfind("\n{")
    body = txt[i + 1:] if i >= 0 else txt
    try:
        return json.loads(body), r.returncode
    except Exception:  # noqa: BLE001
        return {"raw": txt[-1500:], "err": r.stderr[-1500:]}, r.returncode


def guard(tag):
    """RAM < 85 %, GPU < 85 °C；不允許其他 Studio／渲染工作同時佔用 GPU。"""
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + [(f"x{i}", ctypes.c_ulonglong) for i in range(7)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    q = subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20).stdout
    temp, used, total = [float(x) for x in q.strip().split(",")]
    ok = m.dwMemoryLoad < 85 and temp < 85
    print(f"[資源 {tag}] RAM {m.dwMemoryLoad}%｜GPU {temp:.0f}°C｜VRAM {used:.0f}/{total:.0f} MiB", flush=True)
    if not ok:
        raise SystemExit(f"資源超過安全上限（{tag}），停止測試")
    return {"ramPct": m.dwMemoryLoad, "tempC": temp, "vramMiB": used}


def run_job(project, kind, params, timeout, env=None):
    j, _ = cli("enqueue", "--project", str(project), "--kind", kind, "--params", json.dumps(params, ensure_ascii=False))
    jid = j["job"]["id"]
    t = time.time()
    subprocess.run([str(EXE), "--cli", "run-queue", "--data", str(DATA), "--timeout", str(timeout)], capture_output=True, timeout=timeout + 120,
                   env={**os.environ, **(env or {})})
    jobs, _ = cli("jobs", "--limit", "50")
    job = next(x for x in (jobs if isinstance(jobs, list) else jobs.get("jobs", [])) if x["id"] == jid)
    logp = DATA / "logs" / f"{jid}.log"
    (LOG / f"{kind}-{jid[:8]}.log").write_text(logp.read_text(encoding="utf-8", errors="replace") if logp.exists() else "", encoding="utf-8")
    return job, round(time.time() - t, 1)


def workspace(project, ep):
    w, _ = cli("workspace", "--root", str(project), "--episode", ep, "--locale", "zh-TW")
    return {s["id"]: s for s in w["workspace"]["stages"]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=r"<PROJECT_DIR>-v03-e2e")
    ap.add_argument("--episode", default="ep04")
    ap.add_argument("--skip-baseline", action="store_true")
    a = ap.parse_args()
    proj, ep = Path(a.project), a.episode
    LOG.mkdir(parents=True, exist_ok=True)
    if not a.skip_baseline:
        shutil.rmtree(DATA, ignore_errors=True)
    DATA.mkdir(parents=True, exist_ok=True)
    nar = json.loads((proj / "src" / "data" / "narration.json").read_text(encoding="utf-8"))
    scenes = nar["sequences"][ep]["scenes"]
    vdir = proj / "public" / "assets" / "audio" / "voiceover_cosy" / ep
    out = proj / "projects" / ep.upper() / "output" / f"{ep.upper()}_Final.mp4"

    # 0) 基準：完整渲染一次（模擬「已完成的一集」）
    if not a.skip_baseline or not out.exists():
        guard("baseline")
        job, secs = run_job(proj, "rerender", {"episode": ep, "locale": "zh-TW", "mode": "full", "qa": False}, 5400)
        check("0_baseline_render", job["status"] == "succeeded" and out.exists(), status=job["status"], error=job.get("error"), seconds=secs)
    base_sha = sha(out)
    ws = workspace(proj, ep)
    check("1_open_episode_workspace", all(k in ws for k in ["research", "script", "storyboard", "voice", "timeline", "animation", "mix", "video", "qa"]) and ws["video"]["status"] == "fresh",
          stages={k: v["status"] for k, v in ws.items()})

    # 1) 只改一句：第 2 幕第 2 句加長
    target_scene = scenes[1]
    line = target_scene["lines"][min(1, len(target_scene["lines"]) - 1)]
    lid = line["id"]
    before = {p.name: sha(p) for p in vdir.glob("*.mp3")}
    new_text = line["subtitle"].rstrip("。！？") + "，這一句是重新配音測試。"
    r, _ = cli("line-set", "--root", str(proj), "--episode", ep, "--line", lid, "--subtitle", new_text, *(["--speak", ""] if line.get("speak") else []))
    ws = workspace(proj, ep)
    vl = {x["id"]: x["state"] for x in ws["voice"]["lines"]}
    others_ok = all(s == "ok" for k, s in vl.items() if k != lid)
    check("2_edit_one_line_marks_only_it_and_downstream", r.get("ok") and vl[lid] == "stale" and others_ok and ws["timeline"]["status"] == "stale"
          and ws["mix"]["status"] == "stale" and ws["video"]["status"] == "stale", line=lid, text=new_text,
          stages={k: v["status"] for k, v in ws.items()})

    # 2) 重新配音（只這一句）
    guard("revoice")
    job, secs = run_job(proj, "revoice", {"episode": ep, "locale": "zh-TW", "lines": lid}, 1800)
    after = {p.name: sha(p) for p in vdir.glob("*.mp3")}
    changed = [k for k in after if after[k] != before.get(k)]
    vers, _ = cli("voice-versions", "--root", str(proj), "--episode", ep, "--line", lid)
    old_kept = any(v.get("sha256") == before.get(f"{lid}.mp3") and Path(v["path"]).exists() for v in vers.get("versions", []))
    ws = workspace(proj, ep)
    check("3_revoice_single_line", job["status"] == "succeeded" and changed == [f"{lid}.mp3"] and old_kept
          and {x["id"]: x["state"] for x in ws["voice"]["lines"]}[lid] == "ok", status=job["status"], error=job.get("error"), seconds=secs,
          changedFiles=changed, oldVersionKept=old_kept)

    # 3) 計畫：哪些會重跑、哪些沿用
    plan, _ = cli("rerender-plan", "--root", str(proj), "--episode", ep, "--params", json.dumps({"mode": "affected"}), timeout=600)
    p = plan.get("plan", {})
    reused_scenes = [s["id"] for s in p.get("frames", {}).get("scenes", []) if s.get("reuse")]
    check("4_rerender_plan_shows_reuse", p.get("frames", {}).get("cachedFrames", 0) > 0 and len(reused_scenes) >= 1 and not p.get("blockers"),
          cached=p.get("frames", {}).get("cachedFrames"), total=p.get("frames", {}).get("totalFrames"), reusedScenes=reused_scenes,
          run=[x["stage"] for x in p.get("run", [])], estimateSec=p.get("estimate", {}).get("seconds"))
    plan_r, _ = cli("rerender-plan", "--root", str(proj), "--episode", ep, "--params", json.dumps({"mode": "remux"}), timeout=600)
    check("4b_remux_blocked_when_timeline_changes", bool(plan_r.get("plan", {}).get("blockers")), blockers=plan_r.get("plan", {}).get("blockers"))

    # 4) 重新渲染受影響片段
    guard("rerender")
    job, secs = run_job(proj, "rerender", {"episode": ep, "locale": "zh-TW", "mode": "affected"}, 5400)
    rep = json.loads((proj / "out" / "reports" / f"{ep.upper()}-30fps-1080p-gpu.json").read_text(encoding="utf-8"))
    reuse = rep.get("reuse", {})
    vers_v = workspace(proj, ep)["video"].get("versions", [])
    old_video_kept = any(v.get("sha256") == base_sha and Path(v["path"]).exists() for v in vers_v)
    check("5_rerender_affected_reuses_frames", job["status"] == "succeeded" and reuse.get("reusedFrames", 0) > 0 and sha(out) != base_sha and old_video_kept,
          status=job["status"], error=job.get("error"), seconds=secs, reusedFrames=reuse.get("reusedFrames"), frames=rep.get("frames"),
          renderSeconds=rep.get("seconds", {}).get("render"), oldVideoKept=old_video_kept)

    # 5) 成品裡真的是新的那一句（與新的音檔對得上），其他句子也還在正確位置
    sc = subprocess.run([sys.executable, str(HERE / "voice_speed_check.py"), "--seq", ep, "--root", str(proj), "--mp4", str(out), "--lines", "0",
                         "--json", str(LOG / "final_vs_voice.json")], capture_output=True, text=True, encoding="utf-8", timeout=1800)
    rows = json.loads((LOG / "final_vs_voice.json").read_text(encoding="utf-8"))["lines"] if (LOG / "final_vs_voice.json").exists() else []
    mine = next((x for x in rows if x["id"] == lid), {})
    bad = [x["id"] for x in rows if x["corr"] < 0.3 or abs(x["stretchError"]) > 0.02]
    check("6_final_video_has_new_line_in_sync", mine.get("corr", 0) >= 0.3 and abs(mine.get("stretchError", 1)) <= 0.02 and not bad,
          line=mine, misaligned=bad, lines=len(rows))
    ws = workspace(proj, ep)
    check("7_all_stages_fresh_after_update", all(ws[k]["status"] in ("fresh", "done") for k in ["voice", "timeline", "mix", "video"]),
          stages={k: v["status"] for k, v in ws.items()})

    (LOG / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{sum(r['pass'] for r in results)}/{len(results)} passed in {round(time.time() - T0)} s")
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gpu_lock import gpu_lease  # 全機 GPU 租約：不與其他 GPU 測試、渲染、截圖同時執行
    with gpu_lease(Path(__file__).name):
        sys.exit(main())
