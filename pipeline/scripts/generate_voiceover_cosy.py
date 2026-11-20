"""
Pikara Science — CosyVoice 3 (Fun-CosyVoice3-0.5B) 本機旁白產生器（zero-shot，無訓練）

用 CosyVoice 的 venv 執行：
  tools\\CosyVoice\\.venv\\Scripts\\python.exe scripts\\generate_voiceover_cosy.py --seq ep01
  ... --test a1-00 a4-09 a6-06            # 只產生測試句到 voiceover_cosy/_test/
  ... --ref other.wav --ref-text "逐字稿"   # 換參考音（或 --ref-text-file）
  ... --align-only                         # 只重做對齊（不載入 TTS 模型）

- 模型只載入一次；逐句依序產生；FP16（--fp32 可退回）。
- 快取：sha256(朗讀文字 + 參考音內容 + 參考逐字稿 + 設定 + 版本)；沒變就跳過。
- 輸出 public/assets/audio/voiceover_cosy/<seq>/<id>.mp3 + .json（格式同 Edge 產生器）。
- 時間邊界：faster-whisper（CPU）字級時間戳，再對齊到已知文字，輸出 WordBoundary（逐字）。
- GPU 協調：推論前若偵測到 Remotion 算圖（chrome-headless-shell 或 VRAM > 3GB）就等待。
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")  # 只用 NVIDIA RTX 4050（不用內顯）

ROOT = Path(__file__).resolve().parent.parent
COSY = ROOT / "tools" / "CosyVoice"
NARRATION = ROOT / "src" / "data" / "narration.json"
OUT_DIR = ROOT / "public" / "assets" / "audio" / "voiceover_cosy"
DEF_REF = COSY / "reference" / "reference.wav"
DEF_REF_TXT = COSY / "reference" / "reference.txt"
MODEL_DIR = COSY / "pretrained_models" / "Fun-CosyVoice3-0.5B"
ASR_MODEL = os.environ.get("PIKARA_ASR_MODEL", "large-v3-turbo")
GENERATOR_VERSION = "pikara-cosy-v1"
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"
PUNCT = "，。？！；：、,.?!;:「」『』（）() "

sys.stdout.reconfigure(encoding="utf-8")


def norm(s: str) -> str:
    return "".join(ch for ch in s if ch not in PUNCT and not ch.isspace()).lower()


def ffprobe(path: Path) -> dict | None:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate",
                            "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return None
        info = json.loads(r.stdout)
        st = info.get("streams") or []
        dur = float(info.get("format", {}).get("duration", 0) or 0)
        if not st or dur <= 0:
            return None
        return {"duration": dur, "codec": st[0].get("codec_name"), "sample_rate": int(st[0].get("sample_rate", 0))}
    except Exception:
        return None


# ---------------- GPU 協調 ----------------
def gpu_used_mb() -> int:
    r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True)
    try:
        return int(r.stdout.strip().splitlines()[0])
    except Exception:
        return 0


def render_running() -> bool:
    r = subprocess.run(["tasklist"], capture_output=True, text=True, errors="replace")
    return "chrome-headless-shell" in r.stdout.lower()


def wait_for_gpu(own_mb: int = 0, max_min: int = 40) -> None:
    t0 = time.time()
    while True:
        busy = render_running() or (gpu_used_mb() - own_mb) > 3000
        if not busy:
            return
        if time.time() - t0 > max_min * 60:
            raise SystemExit("[停止] GPU 被 Remotion 算圖佔用超過 40 分鐘，稍後再執行（已完成的句子都已保存）。")
        print(f"  … 偵測到算圖或 VRAM>3GB（{gpu_used_mb()} MiB），60 秒後再檢查", flush=True)
        time.sleep(60)


def gpu_temp() -> int:
    r = subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True)
    try:
        return int(float(r.stdout.strip().splitlines()[0]))
    except Exception:
        return 0


def encode_mp3(wav, sr: int, dst: Path) -> str:
    """記憶體中的 float32 PCM 直接 pipe 給 ffmpeg 編成 MP3（不寫中間 WAV）。"""
    pcm = wav.clamp(-1, 1).numpy().astype("float32").tobytes()
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
                        "-c:a", "libmp3lame", "-b:a", "160k", "-f", "mp3", str(dst)], input=pcm, capture_output=True)
    return "" if r.returncode == 0 else r.stderr.decode("utf-8", "replace")[-300:]


class VramSampler:
    def __init__(self):
        self.peak = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.peak = max(self.peak, gpu_used_mb())
            self._stop.wait(0.5)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()


# ---------------- 對齊（faster-whisper，CPU） ----------------
_asr = None
_cc = None


def asr_model():
    global _asr, _cc
    if _asr is None:
        from faster_whisper import WhisperModel
        import opencc
        local = COSY / "pretrained_models" / "whisper" / ASR_MODEL
        if not (local / "model.bin").exists():
            from huggingface_hub import snapshot_download  # Windows 無 symlink 權限：直接下載到一般資料夾
            snapshot_download(f"mobiuslabsgmbh/faster-whisper-{ASR_MODEL}" if ASR_MODEL == "large-v3-turbo" else f"Systran/faster-whisper-{ASR_MODEL}", local_dir=str(local))
        dev = os.environ.get("PIKARA_ASR_DEVICE", "cuda")
        for d, ct in ((dev, "float16"), (dev, "int8_float16"), ("cpu", "int8")):
            try:
                _asr = WhisperModel(str(local), device=d, compute_type=ct, cpu_threads=8)
                print(f"ASR：{ASR_MODEL} {d} {ct}", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  ASR {d}/{ct} 無法使用：{e}", flush=True)
        _cc = opencc.OpenCC(os.environ.get("PIKARA_ASR_CC", "s2twp"))  # zh-CN 用 t2s
    return _asr


def transcribe_words(path: Path) -> list[tuple[str, float, float]]:
    m = asr_model()
    segs, _ = m.transcribe(str(path), language="zh", word_timestamps=True, beam_size=5, vad_filter=False,
                           condition_on_previous_text=False)
    words = []
    for s in segs:
        for w in s.words or []:
            words.append((_cc.convert(w.word), float(w.start), float(w.end)))
    return words


def align(speak: str, words: list[tuple[str, float, float]]) -> tuple[list[dict], dict]:
    """把 ASR 字級時間對到已知文字；回傳逐字 WordBoundary（只輸出有對上的字）與統計。"""
    target = norm(speak)
    hyp_chars, hyp_t = [], []
    for w, s, e in words:
        nw = norm(w)
        for k, ch in enumerate(nw):
            span = (e - s) / max(1, len(nw))
            hyp_chars.append(ch)
            hyp_t.append((s + span * k, s + span * (k + 1)))
    hyp = "".join(hyp_chars)
    sm = difflib.SequenceMatcher(None, target, hyp, autojunk=False)
    times: list[tuple[float, float] | None] = [None] * len(target)
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            times[a + k] = hyp_t[b + k]
    # 字元錯誤率（Levenshtein）
    d = list(range(len(hyp) + 1))
    for i, ca in enumerate(target, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
            prev, d[j] = d[j], cur
    cer = d[len(hyp)] / max(1, len(target))
    bnd = [{"type": "WordBoundary", "text": target[i], "start": round(t[0], 3), "end": round(t[1], 3)}
           for i, t in enumerate(times) if t is not None]
    # build_timeline 以 norm(text) 尋找，需用原字（保留大小寫無妨，norm 會轉小寫）
    stats = {"matched": sum(t is not None for t in times), "total": len(target), "cer": round(cer, 4), "asr": hyp}
    return bnd, stats


# ---------------- 主流程 ----------------
def make_key(speak: str, voice: dict, speed: float) -> str:
    """快取鍵；narration.json 的單句 cosySpeed 會覆寫全域 --speed。"""
    v = {k: voice[k] for k in ("model", "mode", "reference_sha", "reference_text", "precision")}
    v["speed"] = speed
    p = json.dumps({"t": speak, "v": v, "g": GENERATOR_VERSION}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(p.encode("utf-8")).hexdigest()[:16]


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def load_lines(seq: str) -> list[tuple[str, dict]]:
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    return [(sc["id"], ln) for sc in data["sequences"][seq]["scenes"] for ln in sc["lines"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", default="ep01")
    ap.add_argument("--test", nargs="*", help="只產生指定句子到 _test/")
    ap.add_argument("--only", nargs="*", help="只產生指定句子 ID")
    ap.add_argument("--ref", default=str(DEF_REF))
    ap.add_argument("--ref-text")
    ap.add_argument("--ref-text-file", default=str(DEF_REF_TXT))
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--target-cps", type=float, help="以 2 句校準 speed，使語速接近此值（字/秒）")
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--align-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--narration", help="narration.json 路徑（例：src_cn/data/narration.json）")
    ap.add_argument("--out-root", help="輸出根目錄（例：public/assets/audio/voiceover_cosy_cn）")
    ap.add_argument("--out", help="覆寫輸出資料夾（相對 voiceover_cosy/）")
    a = ap.parse_args()

    global NARRATION, OUT_DIR
    if a.narration:
        NARRATION = (ROOT / a.narration).resolve()
    if a.out_root:
        OUT_DIR = (ROOT / a.out_root).resolve()
    ref = Path(a.ref).resolve()
    ref_text = a.ref_text or Path(a.ref_text_file).read_text(encoding="utf-8").strip()
    voice = {"engine": "cosyvoice3", "model": "Fun-CosyVoice3-0.5B-2512", "mode": "zero_shot",
             "reference": ref.relative_to(ROOT).as_posix() if ref.is_relative_to(ROOT) else str(ref),
             "reference_sha": sha_file(ref), "reference_text": ref_text, "speed": a.speed,
             "precision": "fp32" if a.fp32 else "fp16"}
    lines = load_lines(a.seq)
    if a.test is not None:
        ids = set(a.test)
        lines = [x for x in lines if x[1]["id"] in ids]
        out = OUT_DIR / "_test"
    else:
        if a.only:
            lines = [x for x in lines if x[1]["id"] in set(a.only)]
        out = OUT_DIR / a.seq
    if a.out:
        out = OUT_DIR / a.out
    out.mkdir(parents=True, exist_ok=True)

    def key(speak: str, speed: float | None = None) -> str:
        return make_key(speak, voice, a.speed if speed is None else speed)

    def cached(lid: str, k: str) -> bool:
        mp3, mj = out / f"{lid}.mp3", out / f"{lid}.json"
        if a.force or not mp3.exists() or not mj.exists():
            return False
        try:
            meta = json.loads(mj.read_text(encoding="utf-8"))
        except Exception:
            return False
        pr = ffprobe(mp3)
        return meta.get("key") == k and pr is not None and abs(pr["duration"] - meta.get("duration", -1)) < 0.05

    todo = [(sc, ln) for sc, ln in lines if not cached(ln["id"], key(ln.get("speak") or ln["subtitle"], ln.get("cosySpeed")))]
    print(f"共 {len(lines)} 句，需要產生 {len(todo)} 句 → {out.relative_to(ROOT)}")

    cosy = None
    stats_all = []
    logd = COSY / "logs"
    logd.mkdir(exist_ok=True)
    gpulog = logd / f"gpu_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    smi = subprocess.Popen(["nvidia-smi", "--query-gpu=timestamp,memory.used,utilization.gpu,temperature.gpu,power.draw,clocks_throttle_reasons.active",
                            "--format=csv", "-l", "5", "-f", str(gpulog)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return _run(a, lines, todo, out, key, voice, ref, ref_text)
    finally:
        smi.terminate()


def _run(a, lines, todo, out, key, voice, ref, ref_text) -> int:
    cosy = None
    stats_all = []
    if todo and not a.align_only:
        wait_for_gpu()
        sys.path.insert(0, str(COSY))
        sys.path.insert(0, str(COSY / "third_party" / "Matcha-TTS"))
        import torch
        import torchaudio
        from cosyvoice.cli.cosyvoice import AutoModel
        t0 = time.time()
        cosy = AutoModel(model_dir=str(MODEL_DIR), fp16=not a.fp32)
        if not a.fp32:  # 官方 fp16 只開 autocast，權重仍是 fp32；直接轉成 half 省 VRAM、避免溢出到共享記憶體
            cosy.model.llm.half()
            if os.environ.get("PIKARA_FLOW_HALF", "1") == "1":
                cosy.model.flow.half()
        torch.backends.cudnn.benchmark = True
        print("裝置：llm", next(cosy.model.llm.parameters()).device, next(cosy.model.llm.parameters()).dtype,
              "flow", next(cosy.model.flow.parameters()).device, "hift", next(cosy.model.hift.parameters()).device, flush=True)
        perf_log = ROOT / "out" / "cosy_perf.log"
        perf_log.parent.mkdir(exist_ok=True)
        cosy.add_zero_shot_spk(PROMPT_PREFIX + ref_text, str(ref), "pikara_ref")  # 參考音特徵只算一次
        torch.cuda.empty_cache()
        print(f"模型載入 {time.time() - t0:.1f}s，precision={voice['precision']}，VRAM {gpu_used_mb()} MiB", flush=True)
        prompt_text = PROMPT_PREFIX + ref_text
        if a.target_cps:  # 用 2 句校準全域 speed（之後所有句子固定使用）
            cal = sorted(todo, key=lambda x: -len(norm(x[1].get("speak") or x[1]["subtitle"])))[:2]
            sp = 1.0
            for it in range(2):
                n_chars, secs = 0, 0.0
                for _, ln in cal:
                    t = ln.get("speak") or ln["subtitle"]
                    with torch.inference_mode():
                        w = torch.cat([o["tts_speech"] for o in cosy.inference_zero_shot(t, "", "", zero_shot_spk_id="pikara_ref", stream=False, speed=sp)], dim=1)
                    n_chars += len(norm(t)); secs += w.shape[1] / cosy.sample_rate
                cps = n_chars / secs
                print(f"校準 {it + 1}：speed={sp:.2f} → {cps:.2f} 字/s", flush=True)
                sp = round(max(0.8, min(2.0, sp * a.target_cps / cps)), 2)
            a.speed = sp
            voice["speed"] = sp
            print(f"固定 speed={sp}（重跑時請加 --speed {sp}）", flush=True)
        for sc, ln in todo:
            lid = ln["id"]
            speak = ln.get("speak") or ln["subtitle"]
            mp3, mj = out / f"{lid}.mp3", out / f"{lid}.json"
            part_wav, part_mp3 = out / f"{lid}.part.wav", out / f"{lid}.part.mp3"
            wait_for_gpu(own_mb=torch.cuda.memory_reserved() // 2**20 + 600)
            while gpu_temp() >= 87:  # 過熱就暫停，不改任何時脈／功耗設定
                print(f"  … GPU {gpu_temp()}°C，暫停 20 秒降溫", flush=True)
                time.sleep(20)
            try:
                t1 = time.time()
                for attempt in (1, 2):
                    try:
                        with VramSampler() as vs, torch.inference_mode():
                            chunks = [o["tts_speech"] for o in cosy.inference_zero_shot(speak, prompt_text, str(ref), zero_shot_spk_id="pikara_ref", stream=False, speed=ln.get("cosySpeed", a.speed))]
                        break
                    except torch.cuda.OutOfMemoryError:
                        torch.cuda.empty_cache()
                        if attempt == 2:
                            raise
                        print(f"  … {lid} CUDA OOM，清快取 10 秒後重試", flush=True)
                        time.sleep(10)
                wav = torch.cat(chunks, dim=1).float().cpu()[0]
                el = time.time() - t1
                err = encode_mp3(wav, cosy.sample_rate, part_mp3)
                pr = ffprobe(part_mp3) if not err else None
                if pr is None or pr["duration"] < 0.3:
                    raise RuntimeError("ffprobe 驗證失敗 " + err)
                part_mp3.replace(mp3)
                audio_s = wav.shape[0] / cosy.sample_rate
                meta = {"id": lid, "scene": sc, "seq": a.seq, "key": key(speak, ln.get("cosySpeed")), "voice": {**voice, "speed": ln.get("cosySpeed", a.speed)}, "subtitle": ln["subtitle"],
                        "speak": speak, "file": mp3.relative_to(ROOT / "public").as_posix(), "duration": round(pr["duration"], 4),
                        "codec": pr["codec"], "sample_rate": pr["sample_rate"], "boundaries": [],
                        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "engine": "cosyvoice3",
                        "perf": {"seconds": round(el, 2), "rtf": round(el / audio_s, 3), "vram_peak_mib": vs.peak}}
                mj.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                smi = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,temperature.gpu", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
                msg = f"{time.strftime('%H:%M:%S')} {lid} audio={pr['duration']:.2f}s wall={el:.1f}s RTF={el / audio_s:.2f} peakVRAM={vs.peak}MiB gpu[util,mem,temp]={smi}"
                print("  ✓ " + msg, flush=True)
                with open(perf_log, "a", encoding="utf-8") as f:
                    f.write(msg + chr(10))
            except Exception as e:  # noqa: BLE001
                for p in (mp3, mj):
                    p.unlink(missing_ok=True)
                print(f"  ✗ {lid} 失敗：{type(e).__name__}: {e}", flush=True)
            finally:
                part_wav.unlink(missing_ok=True)
                part_mp3.unlink(missing_ok=True)
        del cosy
        import gc
        gc.collect()
        torch.cuda.empty_cache()

    # 對齊：沒有 boundaries 或 --align-only 的句子
    need_align = []
    for sc, ln in lines:
        mj = out / f"{ln['id']}.json"
        if mj.exists():
            meta = json.loads(mj.read_text(encoding="utf-8"))
            if a.align_only or not meta.get("boundaries"):
                need_align.append((ln, mj, meta))
    if need_align:
        print(f"對齊 {len(need_align)} 句（faster-whisper {ASR_MODEL}，CPU int8）")
    bad_anchor = []
    for ln, mj, meta in need_align:
        bnd, st = align(meta["speak"], transcribe_words(mj.with_suffix(".mp3")))
        meta["boundaries"] = bnd
        meta["alignment"] = {"engine": f"faster-whisper {ASR_MODEL} + difflib", **st}
        mj.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tgt = norm(meta["speak"])
        covered = {b["start"] for b in bnd}
        matched_idx = set()
        pos = 0
        for b in bnd:
            i = tgt.find(norm(b["text"]), pos)
            if i >= 0:
                matched_idx.add(i)
                pos = i + 1
        for name, word in (ln.get("anchors") or {}).items():
            i = tgt.find(norm(word))
            if i < 0 or not any(j in matched_idx for j in range(i, i + len(norm(word)))):
                bad_anchor.append(f"{ln['id']}:{name}「{word}」")
        stats_all.append((ln["id"], st))
        print(f"  ≡ {ln['id']} 對上 {st['matched']}/{st['total']} 字  CER {st['cer']:.3f}", flush=True)
    if bad_anchor:
        print("  ! 錨點詞沒有對上任何 ASR 字（會用內插時間）：" + "、".join(bad_anchor))
    missing = [ln["id"] for _, ln in lines if not (out / f"{ln['id']}.mp3").exists()]
    noalign = [ln["id"] for _, ln in lines if (out / f"{ln['id']}.json").exists()
               and not json.loads((out / f"{ln['id']}.json").read_text(encoding="utf-8")).get("boundaries")]
    print(f"\n完成：{len(lines) - len(missing)}/{len(lines)} 句有音檔，{len(noalign)} 句缺少邊界。" + (f" 缺：{missing}" if missing else ""))
    return 1 if missing or noalign else 0


if __name__ == "__main__":
    sys.exit(main())
