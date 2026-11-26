# 實驗：Chromium（Remotion 的 chrome-headless-shell）能否用 --use-adapter-luid 指定 GPU、值的格式是什麼。
# 每組設定跑一次 gpu-check（GpuProbe：WebGL 回報的 renderer 字串＝ANGLE 實際使用的轉接器）。
#   py -3.11 scripts/exp_adapter_select.py <amdLuid> <nvLuid>      例：0,75596 0,91465
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
amd, nv = sys.argv[1], sys.argv[2]
cases = [("none", None, None), ("amd-dec", amd, "dec"), ("nv-dec", nv, "dec"), ("amd-hex", amd, "hex"), ("nv-hex", nv, "hex")]
out = {}
with gpu_lease("實驗：Chromium 轉接器選擇"):
    for name, luid, fmt in cases:
        env = {k: v for k, v in os.environ.items() if not k.startswith("PIKARA_RENDER_GPU_LUID") and k != "PIKARA_ADAPTER_LUID_FORMAT"}
        if luid:
            env["PIKARA_RENDER_GPU_LUID"] = luid
            env["PIKARA_ADAPTER_LUID_FORMAT"] = fmt
        r = subprocess.run(["node", "scripts/gpu-check.mjs", "--force"], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        j = json.loads((ROOT / "out" / "gpu-check.json").read_text(encoding="utf-8"))
        out[name] = (j.get("webgl_angle") or {}).get("renderer")
        print(f"{name:8s} → {out[name]}", flush=True)
(ROOT / "out" / "v03" / "exp_adapter_select.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
