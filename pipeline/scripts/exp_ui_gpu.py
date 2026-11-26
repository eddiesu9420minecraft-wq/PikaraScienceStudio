# 實驗／驗證：Studio 介面（WebView2）實際使用哪一張 GPU——Windows GPU Engine 計數器（與工作管理員相同來源），
# 只統計這個 Studio 視窗底下的 msedgewebview2 程序。介面在導覽測試中持續切換畫面，產生真實的繪圖負載。
#   py -3.11 scripts/exp_ui_gpu.py --exe <PikaraScienceStudio.exe> [--project <PROJECT_DIR>-v03-e2e]
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import gpu_lease  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "out" / "v03" / "ui-gpu-data"
OUT = ROOT / "out" / "v03" / "ui_gpu_verify.json"


def cli(exe, *a, timeout=120):
    r = subprocess.run([exe, "--cli", *a, "--data", str(DATA)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    t = r.stdout.strip()
    return json.loads(t[t.find("{"):]) if "{" in t else {"raw": t, "err": r.stderr}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--project", default=r"<PROJECT_DIR>-v03-e2e")
    a = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    cli(a.exe, "episode-list", "--project", a.project)
    info = cli(a.exe, "hw-info")["hardware"]
    names = {g["luid"]: g["name"] for g in info["snapshot"]["gpus"]}
    modes = [("WebView2 預設（不指定）", None, {"PIKARA_UI_GPU_SELECT": "0"}), ("自動", "auto", {}), ("內顯", "integrated", {}), ("獨顯", "discrete", {})]
    results = []
    for label, ui, extra in modes:
        if ui:
            cli(a.exe, "settings-set", "--json", json.dumps({"hw": {**info["prefs"], "uiGpu": ui}}))
        env = {**os.environ, "PIKARA_STUDIO_DATA": str(DATA), "PIKARA_UI_TOUR": "1", "PIKARA_UI_TOUR_STEP_MS": "1500", **extra}
        env.pop("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", None)
        p = subprocess.Popen([a.exe], env=env)
        try:
            time.sleep(8)
            samples = []
            for _ in range(3):
                u = cli(a.exe, "hw-usage", "--ui-root", str(p.pid), "--ms", "2500")["usage"]
                ui_rows = (u.get("roles") or {}).get("ui", [])
                samples.append([{"gpu": names.get(r["luid"], r["luid"]), "utilPct": r["utilPct"], "dedicatedMiB": r["dedicatedMiB"], "engines": r["engines"]} for r in ui_rows])
            # the adapter carrying the UI's 3D work / memory across samples
            agg = {}
            for s in samples:
                for r in s:
                    x = agg.setdefault(r["gpu"], {"util": 0.0, "ded": 0.0})
                    x["util"] += r["utilPct"]
                    x["ded"] = max(x["ded"], r["dedicatedMiB"])
            used = max(agg.items(), key=lambda kv: (kv[1]["util"], kv[1]["ded"]))[0] if agg else None
            results.append({"mode": label, "setting": ui, "measuredGpu": used, "perGpu": agg, "samples": samples})
            print(f"{label:22s} → 介面實際使用：{used}   {json.dumps(agg, ensure_ascii=False)}", flush=True)
        finally:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
            time.sleep(3)
    cli(a.exe, "settings-set", "--json", json.dumps({"hw": {**info["prefs"], "uiGpu": "auto"}}))
    OUT.write_text(json.dumps({"assignment": info["assignment"]["ui"], "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    with gpu_lease("驗證：介面 GPU"):
        main()
