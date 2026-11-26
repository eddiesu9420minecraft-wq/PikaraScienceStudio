# Benchmark B4a：build_timeline v0.2.1 vs v0.3.0（EP04，各 3 次取中位數；只用 CPU）
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

proj = Path(sys.argv[1] if len(sys.argv) > 1 else r"<PROJECT_DIR>-v03-e2e")
out = {}
tp = proj / "src" / "data" / "timeline.generated.json"
bak = tp.read_bytes()
try:
    for ver, args in [("v0.2.1", ["scripts/_v021_build_timeline.py", "--seq", "ep04"]), ("v0.3.0", ["scripts/build_timeline.py", "--seq", "ep04", "--out", "out/bench/tl.json"])]:
        t = []
        for _ in range(3):
            s = time.time()
            subprocess.run(["py", "-3.11", *args], cwd=proj, capture_output=True, env={"PYTHONUTF8": "1", **__import__("os").environ})
            t.append(time.time() - s)
        out[ver] = {"medianSec": round(statistics.median(t), 2), "runs": [round(x, 2) for x in t]}
finally:
    tp.write_bytes(bak)
print(json.dumps(out, ensure_ascii=False))
Path(r"<PROJECT_DIR>-v021\out\v03\bench\timeline.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
