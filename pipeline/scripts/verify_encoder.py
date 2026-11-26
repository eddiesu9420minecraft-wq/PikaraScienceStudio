# 驗證 ffmpeg 硬體編碼器實際使用的 GPU 引擎：h264_nvenc 編碼 60 秒 1080p 測試畫面，同時讀 GPU Engine 計數器。
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
DATA = ROOT / "out" / "v03" / "hw-data"
enc = sys.argv[1] if len(sys.argv) > 1 else "h264_nvenc"


def hw(*a):
    t = subprocess.run([str(EXE), "--cli", *a, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120).stdout
    return json.loads(t[t.find("{"):])


with gpu_lease("verify-encoder"):
    names = {g["luid"]: g["name"] for g in hw("hw-info")["hardware"]["snapshot"]["gpus"]}
    out = ROOT / "out" / "v03" / "verify-enc.mp4"
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=60", "-c:v", enc, str(out)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rows = []
    while p.poll() is None:
        u = hw("hw-usage", "--ms", "1500")["usage"]
        for x in (u.get("roles") or {}).get("encoder", []):
            rows.append({"gpu": names.get(x["luid"], x["luid"]), "engines": {k: round(v, 1) for k, v in x["engines"].items() if v > 0.05}})
        time.sleep(1)
    agg = {}
    for r in rows:
        a = agg.setdefault(r["gpu"], {})
        for k, v in r["engines"].items():
            a[k] = round(a.get(k, 0) + v, 1)
    res = {"encoder": enc, "exit": p.returncode, "samples": len(rows), "perGpuEngines": agg}
    print(json.dumps(res, ensure_ascii=False))
    (ROOT / "out" / "v03" / "verify_encoder.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    out.unlink(missing_ok=True)
