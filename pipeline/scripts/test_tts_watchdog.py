# py -3.11 scripts/test_tts_watchdog.py — 配音程序防卡死機制的模擬測試（不需要 GPU 或 CosyVoice）。
# 每個情境在子程序裡跑，才能檢查真正的結束碼、堆疊輸出與殘留子程序。
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable
ok = fail = 0


def child(code: str, timeout: float = 60, env: dict | None = None):
    pre = f"import sys,time,os; sys.path.insert(0, {str(HERE)!r}); from tts_watchdog import *\n"
    t0 = time.time()
    p = subprocess.run([PY, "-u", "-c", pre + code], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, "PYTHONUTF8": "1", **(env or {})})
    return p.returncode, p.stdout + p.stderr, time.time() - t0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"ok   {name}")
    else:
        fail += 1
        print(f"FAIL {name}\n{detail}")


def procs(name: str) -> list[tuple[int, int, str]]:
    """(pid, parent, cmdline) of running processes with this image name (Windows CIM; empty elsewhere)."""
    if os.name != "nt":
        return []
    ps = (f"Get-CimInstance Win32_Process -Filter \"Name='{name}'\" | ForEach-Object {{ \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }}")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    out = []
    for line in r.stdout.splitlines():
        a = line.split("|", 2)
        if len(a) == 3 and a[0].isdigit():
            out.append((int(a[0]), int(a[1] or 0), a[2]))
    return out


# 1. 心跳：正常但很慢的工作會持續印出心跳（Studio 的無輸出上限不會誤判）
rc, out, el = child("wd = Watchdog(heartbeat=1)\nwd.set('合成', 'x-01', 30)\ntime.sleep(3.5)\nwd.clear()\nprint('done')")
check("心跳每秒印出且含階段與句子", rc == 0 and out.count("♥ 合成 x-01") >= 2 and "RAM" in out, out)

# 2. 推論無回應：超過階段上限 → 印出各執行緒堆疊、執行清理、結束碼 4
rc, out, el = child("wd = Watchdog(heartbeat=5)\nwd.cleanups.append(lambda: print('CLEANUP-RAN', flush=True))\n"
                    "def stuck_inference():\n    time.sleep(60)\nwd.set('合成', 'x-02', 2)\nstuck_inference()", timeout=30)
check("推論卡住：約 2 秒後以結束碼 4 離開", rc == 4 and el < 10, f"rc={rc} el={el:.1f}\n{out}")
check("停滯時印出卡住的位置（堆疊含 stuck_inference）", "[停滯]" in out and "stuck_inference" in out, out)
check("停滯時執行清理（停止 GPU 記錄等）", "CLEANUP-RAN" in out, out)

# 3. 正常完成的階段不會觸發
rc, out, el = child("wd = Watchdog(heartbeat=5)\nwd.set('合成', 'x-03', 3)\ntime.sleep(1)\nwd.set('合成', 'x-04', 3)\ntime.sleep(1)\nwd.clear()\ntime.sleep(3)\nprint('done')")
check("每句重設上限：連續多句、總時間超過單句上限也不誤判", rc == 0 and "done" in out and "[停滯]" not in out, out)

# 4. 上限 0＝不限（等待外部 GPU 有自己的上限）
rc, out, el = child("wd = Watchdog(heartbeat=5)\nwd.set('等待 GPU', '', 0)\ntime.sleep(2)\nprint('done')")
check("上限 0 不觸發", rc == 0 and "done" in out, out)

# 5. 子程序殘留：舊版 nvidia-smi -l 子程序 vs. 新版執行緒（父程序被強制結束後）
has_smi = subprocess.run(["where" if os.name == "nt" else "which", "nvidia-smi"], capture_output=True).returncode == 0
if has_smi and os.name == "nt":
    tmp = Path(os.environ.get("TEMP", ".")) / "pikara_wd_test"
    tmp.mkdir(exist_ok=True)
    for mode in ("old", "new"):
        marker = tmp / f"smi_{mode}.csv"
        marker.unlink(missing_ok=True)
        code = ("import subprocess\n"
                f"subprocess.Popen(['nvidia-smi','--query-gpu=timestamp','--format=csv','-l','1','-f',{str(marker)!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
                if mode == "old" else f"GpuLogger({str(marker)!r}, interval=1)\n") + "print('started', flush=True)\ntime.sleep(60)"
        p = subprocess.Popen([PY, "-u", "-c", f"import sys,time; sys.path.insert(0, {str(HERE)!r}); from tts_watchdog import *\n" + code],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        p.stdout.readline()
        time.sleep(3)
        subprocess.run(["taskkill", "/F", "/PID", str(p.pid)], capture_output=True)  # 只殺父程序（模擬崩潰／被強制結束）
        p.wait(timeout=20)
        time.sleep(2)
        left = [x for x in procs("nvidia-smi.exe") if str(marker) in x[2]]
        if mode == "old":
            check("舊版：父程序被結束後 nvidia-smi -l 成為孤兒（重現問題）", len(left) == 1, str(left))
        else:
            check("新版：父程序被結束後沒有殘留 nvidia-smi", not left, str(left))
            check("新版：GPU 記錄確實有寫入", marker.exists() and marker.stat().st_size > 0)
        for pid, _, _ in left:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
else:
    print("skip 子程序殘留測試（沒有 nvidia-smi 或非 Windows）")

print(f"\n{ok}/{ok + fail} watchdog cases passed")
sys.exit(1 if fail else 0)
