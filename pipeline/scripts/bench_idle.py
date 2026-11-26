# Benchmark B4b：Studio 閒置時的 CPU／記憶體（正式版 v0.2.1 vs 正式版 v0.3.0；各自獨立的資料夾；總覽畫面閒置 30 秒，3 輪）
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXES = [("v0.2.1", ROOT / "studio" / "dist-v0.2.1" / "PikaraScienceStudio.exe"), ("v0.3.0", ROOT / "studio" / "app" / "src-tauri" / "target" / "release" / "PikaraScienceStudio.exe")]
PROJ = r"<PROJECT_DIR>-v03-e2e"


def tree_stats(root_pid):
    ps = ("$all = Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize; "
          f"$ids = @({root_pid}); do {{ $n = $ids.Count; $ids = @($ids + ($all | ? {{ $ids -contains $_.ParentProcessId }} | % ProcessId) | Select -Unique) }} while ($ids.Count -ne $n); "
          "$s = $all | ? { $ids -contains $_.ProcessId }; "
          "[pscustomobject]@{ cpu = ($s | Measure-Object -Property UserModeTime -Sum).Sum + ($s | Measure-Object -Property KernelModeTime -Sum).Sum; ws = ($s | Measure-Object -Property WorkingSetSize -Sum).Sum; n = @($s).Count } | ConvertTo-Json -Compress")
    return json.loads(subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60).stdout)


res = {}
with gpu_lease("bench-idle"):
    for ver, exe in EXES:
        runs = []
        for i in range(3):
            d = ROOT / "out" / "v03" / f"bench-idle-{ver}-{i}"
            d.mkdir(parents=True, exist_ok=True)
            subprocess.run([str(exe), "--cli", "episode-list", "--project", PROJ, "--data", str(d)], capture_output=True)
            t_start = time.time()
            p = subprocess.Popen([str(exe)], env={**os.environ, "PIKARA_STUDIO_DATA": str(d)})
            time.sleep(15)
            a0, t0 = tree_stats(p.pid), time.time()
            time.sleep(30)
            a1, t1 = tree_stats(p.pid), time.time()
            cpu = (a1["cpu"] - a0["cpu"]) / 1e7 / (t1 - t0) * 100 / (os.cpu_count() or 1)
            runs.append({"cpuPctOfMachine": round(cpu, 2), "workingSetMiB": round(a1["ws"] / 1048576), "processes": a1["n"]})
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
            time.sleep(4)
        res[ver] = {"runs": runs, "cpuMedian": statistics.median(r["cpuPctOfMachine"] for r in runs), "wsMedianMiB": statistics.median(r["workingSetMiB"] for r in runs)}
        print(ver, json.dumps(res[ver], ensure_ascii=False), flush=True)
(ROOT / "out" / "v03" / "bench" / "idle.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
