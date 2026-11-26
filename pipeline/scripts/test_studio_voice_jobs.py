# Studio 佇列＋真實 CosyVoice 配音工作的端到端故障測試（只用沙盒資料夾 out/accept/studio-data 與開發工作樹）。
#   py -3.11 scripts/test_studio_voice_jobs.py
# 情境：S1 中途取消（程序樹結束、已完成句子保留）、S2 取消後重新排入（只補未完成的句子）、
#       S3 程序完全凍結（關掉心跳與每句上限，靠 Studio 的無輸出上限結束並標示「停滯」）。
# 會暫時在 src/data/narration.json 加入 ep90 測試集，結束時還原（備份在 out/overnight/narration.backup.json）。
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
DATA = ROOT / "out" / "accept" / "studio-data"
NAR = ROOT / "src" / "data" / "narration.json"
BAK = ROOT / "out" / "overnight" / "narration.backup.json"
OUTD = ROOT / "public" / "assets" / "audio" / "voiceover_cosy" / "ep90"
LOG = ROOT / "out" / "overnight" / "studio_jobs"
SEQ = "ep90"
TEXTS = ["配音工作開始，第一句先完成。", "第二句也順利產生並立刻存檔。", "第三句在測試中會被取消或凍結。",
         "第四句用來確認恢復後只補沒完成的句子。", "第五句是最後一句，Pikara Science 下次見。"]
IDS = [f"{SEQ}-s01-{i + 1:02d}" for i in range(len(TEXTS))]
results = {}


def cli(*args, env=None, timeout=120):
    r = subprocess.run([str(EXE), "--cli", *args, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, **(env or {})})
    try:
        return json.loads(r.stdout)
    except Exception:  # noqa: BLE001
        return {"raw": r.stdout[-800:], "err": r.stderr[-800:]}


def job(jid):
    c = sqlite3.connect(DATA / "studio.db")
    r = c.execute("select status, error from jobs where id=?", (jid,)).fetchone()
    c.close()
    return r


def joblog(jid):
    p = DATA / "logs" / f"{jid}.log"
    return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""


def leftovers():
    # 只看 python.exe（查詢本身的 powershell 命令列也含這段文字，第一版因此永遠找得到「殘留」）
    ps = "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'generate_voiceover_cosy.py --seq ep90' } | ForEach-Object { $_.ProcessId }"
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60)
    return [int(x) for x in r.stdout.split() if x.isdigit()]


def done_files():
    return {p.stem: p.stat().st_mtime for p in OUTD.glob("*.mp3")} if OUTD.exists() else {}


def enqueue(params):
    j = cli("enqueue", "--project", str(ROOT), "--kind", "voiceover_tw", "--params", json.dumps(params))
    return j["job"]["id"]


def run_queue(env=None):
    return subprocess.Popen([str(EXE), "--cli", "run-queue", "--data", str(DATA), "--timeout", "1500"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env={**os.environ, **(env or {})})


def wait(cond, secs):
    t0 = time.time()
    while time.time() - t0 < secs:
        if cond():
            return True
        time.sleep(2)
    return False


def main():
    LOG.mkdir(parents=True, exist_ok=True)
    shutil.copy2(NAR, BAK)
    try:
        d = json.loads(NAR.read_text(encoding="utf-8"))
        d["sequences"][SEQ] = {"title": "overnight test", "scenes": [{"id": "s01", "title": "t", "lines": [{"id": i, "subtitle": t} for i, t in zip(IDS, TEXTS)]}]}
        NAR.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        shutil.rmtree(OUTD, ignore_errors=True)

        # S1 中途取消
        jid = enqueue({"seq": SEQ, "force": True})
        rq = run_queue()
        got2 = wait(lambda: joblog(jid).count("  ✓ ") >= 2, 600)
        before = done_files()
        t0 = time.time()
        c = cli("job-cancel", "--id", jid)
        gone = wait(lambda: not leftovers(), 30)
        st = job(jid)
        rq.wait(timeout=120)
        (LOG / "S1_cancel.log").write_text(joblog(jid), encoding="utf-8")
        ok = got2 and c.get("status") == "canceled" and st[0] == "canceled" and gone and len(before) >= 2 and all(OUTD.joinpath(f"{k}.mp3").exists() for k in before)
        results["S1_cancel"] = {"pass": ok, "linesDoneBeforeCancel": len(before), "cancelToNoProcSec": round(time.time() - t0, 1), "status": st[0]}

        # S2 重新排入：只補沒完成的句子，已完成的不重做
        jid2 = enqueue({"seq": SEQ})
        rq = run_queue()
        fin = wait(lambda: job(jid2)[0] in ("succeeded", "failed"), 900)
        rq.wait(timeout=120)
        lg = joblog(jid2)
        (LOG / "S2_resume.log").write_text(lg, encoding="utf-8")
        after = done_files()
        untouched = all(after.get(k) == v for k, v in before.items())
        need = len(IDS) - len(before)
        ok = fin and job(jid2)[0] == "succeeded" and len(after) == len(IDS) and untouched and f"需要產生 {need} 句" in lg and not leftovers()
        results["S2_resume"] = {"pass": ok, "regenerated": need, "untouched": untouched, "status": job(jid2)[0]}

        # S3 程序凍結（沒有心跳、沒有每句上限）→ Studio 無輸出上限 45 秒
        env = {"PIKARA_STALL_VOICE_SECS": "45", "PIKARA_TTS_FAULT": f"hang:{IDS[2]}", "PIKARA_TTS_HEARTBEAT_SEC": "100000", "PIKARA_TTS_LINE_TIMEOUT": "0"}
        jid3 = enqueue({"seq": SEQ, "only": IDS[2], "force": True})
        t0 = time.time()
        rq = run_queue(env)
        fin = wait(lambda: job(jid3)[0] in ("succeeded", "failed", "canceled"), 900)
        el = time.time() - t0
        rq.wait(timeout=120)
        st = job(jid3)
        (LOG / "S3_frozen.log").write_text(joblog(jid3), encoding="utf-8")
        ok = fin and st[0] == "failed" and "停滯" in (st[1] or "") and not leftovers() and OUTD.joinpath(f"{IDS[2]}.mp3").exists()
        results["S3_frozen_process"] = {"pass": ok, "status": st[0], "error": (st[1] or "")[:200], "secondsToDetect": round(el, 1)}
    finally:
        shutil.copy2(BAK, NAR)
        for pid in leftovers():
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
    (LOG / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    for k, v in results.items():
        print(("PASS " if v["pass"] else "FAIL ") + k, json.dumps(v, ensure_ascii=False))
    return 0 if results and all(v["pass"] for v in results.values()) else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gpu_lock import gpu_lease  # 全機 GPU 租約：不與其他 GPU 測試、渲染、截圖同時執行
    with gpu_lease(Path(__file__).name):
        sys.exit(main())
