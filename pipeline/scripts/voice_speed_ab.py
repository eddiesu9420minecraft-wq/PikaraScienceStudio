# 旁白加速方法 A/B：同一批句子，比較字/秒、Whisper 字元錯誤率、音高、完整性檢查。原始檔只讀不改。
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/voice_speed_ab.py --seq ep15 --src src_cn --root <PROJECT_DIR> --target-cps 4.4
# 變體：A 原始（speed 1.0）｜B rubberband 保留音高伸縮到目標｜C atempo（WSOLA）伸縮到目標｜D CosyVoice speed=目標倍率（頻譜內插，舊做法）
#       E CosyVoice speed 1.15（產生器上限）｜F CosyVoice 指令「稍快的語速」（模型本身說快，不做訊號處理）
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_voiceover_cosy as g  # noqa: E402
from audio_integrity import analyze  # noqa: E402
from voice_speed_check import decode, median_f0, units  # noqa: E402
from voice_tempo import stretch_file  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
INSTRUCT = "You are a helpful assistant. 请用稍快、有活力的语速说这句话。<|endofprompt|>"


def measure(path: Path, text: str, speak: str, f0_ref: float | None) -> dict:
    x = decode(path, sr=16000)
    dur = len(x) / 16000
    words = g.transcribe_words(path)
    _, st = g.align(speak, words)
    f0 = median_f0(x)
    w24 = decode(path, sr=24000)
    chk = analyze(w24, 24000, speak, "zh")
    return {"sec": round(dur, 2), "cps": round(units(text) / dur, 2), "cer": round(float(st.get("cer", 1.0)), 3), "asr": st.get("asr"),
            "f0": round(f0, 1) if f0 else None, "pitch": round(f0 / f0_ref, 3) if f0 and f0_ref else None, "integrity": chk["problems"] or "OK"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", required=True)
    ap.add_argument("--src", default="src_cn")
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--lines", type=int, default=6)
    ap.add_argument("--target-cps", type=float, default=4.4)
    ap.add_argument("--no-gpu", action="store_true", help="只做 A/B/C（不載入 CosyVoice）")
    a = ap.parse_args()
    root = Path(a.root)
    out = ROOT / "out" / "voice_speed" / f"ab_{a.seq}"
    out.mkdir(parents=True, exist_ok=True)
    tl = json.loads((root / a.src / "data" / "timeline.generated.json").read_text(encoding="utf-8"))[a.seq]["lines"]
    idx = sorted(set(np.linspace(0, len(tl) - 1, a.lines).round().astype(int)))
    lines = [tl[i] for i in idx]
    rows = {}
    for ln in lines:
        src = root / "public" / ln["audio"]
        raw_cps = units(ln["subtitle"]) / ln["duration"]
        tempo = round(a.target_cps / raw_cps, 3)
        rows[ln["id"]] = {"tempo": tempo, "src": src, "speak": ln.get("speak") or ln["subtitle"], "text": ln["subtitle"]}
        stretch_file(src, out / f"{ln['id']}.B_rubberband.mp3", tempo)
        stretch_file(src, out / f"{ln['id']}.B2_rubberband_default.mp3", tempo, variant="default")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", f"atempo={tempo}", "-ar", "24000", "-c:a", "libmp3lame", "-q:a", "2",
                        str(out / f"{ln['id']}.C_atempo.mp3")], check=True, timeout=60)
    if not a.no_gpu:
        sys.path.insert(0, str(g.COSY))
        sys.path.insert(0, str(g.COSY / "third_party" / "Matcha-TTS"))
        import torch
        from cosyvoice.cli.cosyvoice import AutoModel
        ref_dir = g.COSY / ("reference_cn" if a.src == "src_cn" else "reference")
        ref, ref_text = ref_dir / "reference.wav", (ref_dir / "reference.txt").read_text(encoding="utf-8").strip()
        cosy = AutoModel(model_dir=str(g.MODEL_DIR), fp16=True)
        cosy.model.llm.half()
        cosy.model.flow.half()
        cosy.add_zero_shot_spk(g.PROMPT_PREFIX + ref_text, str(ref), "pikara_ref")
        for lid, r in rows.items():
            for tag, kw in (("D_cosy_speed", {"speed": r["tempo"]}), ("E_cosy_1.15", {"speed": 1.15}), ("F_instruct", None)):
                torch.manual_seed(1986)
                with torch.inference_mode():
                    if kw is None:
                        it = cosy.inference_instruct2(r["speak"], INSTRUCT, str(ref), stream=False)
                    else:
                        it = cosy.inference_zero_shot(r["speak"], "", "", zero_shot_spk_id="pikara_ref", stream=False, **kw)
                    w = torch.cat([o["tts_speech"] for o in it], dim=1).float().cpu()[0]
                g.encode_mp3(w, cosy.sample_rate, out / f"{lid}.{tag}.mp3")
                print(lid, tag, "ok", flush=True)
        del cosy
        torch.cuda.empty_cache()
    report = {}
    for lid, r in rows.items():
        a_m = measure(r["src"], r["text"], r["speak"], None)
        f0 = a_m["f0"]
        a_m["pitch"] = 1.0
        rep = {"A_original": a_m}
        for p in sorted(out.glob(f"{lid}.*.mp3")):
            rep[p.stem.split(".", 1)[1]] = measure(p, r["text"], r["speak"], f0)
        report[lid] = {"tempo": r["tempo"], "variants": rep}
        for k, v in rep.items():
            print(f"{lid} {k:14s} {v['sec']:5.2f}s {v['cps']:4.2f}字/s CER {v['cer']:.3f} 音高×{v['pitch']} {v['integrity']} | {v['asr']}", flush=True)
    agg = {}
    for lid, r in report.items():
        for k, v in r["variants"].items():
            agg.setdefault(k, []).append(v)
    summary = {k: {"cps": round(float(np.median([x["cps"] for x in v])), 2), "cerMean": round(float(np.mean([x["cer"] for x in v])), 3),
                   "pitchMedian": round(float(np.median([x["pitch"] for x in v if x["pitch"]])), 3),
                   "integrityFails": sum(1 for x in v if x["integrity"] != "OK")} for k, v in agg.items()}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    (out / "report.json").write_text(json.dumps({"summary": summary, "lines": report, "targetCps": a.target_cps}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
