"""v0.3.2 製作控制驗收（隔離測試，Sandbox 短影片，不使用付費 API、不呼叫 AI）。

    py -3.11 scripts/test_v032_controls.py --exe <PikaraScienceStudio.exe> --project <隔離的專案複本> --data <空的資料夾> --out <報告資料夾>

情境（全部透過 Studio 命令列操作同一套資料庫與排程器，與介面按鈕呼叫的是同一組後端函式）：
  A 建立（稍後開始）→ 製作狀態為「尚未開始」→ 編輯設定 → 開始 → 重複開始被拒絕
  B 外部 Agent 模式（不呼叫 AI）：等待 Agent 時暫停／繼續；由測試扮演 Agent，寫入擬人化角色與對白後回報完成
  C 配音進行中暫停：目前工作做完才停、不開始新步驟；繼續後從下一步接續（配音不重做）
  D 渲染中取消：工作程序樹全部結束（沒有殘留的 node／ffmpeg／chrome）；從中斷處繼續，配音不重做
  E 渲染中強制結束排程器（模擬 Studio 當機／重新開機）→ 重新啟動後自動恢復並完成
  F 刪除影片檔案（移到 .studio/trash）與刪除影片任務是不同操作；刪除後不殘留工作樹與分支
  G 進行中的影片直接刪除任務：先停止、結束程序、刪除工作樹
每一步把 auto-board 的實際狀態（11 個步驟）寫進報告。GPU 工作透過 Studio 自己的 GPU 租約排隊。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ap = argparse.ArgumentParser()
ap.add_argument("--exe", required=True)
ap.add_argument("--project", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--out", required=True)
A = ap.parse_args()
OUT = Path(A.out)
OUT.mkdir(parents=True, exist_ok=True)
LOG = open(OUT / "controls.log", "a", encoding="utf-8")
RESULTS: list[dict] = []
T0 = time.time()


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')} +{time.time() - T0:6.0f}s] {msg}"
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


def cli(*args: str, ok: bool = True) -> dict | list:
    r = subprocess.run([A.exe, "--cli", *args, "--data", A.data], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    txt = r.stdout.strip()
    try:
        v = json.loads(txt) if txt else {}
    except json.JSONDecodeError:
        v = {"raw": txt}
    if ok and r.returncode != 0:
        raise RuntimeError(f"cli {args[0]} 失敗（{r.returncode}）：{r.stderr.strip()[-600:]} {txt[-300:]}")
    if not ok:
        return {"code": r.returncode, "out": v, "err": r.stderr.strip()[-600:]}
    return v


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append({"name": name, "pass": bool(cond), "detail": detail})
    log(f"{'✓' if cond else '✗'} {name}{('：' + detail) if detail else ''}")


def board(pid: str) -> dict:
    return cli("auto-board", "--id", pid)[0]


def steps(b: dict) -> str:
    return " ".join(f"{s['id']}={s['status']}" for s in b["steps"])


def snap(tag: str, pid: str) -> dict:
    b = board(pid)
    (OUT / f"board-{len(list(OUT.glob('board-*.json'))):02d}-{tag}.json").write_text(json.dumps(b, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"  [{tag}] status={b['status']} progress={b['progress']} current={b['currentStep']} job={(b['job'] or {}).get('label')}/{(b['job'] or {}).get('status')} | {steps(b)}")
    return b


def wait(pid: str, pred, what: str, timeout: float = 1800, every: float = 2.0) -> dict:
    t = time.time()
    while time.time() - t < timeout:
        b = board(pid)
        if pred(b):
            return b
        if b["status"] in ("failed",) and "failed" not in what:
            raise RuntimeError(f"等待「{what}」時製作失敗：{b.get('message')} {b.get('errors')}")
        time.sleep(every)
    raise TimeoutError(f"等待逾時：{what}")


def ps_tree(root_pid: int) -> list[dict]:
    """root_pid 的所有子孫程序（名稱、PID）。"""
    cmd = ("$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; "
           "$all | ConvertTo-Json -Compress")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, encoding="utf-8", errors="replace")
    procs = json.loads(r.stdout or "[]")
    kids, frontier = [], {root_pid}
    while frontier:
        nxt = {p["ProcessId"] for p in procs if p["ParentProcessId"] in frontier and p["ProcessId"] != root_pid} - {k["ProcessId"] for k in kids}
        kids += [p for p in procs if p["ProcessId"] in nxt]
        frontier = nxt
    return kids


def alive(pids: list[int]) -> list[int]:
    if not pids:
        return []
    r = subprocess.run(["powershell", "-NoProfile", "-Command", f"Get-Process -Id {','.join(map(str, pids))} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"], capture_output=True, text=True)
    return [int(x) for x in r.stdout.split() if x.strip().isdigit()]


RUNNER: subprocess.Popen | None = None


def start_runner(tag: str) -> None:
    global RUNNER
    f = open(OUT / f"auto-run-{tag}.log", "w", encoding="utf-8")
    RUNNER = subprocess.Popen([A.exe, "--cli", "auto-run", "--stay", "--timeout", "10800", "--data", A.data], stdout=f, stderr=subprocess.STDOUT)
    log(f"排程器（auto-run）啟動 PID {RUNNER.pid}（{tag}）")
    time.sleep(3)


def stop_runner_hard() -> list[int]:
    """模擬 Studio 當機／電腦重新開機：強制結束排程器與它的整個程序樹。"""
    kids = [k["ProcessId"] for k in ps_tree(RUNNER.pid)]
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(RUNNER.pid)], capture_output=True)
    RUNNER.wait(timeout=30)
    time.sleep(2)
    return kids


def voice_mtimes(root: Path, ep: str) -> dict:
    d = root / "public" / "assets" / "audio" / "voiceover_cosy" / ep
    return {p.name: p.stat().st_mtime for p in sorted(d.glob("*.mp3"))} if d.exists() else {}


# ----------------------------------------------------------------------------------------------- 設定
SCRIPT = """# 為什麼 GPU 不能取代 CPU

