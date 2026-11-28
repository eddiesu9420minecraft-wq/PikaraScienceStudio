"""One CosyVoice 3 line for the A/B harness (scripts/voice_ab.py), with the production settings of
generate_voiceover_cosy.py: same model, prompt prefix, per-line seed, zero-shot call and pronunciation dictionary —
only the device differs.

    python scripts/tts_cli_cosy.py --device cpu|mps --text-file t.txt --out line.wav --ref ref.wav --ref-text-file ref.txt
                                   [--cosy <tools/CosyVoice>] [--seed 20261122] [--locale zh-TW]

Writes <out>.json next to the WAV: device actually used, load seconds, synthesis seconds, audio seconds.
MPS: the model is moved to the Apple GPU; PYTORCH_ENABLE_MPS_FALLBACK=1 lets unsupported operators run on the CPU.
Development tool (not shipped into projects; see pipeline_sync NOT_SHIPPED).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--ref-text-file", required=True)
    ap.add_argument("--cosy", default=str(HERE.parent / "tools" / "CosyVoice"))
    ap.add_argument("--seed", type=int, default=20261122)
    ap.add_argument("--locale", default="zh-TW")
    a = ap.parse_args()

    cosy_dir = Path(a.cosy)
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(cosy_dir))
    sys.path.insert(0, str(cosy_dir / "third_party" / "Matcha-TTS"))
    from pronunciation import PronunciationEngine, lang_for  # noqa: E402

    text = Path(a.text_file).read_text(encoding="utf-8").strip()
    ref_text = Path(a.ref_text_file).read_text(encoding="utf-8").strip()
    pron = PronunciationEngine(lang_for("zh", "t2s" if a.locale == "zh-CN" else None))
    tts, _ = pron.apply(text)

    import torch  # noqa: E402
    import torchaudio  # noqa: E402
    from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402

    t0 = time.time()
    cosy = AutoModel(model_dir=str(cosy_dir / "pretrained_models" / "Fun-CosyVoice3-0.5B"), fp16=False)
    dev = "cpu"
    if a.device == "mps":
        if not (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()):
            print("MPS 不可用", flush=True)
            return 3
        m = torch.device("mps")
        cosy.model.device = m
        # LLM + flow (most of the compute) on the Apple GPU. The HiFi-GAN vocoder stays on the CPU unchanged: its F0
        # predictor deliberately runs in float64 ("precision is crucial", CosyVoice's own comment), which MPS does not
        # support (measured on the Mac mini M2) — forcing float32 there could change the voice, so it is not done.
        for part in (cosy.model.llm, cosy.model.flow):
            part.to(m)
        hift_inference = cosy.model.hift.inference

        def hift_on_cpu(*args, **kw):
            args = tuple(x.cpu() if torch.is_tensor(x) else x for x in args)
            kw = {k: (v.cpu() if torch.is_tensor(v) else v) for k, v in kw.items()}
            return hift_inference(*args, **kw)

        cosy.model.hift.inference = hift_on_cpu
        dev = "mps"
    load_s = time.time() - t0
    lid = Path(a.out).stem
    torch.manual_seed(a.seed + zlib.crc32(lid.encode("utf-8")) % 1_000_000)
    t1 = time.time()
    with torch.inference_mode():
        chunks = [o["tts_speech"] for o in cosy.inference_zero_shot(tts, PROMPT_PREFIX + ref_text, a.ref, stream=False, speed=1.0)]
    wav = torch.cat(chunks, dim=1).float().cpu()
    synth_s = time.time() - t1
    torchaudio.save(a.out, wav, cosy.sample_rate)
    info = {"device": dev, "loadS": round(load_s, 2), "synthS": round(synth_s, 2), "audioS": round(wav.shape[1] / cosy.sample_rate, 2),
            "mpsFallback": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK"), "torch": torch.__version__, "ttsText": tts}
    Path(a.out + ".json").write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
