# 驗證各工作實際使用的裝置（Windows GPU Engine 計數器；取樣同時進行工作）：
#   V1 Remotion 渲染（分配：渲染 GPU）＋ ffmpeg 編碼（NVENC → VideoEncode 引擎）
#   V2 同一段渲染強制改用另一張 GPU（證明分配真的改變實際裝置，而不是剛好用到預設 GPU）
#   V3 CosyVoice＋Whisper（CUDA_VISIBLE_DEVICES → Compute／CUDA 引擎）
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/verify_devices.py [--project <PROJECT_DIR>-v03-e2e]
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "studio" / "app" / "src-tauri" / "target" / "debug" / "PikaraScienceStudio.exe"
DATA = ROOT / "out" / "v03" / "hw-data"
COSY_PY = ROOT / "tools" / "CosyVoice" / ".venv" / "Scripts" / "python.exe"


def hw(*a):
    r = subprocess.run([str(EXE), "--cli", *a, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    t = r.stdout
    return json.loads(t[t.find("{"):])


def sample_while(proc, names, every=3.0):
    rows = []
    while proc.poll() is None:
        u = hw("hw-usage", "--ms", "1500")["usage"]
        for role, lst in (u.get("roles") or {}).items():
            for x in lst:
                rows.append({"role": role, "gpu": names.get(x["luid"], x["luid"]), "util": x["utilPct"], "ded": x["dedicatedMiB"], "engines": {k: round(v, 1) for k, v in x["engines"].items() if v > 0.05}})
        time.sleep(every)
    return rows


def summarize(rows, role):
    agg = {}
    for r in rows:
        if r["role"] != role:
            continue
        a = agg.setdefault(r["gpu"], {"utilSum": 0.0, "dedMax": 0.0, "engines": {}})
        a["utilSum"] = round(a["utilSum"] + r["util"], 1)
        a["dedMax"] = max(a["dedMax"], r["ded"])
        for k, v in r["engines"].items():
            a["engines"][k] = round(a["engines"].get(k, 0) + v, 1)
    return agg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=r"<PROJECT_DIR>-v03-e2e")
    a = ap.parse_args()
    proj = Path(a.project)
    info = hw("hw-info")["hardware"]
    names = {g["luid"]: g["name"] for g in info["snapshot"]["gpus"]}
    asg = info["assignment"]
    other = next((g for g in info["snapshot"]["gpus"] if g["kind"] != "software" and g["luid"] != asg["render"]["luid"]), None)
    out = {"assignment": {k: asg[k]["gpuName"] for k in ("ui", "render", "ai")}, "encoder": asg["encoder"]}

    def render(luid, tag):
        env = {**os.environ, "PIKARA_RENDER_GPU_LUID": luid, "PIKARA_ENCODER": asg["encoder"].get("encoder", "auto") if asg["encoder"].get("encoder") != "auto" else "auto"}
        p = subprocess.Popen(["node", "scripts/render.mjs", "gpu", "--comp", "EP04-30fps", "--frames", "0-599", "--fresh", "--skip-check", "--out", f"out/bench/verify-{tag}.mp4"],
                             cwd=proj, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        rows = sample_while(p, names)
        return {"exit": p.returncode, "render": summarize(rows, "render"), "encoder": summarize(rows, "encoder")}

    out["V1_render_assigned"] = {"expected": asg["render"]["gpuName"], **render(asg["render"]["luid"], "assigned")}
    print(json.dumps(out["V1_render_assigned"], ensure_ascii=False), flush=True)
    if other:
        out["V2_render_other"] = {"expected": other["name"], **render(other["luid"], "other")}
        print(json.dumps(out["V2_render_other"], ensure_ascii=False), flush=True)
    env = {**os.environ, "PYTHONUTF8": "1", "KMP_DUPLICATE_LIB_OK": "TRUE", "CUDA_VISIBLE_DEVICES": str(asg["ai"]["cudaIndex"]) if asg["ai"].get("cudaIndex") is not None else ""}
    p = subprocess.Popen([str(COSY_PY), "-u", "scripts/generate_voiceover_cosy.py", "--seq", "ep04", "--only", "ep04-s01-01", "--force", "--out-root", "public/assets/audio/_bench/verify"],
                         cwd=proj, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rows = sample_while(p, names)
    out["V3_ai"] = {"expected": asg["ai"]["gpuName"], "exit": p.returncode, "ai": summarize(rows, "ai")}
    print(json.dumps(out["V3_ai"], ensure_ascii=False), flush=True)
    (ROOT / "out" / "v03" / "verify_devices.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    with gpu_lease("verify-devices"):
        main()
