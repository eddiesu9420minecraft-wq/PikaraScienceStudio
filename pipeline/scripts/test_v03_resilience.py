# v0.3 穩定性測試（真實 Debug EXE ＋ 專案複本，GPU 工作一次一個，每步有時間上限）：
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/test_v03_resilience.py [--project <PROJECT_DIR>-v03-e2e]
#  R1 重新渲染中途取消：狀態 canceled、成品不變、沒有殘留的 node/ffmpeg/chrome 程序
#  R2 重新渲染時 Studio 當機（強制結束整個程序樹）：recover 後自動排回，續跑時沿用已完成的畫面，成品更新、舊版保留
#  R3 重新配音時配音程序崩潰（故障注入）：工作失敗、目前的音檔完全不變、沒有殘留程序
#  R4 整集重新配音（ep02 全部句子）：每句都有新版本、舊版本都保留、時間軸／影片標記為需要更新
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EXE = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
DATA = ROOT / "out" / "v03" / "e2e-data"
LOG = ROOT / "out" / "v03" / "resilience"
results = []


def check(name, ok, **info):
    results.append({"test": name, "pass": bool(ok), **info})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(info, ensure_ascii=False)[:700], flush=True)


def sha(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.is_file() else None


def cli(*args, timeout=300, env=None):
    r = subprocess.run([str(EXE), "--cli", *args, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, **(env or {})})
    txt = r.stdout.strip()
    i = txt.rfind("\n{")
    try:
        return json.loads(txt[i + 1:] if i >= 0 else txt)
    except Exception:  # noqa: BLE001
        return {"raw": txt[-800:], "err": r.stderr[-800:]}


def job(jid):
    js = cli("jobs", "--limit", "100")
    return next(x for x in (js if isinstance(js, list) else js.get("jobs", [])) if x["id"] == jid)


def enqueue(project, kind, params):
    return cli("enqueue", "--project", str(project), "--kind", kind, "--params", json.dumps(params, ensure_ascii=False))["job"]["id"]


def run_queue(env=None):
    return subprocess.Popen([str(EXE), "--cli", "run-queue", "--data", str(DATA), "--timeout", "3600"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={**os.environ, **(env or {})}, creationflags=0x00000200)


def leftovers(project):
    ps = ("Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','ffmpeg.exe','python.exe','chrome-headless-shell.exe','chrome.exe') "
          f"-and $_.CommandLine -like '*{project.name}*' }} | ForEach-Object {{ \"$($_.ProcessId) $($_.Name)\" }}")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60)
    return [l for l in r.stdout.splitlines() if l.strip()]


def chunk_done(jid):
    import re
    p = DATA / "logs" / f"{jid}.log"
    return p.exists() and re.search(r"區段 \d+–\d+：\d+s", p.read_text(encoding="utf-8", errors="replace")) is not None


def wait(cond, secs, step=2.0):
    t0 = time.time()
    while time.time() - t0 < secs:
        v = cond()
        if v:
            return v
        time.sleep(step)
    return None


def log_has(jid, text):
    p = DATA / "logs" / f"{jid}.log"
    return p.exists() and text in p.read_text(encoding="utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=r"<PROJECT_DIR>-v03-e2e")
    a = ap.parse_args()
    proj = Path(a.project)
    LOG.mkdir(parents=True, exist_ok=True)
    out = proj / "projects" / "EP04" / "output" / "EP04_Final.mp4"

    # R1 cancel mid-render
    before = sha(out)
    jid = enqueue(proj, "rerender", {"episode": "ep04", "locale": "zh-TW", "mode": "full", "qa": False})
    rq = run_queue()
    started = wait(lambda: log_has(jid, "區段 ") or log_has(jid, "渲染 EP04"), 600)
    time.sleep(25)
    t0 = time.time()
    c = cli("job-cancel", "--id", jid)
    gone = wait(lambda: not leftovers(proj), 60) is not None
    rq.wait(timeout=180)
    st = job(jid)
    check("R1_cancel_mid_render", bool(started) and st["status"] == "canceled" and gone and sha(out) == before,
          status=st["status"], cancelToCleanSec=round(time.time() - t0, 1), leftovers=leftovers(proj), outputUnchanged=sha(out) == before)

    # R2 crash (kill the whole Studio process tree mid-render) → recover → resume with cached frames
    vers_before = len([s for s in cli("workspace", "--root", str(proj), "--episode", "ep04")["workspace"]["stages"] if s["id"] == "video"][0].get("versions", []))
    jid = enqueue(proj, "rerender", {"episode": "ep04", "locale": "zh-TW", "mode": "affected", "qa": False})
    rq = run_queue()
    # crash only after at least one 900-frame chunk has been committed (render.mjs saves frames per finished chunk)
    started = wait(lambda: chunk_done(jid), 1800)
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(rq.pid)], capture_output=True)
    rq.wait(timeout=60)
    killed_ok = wait(lambda: not leftovers(proj), 60) is not None
    mid = job(jid)
    time.sleep(25)  # heartbeat goes stale (STALE_MS = 20 s)
    rec = cli("recover")
    after_rec = job(jid)
    rq = run_queue()
    fin = wait(lambda: job(jid)["status"] in ("succeeded", "failed", "canceled"), 3000, 5)
    rq.wait(timeout=300)
    st = job(jid)
    rep = json.loads((proj / "out" / "reports" / "EP04-30fps-1080p-gpu.json").read_text(encoding="utf-8"))
    vers_after = len([s for s in cli("workspace", "--root", str(proj), "--episode", "ep04")["workspace"]["stages"] if s["id"] == "video"][0].get("versions", []))
    check("R2_crash_recover_resume", bool(started) and mid["status"] == "running" and jid in rec.get("recovered", []) and after_rec["status"] == "queued"
          and st["status"] == "succeeded" and rep.get("reuse", {}).get("reusedFrames", 0) > 0 and vers_after > vers_before and killed_ok,
          statusAtCrash=mid["status"], recovered=rec.get("recovered"), statusAfterRecover=after_rec["status"], final=st["status"], error=st.get("error"),
          reusedFramesOnResume=rep.get("reuse", {}).get("reusedFrames"), frames=rep.get("frames"), videoVersions=[vers_before, vers_after])

    # R3 voice process crash during re-voice → nothing switched, current audio untouched
    vdir = proj / "public" / "assets" / "audio" / "voiceover_cosy" / "ep02"
    snap = {p.name: sha(p) for p in vdir.glob("*.*")}
    lines = sorted(p.stem for p in vdir.glob("*.mp3"))
    jid = enqueue(proj, "revoice", {"episode": "ep02", "locale": "zh-TW", "lines": lines[0]})
    rq = run_queue({"PIKARA_TTS_FAULT": f"crash:{lines[0]}"})
    wait(lambda: job(jid)["status"] in ("succeeded", "failed", "canceled"), 1200, 5)
    rq.wait(timeout=300)
    st = job(jid)
    now = {p.name: sha(p) for p in vdir.glob("*.*")}
    check("R3_voice_crash_keeps_current_audio", st["status"] == "failed" and now == snap and not leftovers(proj),
          status=st["status"], error=(st.get("error") or "")[:200], filesUnchanged=now == snap)

    # R4 whole-episode re-voice (all lines of ep02 zh-TW)
    jid = enqueue(proj, "revoice", {"episode": "ep02", "locale": "zh-TW", "lines": ""})
    rq = run_queue()
    wait(lambda: job(jid)["status"] in ("succeeded", "failed", "canceled"), 1800, 5)
    rq.wait(timeout=300)
    st = job(jid)
    vv = cli("voice-versions", "--root", str(proj), "--episode", "ep02").get("versions", [])
    after = {p.name: sha(p) for p in vdir.glob("*.mp3")}
    changed = [k for k in after if after[k] != snap.get(k)]
    old_kept = all(any(v["item"] == Path(k).stem and v.get("sha256") == snap[k] for v in vv) for k in changed)
    ws = cli("workspace", "--root", str(proj), "--episode", "ep02")["workspace"]
    stg = {s["id"]: s["status"] for s in ws["stages"]}
    check("R4_whole_episode_revoice", st["status"] in ("succeeded", "failed") and len(changed) >= 1 and old_kept and stg["timeline"] in ("stale", "missing"),
          status=st["status"], error=(st.get("error") or "")[:300], lines=len(lines), switched=len(changed), oldVersionsKept=old_kept,
          candidatesForReview=len([v for v in vv if v["status"] == "candidate"]), stages=stg)

    (LOG / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{sum(r['pass'] for r in results)}/{len(results)} passed")
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gpu_lock import gpu_lease  # 全機 GPU 租約：不與其他 GPU 測試、渲染、截圖同時執行
    with gpu_lease(Path(__file__).name):
        sys.exit(main())
