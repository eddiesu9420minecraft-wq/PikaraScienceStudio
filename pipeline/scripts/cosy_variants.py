"""Try several `speak` spellings / speeds per line in ONE process (CosyVoice loaded once), Whisper-check,
install the winner into voiceover_cosy/ep01 and update narration.json (speak / cosySpeed).
tools\\CosyVoice\\.venv\\Scripts\\python.exe scripts\\cosy_variants.py"""
import json, shutil, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import generate_voiceover_cosy as g  # noqa: E402

VARIANTS = {
    "a4-15": {"term": "gguf", "speak": ["這些量化後的權重，常常用 G G U F 格式儲存。", "這些量化後的權重，常常用 GGUF 格式儲存。", "這些量化後的權重，常常用 G-G-U-F 格式儲存。"]},
    "a3-00": {"term": "gb", "speak": ["一個模型檔案動輒好幾 GB。裡面裝的，到底是什麼？", "一個模型檔案動輒好幾 G B。裡面裝的，到底是什麼？", "一個模型檔案動輒好幾 G-B。裡面裝的，到底是什麼？"]},
    "a4-08": {"term": "int8", "speak": ["INT 8 每個數字用 8 個位元，誤差很小；4 位元的量化，大小只剩 F P 16 的四分之一左右，誤差也跟著變大。",
                                         "int8 每個數字用 8 個位元，誤差很小；4 位元的量化，大小只剩 F P 16 的四分之一左右，誤差也跟著變大。",
                                         "I N T 8 每個數字用 8 個位元，誤差很小；4 位元的量化，大小只剩 F P 16 的四分之一左右，誤差也跟著變大。"]},
    "a1-00": {"term": None, "speeds": [1.0, 1.2, 1.35]},
}
TARGET_CPS = 3.7  # 本集其他句子的平均語速


def canon(s: str) -> str:
    return g.norm(s).replace("-", "")


def cer(ref: str, hyp: str) -> float:
    d = list(range(len(hyp) + 1))
    for i, ca in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[len(hyp)] / max(1, len(ref))


def main():
    import torch
    sys.path.insert(0, str(g.COSY)); sys.path.insert(0, str(g.COSY / "third_party" / "Matcha-TTS"))
    from cosyvoice.cli.cosyvoice import AutoModel
    data = json.loads(g.NARRATION.read_text(encoding="utf-8"))
    lines = {ln["id"]: (sc["id"], ln) for sc in data["sequences"]["ep01"]["scenes"] for ln in sc["lines"]}
    ref, ref_text = g.DEF_REF, g.DEF_REF_TXT.read_text(encoding="utf-8").strip()
    voice = {"engine": "cosyvoice3", "model": "Fun-CosyVoice3-0.5B-2512", "mode": "zero_shot",
             "reference": ref.relative_to(g.ROOT).as_posix(), "reference_sha": g.sha_file(ref), "reference_text": ref_text,
             "speed": 1.0, "precision": "fp16"}
    g.wait_for_gpu()
    cosy = AutoModel(model_dir=str(g.MODEL_DIR), fp16=True)
    cosy.model.llm.half(); cosy.model.flow.half()
    cosy.add_zero_shot_spk(g.PROMPT_PREFIX + ref_text, str(ref), "pikara_ref")
    vdir = g.OUT_DIR / "_variants"; vdir.mkdir(parents=True, exist_ok=True)
    results = {}
    for lid, spec in VARIANTS.items():
        sc, ln = lines[lid]
        base = ln.get("speak") or ln["subtitle"]
        trials = [(s, 1.0) for s in spec.get("speak", [])] or [(base, sp) for sp in spec["speeds"]]
        cands = []
        for k, (speak, speed) in enumerate(trials):
            with torch.inference_mode():
                wav = torch.cat([o["tts_speech"] for o in cosy.inference_zero_shot(speak, "", "", zero_shot_spk_id="pikara_ref", stream=False, speed=speed)], dim=1).float().cpu()[0]
            mp3 = vdir / f"{lid}_v{k}.mp3"
            err = g.encode_mp3(wav, cosy.sample_rate, mp3)
            if err:
                print("  ✗", lid, k, err); continue
            words = g.transcribe_words(mp3)
            hyp = canon("".join(w for w, _, _ in words))
            c = cer(canon(speak), hyp)
            dur = g.ffprobe(mp3)["duration"]
            cps = len(canon(speak)) / dur
            ok = spec["term"] is None or spec["term"] in hyp
            cands.append({"k": k, "speak": speak, "speed": speed, "cer": round(c, 3), "term_ok": ok, "dur": round(dur, 2), "cps": round(cps, 2), "asr": hyp, "mp3": mp3, "words": words})
            print(f"  {lid} v{k} speed={speed} CER={c:.3f} term={ok} {dur:.2f}s {cps:.2f}字/s | {speak} → {hyp}", flush=True)
        if spec["term"] is None:
            good = [c for c in cands if c["cer"] <= 0.1] or cands
            win = min(good, key=lambda c: abs(c["cps"] - TARGET_CPS))
        else:
            win = min(cands, key=lambda c: (not c["term_ok"], c["cer"]))
        results[lid] = win
        # 安裝勝出版本
        out = g.OUT_DIR / "ep01"
        shutil.copyfile(win["mp3"], out / f"{lid}.mp3")
        pr = g.ffprobe(out / f"{lid}.mp3")
        bnd, st = g.align(win["speak"], win["words"])
        meta = {"id": lid, "scene": sc, "seq": "ep01", "key": g.make_key(win["speak"], voice, win["speed"]), "voice": {**voice, "speed": win["speed"]},
                "subtitle": ln["subtitle"], "speak": win["speak"], "file": f"assets/audio/voiceover_cosy/ep01/{lid}.mp3",
                "duration": round(pr["duration"], 4), "codec": pr["codec"], "sample_rate": pr["sample_rate"], "boundaries": bnd,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "engine": "cosyvoice3",
                "alignment": {"engine": f"faster-whisper {g.ASR_MODEL} + difflib", **st}, "variant_choice": {k: v for k, v in win.items() if k not in ("mp3", "words")}}
        (out / f"{lid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        # narration.json：subtitle 不變；speak 與字幕相同時不寫 speak
        if win["speak"] != base:
            ln["speak"] = win["speak"]
        if win["speed"] != 1.0:
            ln["cosySpeed"] = win["speed"]
        else:
            ln.pop("cosySpeed", None)
    g.NARRATION.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n勝出：")
    for lid, w in results.items():
        print(f"  {lid}: v{w['k']} speed={w['speed']} CER={w['cer']} {w['cps']}字/s 「{w['speak']}」")
    del cosy
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