## 開場
GPU 這麼強，為什麼不能取代 CPU？

## 對話
我有幾千個核心！
那你自己開機啊。

## 結論
所以 CPU 和 GPU，缺一不可。
"""
CFG = {
    "topic": "控制驗收：GPU 為什麼不能取代 CPU", "minutes": 0.5, "mode": "script", "scriptText": SCRIPT, "language": "zh-TW",
    "style": "generic", "agent": "external", "sandbox": True, "narrative": "personified",
    "characters": [{"name": "GPU", "concept": "GPU", "look": "琥珀色晶片", "personality": "自信", "voice": "ref_S3", "pitch": 3},
                   {"name": "CPU", "concept": "CPU", "look": "冰藍色晶片", "personality": "冷靜", "voice": "", "pitch": -2}],
    "youtube": False, "thumbnail": False, "publishInfo": False, "visualReview": False, "pronunciationCheck": False,
    "minSources": 0, "maxAttempts": 2, "maxMinutes": 120,
}
root = Path(A.project)
cfg_file = OUT / "config.json"
cfg_file.write_text(json.dumps(CFG, ensure_ascii=False), encoding="utf-8")

try:
    # ------------------------------------------------------------------ A 建立、編輯、開始
    log("== A 建立（稍後開始）、編輯、開始 ==")
    r = cli("auto-start", "--project", str(root), "--config-file", str(cfg_file), "--hold")
    pid, ep = r["id"], r["episode"]
    check("建立後狀態為尚未開始（draft）", r["status"] == "draft", f"{ep.upper()} {r['status']}")
    b = snap("draft", pid)
    check("製作狀態：11 個步驟全部等待中、可「開始製作」", len(b["steps"]) == 11 and all(s["status"] in ("pending", "skipped") for s in b["steps"]) and b["can"]["start"], steps(b))
    patch = OUT / "patch.json"
    patch.write_text(json.dumps({"topic": "控制驗收：CPU 與 GPU 的分工", "maxMinutes": 90}, ensure_ascii=False), encoding="utf-8")
    u = cli("auto-update-config", "--id", pid, "--patch-file", str(patch))
    check("尚未開始的影片可以編輯設定", u["config"]["topic"] == "控制驗收：CPU 與 GPU 的分工" and u["config"]["maxMinutes"] == 90)
    start_runner("1")
    time.sleep(6)
    check("排程器不會自動開始尚未開始的影片", board(pid)["status"] == "draft")
    s = cli("auto-start-draft", "--id", pid)
    check("按「開始製作」後排入佇列", s["result"]["status"] == "queued")
    dup = cli("auto-start-draft", "--id", pid, ok=False)
    check("同一部影片不能重複開始", dup["code"] != 0, dup["err"][-120:])

    # ------------------------------------------------------------------ B 等待 Agent：暫停／繼續；扮演 Agent 寫入角色
    log("== B 外部 Agent：暫停／繼續 ==")
    b = wait(pid, lambda b: b["status"] == "waiting_agent", "等待 Agent", 600)
    snap("waiting-agent", pid)
    cli("auto-pause", "--id", pid)
    b = snap("paused-agent", pid)
    check("等待 Agent 時可以暫停；目前步驟顯示已暫停", b["status"] == "paused" and any(s["status"] == "paused" for s in b["steps"]), steps(b))
    cli("auto-resume", "--id", pid)
    b = wait(pid, lambda b: b["status"] == "waiting_agent", "繼續後回到等待 Agent", 120)
    check("繼續後回到同一步（等待 Agent），沒有重做前面的步驟", b["currentStep"] in ("script", "research"), b["currentStep"])
    wt = root / ".studio" / "worktrees" / b["worktree"]
    nar_p = wt / "src" / "data" / "narration.json"
    nar = json.loads(nar_p.read_text(encoding="utf-8"))
    seq = nar["sequences"][ep]
    seq["characters"] = [{"id": "gpu", "name": "GPU", "concept": "GPU", "look": "琥珀色晶片", "personality": "自信", "voice": "ref_S3", "pitch": 3},
                         {"id": "cpu", "name": "CPU", "concept": "CPU", "look": "冰藍色晶片", "personality": "冷靜", "voice": "", "pitch": -2}]
    speakers = {}
    for sc in seq["scenes"]:
        for ln in sc["lines"]:
            if "幾千個核心" in ln["subtitle"]:
                ln["speaker"] = "gpu"; ln["speak"] = "我有幾千個核心！"; speakers[ln["id"]] = "gpu"
            elif "自己開機" in ln["subtitle"]:
                ln["speaker"] = "cpu"; speakers[ln["id"]] = "cpu"
            if "GPU" in ln.get("subtitle", "") and "speak" not in ln:
                ln["speak"] = ln["subtitle"].replace("GPU", "G P U").replace("CPU", "C P U")
    nar_p.write_text(json.dumps(nar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    check("Agent（測試）寫入擬人化角色與對白（speaker）", len(speakers) == 2, json.dumps(speakers, ensure_ascii=False))
    cli("agent-done", "--id", pid, "--note", "控制驗收：加入角色與對白")

    # ------------------------------------------------------------------ C 配音中暫停
    log("== C 配音進行中暫停 ==")
    b = wait(pid, lambda b: b["job"] and b["job"]["kind"] in ("voiceover_tw",) and b["job"]["status"] == "running", "配音工作開始", 1800)
    snap("voice-running", pid)
    cli("auto-pause", "--id", pid)
    b = snap("voice-pausing", pid)
    check("配音中按暫停：狀態已暫停，目前工作繼續做完（安全檢查點）", b["status"] == "paused" and b["pausing"] is True and b["job"]["status"] == "running")
    voice_job = b["job"]["id"]
    b = wait(pid, lambda b: (b["job"] or {}).get("status") not in ("running", "queued", "waiting_resource"), "配音工作完成", 1800)
    t_done = time.time()
    time.sleep(15)
    b = snap("voice-paused-after", pid)
    check("暫停後沒有開始新的步驟", b["status"] == "paused" and (b["job"] or {}).get("id") == voice_job, f"job={(b['job'] or {}).get('label')}")
    mt1 = voice_mtimes(wt, ep)
    metas = {m.stem: json.loads(m.read_text(encoding="utf-8")) for m in (wt / "public/assets/audio/voiceover_cosy" / ep).glob("*.json")}
    spk = {k: v.get("speaker") for k, v in metas.items() if v.get("speaker")}
    check("角色台詞使用角色人聲（參考人聲／音高記錄在配音資訊）", set(spk) == set(speakers) and spk[[k for k, v in speakers.items() if v == "gpu"][0]]["ref"] == "ref_S3",
          json.dumps(spk, ensure_ascii=False))
    nar_keys = [v["key"] for k, v in metas.items() if k not in speakers]
    check("旁白句子照常配音（沒有角色欄位）", nar_keys and all("speaker" not in v for k, v in metas.items() if k not in speakers), f"{len(nar_keys)} 句旁白")
    cli("auto-resume", "--id", pid)

    # ------------------------------------------------------------------ D 渲染中取消、從中斷處繼續
    log("== D 渲染中取消 ==")
    b = wait(pid, lambda b: b["job"] and b["job"]["kind"] == "final_tw" and b["job"]["status"] == "running" and "渲染" in (b["job"].get("stepLabel") or ""), "渲染開始", 2400)
    time.sleep(8)
    b = snap("render-running", pid)
    check("渲染中：音訊混合已完成、影片渲染執行中（來自工作的實際步驟）", [s["status"] for s in b["steps"] if s["id"] in ("mix", "render")] == ["done", "running"], steps(b))
    jpid = None
    for _ in range(10):
        jobs = cli("jobs", "--limit", "5")
        jj = [j for j in (jobs if isinstance(jobs, list) else jobs.get("jobs", [])) if j.get("id") == b["job"]["id"]]
        jpid = jj[0].get("pid") if jj else None
        if jpid:
            break
        time.sleep(1)
    tree = ps_tree(jpid) if jpid else []
    tree_pids = ([jpid] if jpid else []) + [k["ProcessId"] for k in tree]
    log(f"  渲染程序樹：{jpid} + {[(k['Name'], k['ProcessId']) for k in tree][:12]}")
    cli("auto-stop", "--id", pid)
    time.sleep(6)
    left = alive(tree_pids)
    b = snap("canceled", pid)
    check("取消後狀態為已取消、渲染步驟顯示已取消", b["status"] == "canceled" and any(s["id"] == "render" and s["status"] == "canceled" for s in b["steps"]), steps(b))
    check("取消後沒有殘留的渲染程序（node／ffmpeg／chrome）", jpid is not None and not left, f"程序樹 {len(tree_pids)} 個，殘留 {left}")
    check("已取消且工作樹還在：可以從中斷處繼續", b["can"]["resume"] is True)
    cli("auto-resume", "--id", pid)
    b = wait(pid, lambda b: b["job"] and b["job"]["kind"] == "final_tw" and b["job"]["status"] == "running", "繼續後重新渲染", 1200)
    check("從中斷處繼續：回到同一階段（音訊混合／渲染），不是從頭開始", b["currentStep"] in ("mix", "render"), b["currentStep"])

    # ------------------------------------------------------------------ E 強制結束排程器 → 重新啟動恢復
    log("== E 模擬 Studio 當機後重新啟動 ==")
    b = wait(pid, lambda b: b["job"] and b["job"]["status"] == "running" and "渲染" in (b["job"].get("stepLabel") or ""), "再次進入渲染", 1200)
    time.sleep(5)
    killed = stop_runner_hard()
    log(f"  已強制結束排程器與子程序：{len(killed)} 個")
    b = snap("crashed", pid)
    start_runner("2-restart")
    b = wait(pid, lambda b: b["status"] in ("succeeded", "failed"), "重新啟動後完成", 3600, every=5)
    b = snap("finished", pid)
    check("重新啟動後自動恢復並完成製作", b["status"] == "succeeded", b.get("message") or "")
    mt2 = voice_mtimes(wt if wt.exists() else root, ep)
    check("暫停、取消、當機重啟之後配音沒有重做", bool(mt1) and all(abs(mt1[k] - mt2.get(k, mt1[k])) < 1e-6 for k in mt1) if mt2 else bool(mt1), f"{len(mt1)} 個音檔")
    log_txt = (OUT / "auto-run-2-restart.log").read_text(encoding="utf-8", errors="replace")
    rec = [l.strip() for l in log_txt.splitlines() if "重新啟動" in l or "復原" in l or "interrupted" in l]
    check("重新啟動時復原中斷的工作（標記 interrupted 並重新排入）", bool(rec), (rec[0] if rec else "")[:160])
    check("完成後 11 個步驟都是已完成或略過", all(s["status"] in ("done", "warned", "skipped") for s in b["steps"]), steps(b))

    # ------------------------------------------------------------------ F 刪除影片檔案／刪除影片任務
    log("== F 刪除影片檔案與刪除任務 ==")
    vdir = Path(b["videoDir"])
    check("Sandbox 成品在影片資料夾", vdir.exists() and any(vdir.rglob("*.mp4")), str(vdir))
    df = cli("auto-delete-files", "--id", pid)
    moved = root / df["result"]["moved"]
    check("刪除影片檔案：資料夾移到 .studio/trash（可搬回），製作紀錄保留", not vdir.exists() and moved.exists() and board(pid)["filesDeleted"])
    br = b["worktree"]
    dt = cli("auto-delete-task", "--id", pid)
    gone = cli("auto-board", "--id", pid, ok=False)
    branches = subprocess.run(["git", "-C", str(root), "branch", "--list", "studio/auto/*"], capture_output=True, text=True).stdout
    check("刪除影片任務：紀錄刪除、沒有殘留工作樹與分支", gone["code"] != 0 and not (root / ".studio" / "worktrees" / (br or "x")).exists() and pid[:8] not in branches)

    # ------------------------------------------------------------------ G 進行中的影片直接刪除任務
    log("== G 進行中的影片直接刪除任務 ==")
    r2 = cli("auto-start", "--project", str(root), "--config-file", str(cfg_file))
    p2 = r2["id"]
    b2 = wait(p2, lambda b: b["status"] == "waiting_agent", "第二部影片等待 Agent", 600)
    wt2 = root / ".studio" / "worktrees" / b2["worktree"]
    check("第二部影片建立了工作樹", wt2.exists())
    cli("auto-delete-task", "--id", p2)
    check("進行中的影片刪除任務：停止並刪除工作樹與紀錄", not wt2.exists() and cli("auto-board", "--id", p2, ok=False)["code"] != 0)
finally:
    if RUNNER and RUNNER.poll() is None:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(RUNNER.pid)], capture_output=True)
    ok = sum(r["pass"] for r in RESULTS)
    (OUT / "controls.json").write_text(json.dumps({"passed": ok, "total": len(RESULTS), "results": RESULTS, "seconds": round(time.time() - T0)}, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"結果：{ok}/{len(RESULTS)} 通過")
