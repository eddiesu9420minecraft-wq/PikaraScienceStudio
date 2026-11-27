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
import re
import shutil
import os
import subprocess
import sys
import threading
import time
import zlib
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pronunciation import PronunciationEngine, lang_for  # noqa: E402  英文術語 → TTS 朗讀文字（不改字幕）
from audio_integrity import analyze as audio_check  # noqa: E402  每句輸出的完整性檢查
from tts_watchdog import GpuLogger, Watchdog, env_secs  # noqa: E402  心跳、階段上限、不留子程序的 GPU 記錄

# 心跳＋階段上限（見 tts_watchdog.py）。上限都可用環境變數調整；設 0 關閉該項上限。
WD = Watchdog()
LOAD_LIMIT = env_secs("PIKARA_TTS_LOAD_TIMEOUT", 900)       # CosyVoice／Whisper 載入（實測 14–182 秒，系統忙時最慢）
ALIGN_LIMIT = env_secs("PIKARA_TTS_ALIGN_TIMEOUT", 300)     # 每句 Whisper 對齊（實測 < 5 秒）


# 測試用故障注入（預設關閉）：PIKARA_TTS_FAULT="hang:<id>,crash:<id>,oom:<id>[:次數],ffmpeg:<id>"
_FAULTS = {}
for _f in filter(None, os.environ.get("PIKARA_TTS_FAULT", "").split(",")):
    _k, _, _rest = _f.partition(":")
    _lid, _, _n = _rest.partition(":")
    _FAULTS[_lid] = (_k, int(_n or 1))


def fault_for(lid: str) -> str | None:
    return _FAULTS.get(lid, (None,))[0]


def inject_fault(lid: str, attempt: int, torch) -> None:
    kind, n = _FAULTS.get(lid, (None, 0))
    if kind == "hang":
        print(f"  （測試注入：{lid} 推論無回應）", flush=True)
        while True:
            time.sleep(1)
    if kind == "crash":
        print(f"  （測試注入：{lid} 程序崩潰）", flush=True)
        os._exit(9)
    if kind == "oom" and attempt <= n:
        print(f"  （測試注入：{lid} CUDA OOM，第 {attempt} 次）", flush=True)
        raise torch.cuda.OutOfMemoryError("simulated OOM (PIKARA_TTS_FAULT)")


# 這次執行中合成失敗的句子（即使保留了上一次的音檔也算失敗：要求重做的句子沒有重做成功，結束碼必須非 0）
FAILED_LINES: set[str] = set()


def line_limit(units: int) -> float:
    """每句合成上限：240 秒＋每字 10 秒（實測 RTF 1.2–1.4，30 字約 8 秒；含 3 次完整性重試與 OOM 重試仍遠低於此）。"""
    v = env_secs("PIKARA_TTS_LINE_TIMEOUT", -1)
    return v if v >= 0 else 240 + 10 * units
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"
PUNCT = "，。？！；：、,.?!;:「」『』（）() "

sys.stdout.reconfigure(encoding="utf-8")


# CosyVoice 的 speed 是把 mel 頻譜做線性內插壓縮（cosyvoice/cli/model.py：F.interpolate(size=len/speed)），
# 不是自然的快語速：speed 1.66 會丟掉約 40% 的聲學幀，聲母韻母被抹糊、聽起來卡頓像機器。
# 校準與手動語速都限制在這個範圍內；要更快的節奏請縮短句子或停頓，不要拉高 speed。
SPEED_MIN, SPEED_MAX = 0.85, 1.15
# TTS 會照字念錯的寫法（例如 tw2sp 把簡體「什么」轉成「什幺」，念成 shén yāo）
BROKEN_TEXT = re.compile(r"(什|怎|这|那|多|要|為什|为什)幺")

# 旁白語言：PIKARA_LANG=en 時 Whisper 以英文辨識、不做繁簡轉換（Studio「英文」輸出）
LANG = "en" if os.environ.get("PIKARA_LANG", "zh").lower().startswith("en") else "zh"


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
# nvidia-smi 只存在於 NVIDIA 驅動；AMD／Intel／Apple 或沒有 GPU 時這些查詢回傳 0／空字串，不會讓配音中斷。
def _smi(*args: str) -> str:
    try:
        r = subprocess.run(["nvidia-smi", *args], capture_output=True, text=True, timeout=15)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def gpu_used_mb() -> int:
    try:
        return int(_smi("--query-gpu=memory.used", "--format=csv,noheader,nounits").strip().splitlines()[0])
    except Exception:
        return 0


def render_running() -> bool:
    try:
        r = subprocess.run(["tasklist"] if os.name == "nt" else ["ps", "-A", "-o", "comm="], capture_output=True, text=True, errors="replace", timeout=15)
    except (OSError, subprocess.SubprocessError):
        return False
    return "chrome-headless-shell" in r.stdout.lower()


# 其他程式（遊戲、OBS、瀏覽器）在開始前已占用的 VRAM：只有「之後又多出來」的用量才算外部 GPU 工作
_EXT_BASE: int | None = None


def wait_for_gpu(own_mb: int = 0, max_min: int = 40) -> None:
    """等 GPU 空出來：Remotion 算圖在跑，或外部用量比開始時多出 3 GB 以上。
    own_mb＝本程序實測占用（模型載入前後的 VRAM 差），不再用 torch.memory_reserved 估計（不含 CUDA context，會低估）。"""
    global _EXT_BASE
    if _EXT_BASE is None:
        _EXT_BASE = gpu_used_mb()
    t0 = time.time()
    while True:
        ext = gpu_used_mb() - own_mb
        busy = render_running() or ext - _EXT_BASE > 3000
        if not busy:
            return
        if time.time() - t0 > max_min * 60:
            raise SystemExit("[停止] GPU 被 Remotion 算圖或其他程式佔用超過 40 分鐘，稍後再執行（已完成的句子都已保存）。")
        print(f"  … 偵測到算圖或外部 VRAM 增加（外部 {ext} MiB，開始時 {_EXT_BASE} MiB），60 秒後再檢查", flush=True)
        time.sleep(60)


def cuda_available() -> bool:
    try:
        sys.path.insert(0, str(COSY))
        import torch
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def gpu_temp() -> int:
    try:
        return int(float(_smi("--query-gpu=temperature.gpu", "--format=csv,noheader,nounits").strip().splitlines()[0]))
    except Exception:
        return 0


def encode_mp3(wav, sr: int, dst: Path, af: str | None = None) -> str:
    """記憶體中的 float32 PCM 直接 pipe 給 ffmpeg 編成 MP3（不寫中間 WAV）。af：角色變調等音訊濾鏡。"""
    pcm = wav.clamp(-1, 1).numpy().astype("float32").tobytes()
    flt = ["-af", af] if af else []
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", *flt,
                        "-c:a", "libmp3lame", "-b:a", "160k", "-f", "mp3", str(dst)], input=pcm, capture_output=True)
    return "" if r.returncode == 0 else r.stderr.decode("utf-8", "replace")[-300:]


class VramSampler:
    """本程序這一句的 VRAM 峰值（torch 計數，MiB）。
    舊版每 0.5 秒開一個 nvidia-smi 子程序取樣：在 Windows 每次約 70 ms CPU，會跟 CPU 綁定的 LLM 逐 token 迴圈搶時間
    （實測見 out/ttsprof）。改用 torch.cuda.max_memory_reserved：不開子程序、只算自己的用量。"""
    def __init__(self):
        self.peak = 0

    def __enter__(self):
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
        except Exception:  # noqa: BLE001
            pass
        return self

    def __exit__(self, *a):
        try:
            import torch
            self.peak = torch.cuda.max_memory_reserved() // 2**20 if torch.cuda.is_available() else 0
        except Exception:  # noqa: BLE001
            self.peak = 0


class GpuGate:
    """GPU 協調（Remotion 算圖、外部 VRAM、溫度）最多每 interval 秒檢查一次，而不是每句都開 tasklist／nvidia-smi
    （實測每次 tasklist 0.45 s、nvidia-smi 0.07 s；一集 140 句約省 100 秒）。檢查到忙碌或過熱時仍會等。"""
    def __init__(self, interval: float = 20.0):
        self.interval = interval
        self.last = 0.0

    def check(self, own_mb_fn) -> None:
        if time.time() - self.last < self.interval:
            return
        wait_for_gpu(own_mb=own_mb_fn())
        while gpu_temp() >= 87:  # 過熱就暫停，不改任何時脈／功耗設定
            print(f"  … GPU {gpu_temp()}°C，暫停 20 秒降溫", flush=True)
            time.sleep(20)
        self.last = time.time()


# ---------------- 對齊（faster-whisper，CPU） ----------------
_asr = None
_cc = None


def release_asr() -> None:
    """重試輪開始前釋放 Whisper：否則重新載入 CosyVoice 前的 wait_for_gpu 會把本程序的 Whisper VRAM（約 1.5–2.5 GB）
    算成外部用量。舊版沙盒 TEST003 就因此自己等自己 15 分鐘後逾時（外部實際只有 853 MiB）。"""
    global _asr
    if _asr is None:
        return
    _asr = None
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    except Exception:  # noqa: BLE001
        pass


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
        if dev == "cuda":
            # ctranslate2 找 cublas64_12.dll 靠 PyTorch 先載入的 CUDA DLL；--align-only 或全部命中快取時 torch 還沒載入，
            # Whisper 會在第一次 encode 才失敗（cublas64_12.dll not found）。先載入 torch；沒有 CUDA 就直接用 CPU 並說明原因。
            try:
                import torch
                if not torch.cuda.is_available():
                    print("  ASR：沒有可用的 CUDA，改用 CPU", flush=True)
                    dev = "cpu"
            except Exception as e:  # noqa: BLE001
                print(f"  ASR：無法載入 PyTorch CUDA（{e}），改用 CPU", flush=True)
                dev = "cpu"
        for d, ct in ((dev, "float16"), (dev, "int8_float16"), ("cpu", "int8")):
            try:
                _asr = WhisperModel(str(local), device=d, compute_type=ct, cpu_threads=8)
                print(f"ASR：{ASR_MODEL} {d} {ct}", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  ASR {d}/{ct} 無法使用：{e}", flush=True)
        _cc = opencc.OpenCC(os.environ.get("PIKARA_ASR_CC", "s2twp")) if LANG == "zh" else None  # zh-CN 用 t2s；英文不轉換
    return _asr


def transcribe_words(path: Path) -> list[tuple[str, float, float]]:
    m = asr_model()
    segs, _ = m.transcribe(str(path), language=LANG, word_timestamps=True, beam_size=5, vad_filter=False,
                           condition_on_previous_text=False)
    words = []
    for s in segs:
        for w in s.words or []:
            words.append((_cc.convert(w.word) if _cc else w.word, float(w.start), float(w.end)))
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
def make_key(speak: str, voice: dict, speed: float, speaker: dict | None = None) -> str:
    """快取鍵；narration.json 的單句 cosySpeed 會覆寫全域 --speed。
    角色台詞（speaker）多一個欄位：角色的參考人聲與音高；旁白句子的鍵與舊版完全相同（已配音的句子不會重做）。"""
    v = {k: voice[k] for k in ("model", "mode", "reference_sha", "reference_text", "precision")}
    v["speed"] = speed
    if speaker:
        v["speaker"] = speaker
    p = json.dumps({"t": speak, "v": v, "g": GENERATOR_VERSION}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(p.encode("utf-8")).hexdigest()[:16]


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def load_lines(seq: str) -> list[tuple[str, dict]]:
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    return [(sc["id"], ln) for sc in data["sequences"][seq]["scenes"] for ln in sc["lines"]]


# ---------------- 擬人化角色的人聲（v0.3.2）----------------
# narration.json：sequences.<ep>.characters = [{"id", "name", "voice": "<reference 資料夾中的檔名>", "pitch": 半音}]，
# 角色說的句子加 "speaker": "<角色 id>"。voice 對應 tools/CosyVoice/reference/<voice>.wav＋.txt（零樣本複製該人聲）；
# pitch 在合成後以 ffmpeg 變調（不改變長度）。找不到參考人聲時用旁白人聲並提示，不會中止。
def load_characters(seq: str) -> dict:
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    out = {}
    for c in data["sequences"][seq].get("characters") or []:
        if isinstance(c, dict) and c.get("id"):
            out[str(c["id"])] = c
    return out


def speaker_voice(ln: dict, chars: dict, ref_dir: Path) -> dict | None:
    """這句的角色人聲：{"id", "ref": 參考音檔名或 None, "pitch": 半音}；旁白或角色不存在時 None。"""
    sid = ln.get("speaker")
    if not sid or sid not in chars:
        return None
    c = chars[sid]
    ref = str(c.get("voice") or "").strip()
    if ref and not ((ref_dir / f"{ref}.wav").exists() and (ref_dir / f"{ref}.txt").exists()):
        print(f"  ! 角色「{c.get('name', sid)}」的參考人聲 {ref} 不存在（{ref_dir.name}/{ref}.wav＋.txt），改用旁白人聲", flush=True)
        ref = ""
    try:
        pitch = max(-6.0, min(6.0, float(c.get("pitch") or 0)))
    except (TypeError, ValueError):
        pitch = 0.0
    if not ref and abs(pitch) < 1e-6:
        return {"id": sid, "ref": None, "pitch": 0.0, "same": True}
    return {"id": sid, "ref": ref or None, "pitch": round(pitch, 2)}


def pitch_filter(semitones: float, sr: int) -> str:
    """變調不變速：改取樣率（音高與速度一起變）→ 重新取樣 → atempo 把速度改回來。"""
    r = 2 ** (semitones / 12.0)
    return f"asetrate={int(round(sr * r))},aresample={sr},atempo={1 / r:.6f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", default="ep01")
    ap.add_argument("--test", nargs="*", help="只產生指定句子到 _test/")
    ap.add_argument("--only", nargs="*", help="只產生指定句子 ID")
    ap.add_argument("--ref", default=str(DEF_REF))
    ap.add_argument("--ref-text")
    ap.add_argument("--ref-text-file", default=str(DEF_REF_TXT))
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--target-cps", type=float, help=f"以 2 句校準 speed，使語速接近此值（字/秒）；speed 限制在 {SPEED_MIN}–{SPEED_MAX}")
    ap.add_argument("--max-cer", type=float, default=0.25, help="Whisper 字元錯誤率超過此值的句子自動重新合成")
    ap.add_argument("--retry-bad", type=int, default=2, help="錯誤率過高時最多重新合成幾輪（保留較好的一次）")
    ap.add_argument("--seed", type=int, default=20261122, help="每句的亂數種子基準（同一句、同一設定結果可重現）")
    ap.add_argument("--pron-dict", action="append", default=[], help="額外的發音字典 JSON（同 scripts/pronunciation.json 格式，後載入者優先）")
    ap.add_argument("--no-pron", action="store_true", help="不套用英文術語發音字典（A/B 比較用）")
    ap.add_argument("--takes", type=int, default=3, help="完整性檢查（無聲、削波、句尾截斷、語速異常）失敗時，同一句最多合成幾次")
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--align-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--narration", help="narration.json 路徑（例：src_cn/data/narration.json）")
    ap.add_argument("--out-root", help="輸出根目錄（例：public/assets/audio/voiceover_cosy_cn）")
    ap.add_argument("--out", help="覆寫輸出資料夾（相對 voiceover_cosy/）")
    a = ap.parse_args()
    if not (SPEED_MIN - 1e-9 <= a.speed <= SPEED_MAX + 1e-9):
        print(f"  ! --speed {a.speed} 超出 {SPEED_MIN}–{SPEED_MAX}（CosyVoice 以頻譜內插變速，會造成卡頓與吞字），改用 {min(SPEED_MAX, max(SPEED_MIN, a.speed))}", flush=True)
        a.speed = min(SPEED_MAX, max(SPEED_MIN, a.speed))

    global NARRATION, OUT_DIR
    if a.narration:
        NARRATION = (ROOT / a.narration).resolve()
    if a.out_root:
        OUT_DIR = (ROOT / a.out_root).resolve()
    ref = Path(a.ref).resolve()
    ref_text = a.ref_text or Path(a.ref_text_file).read_text(encoding="utf-8").strip()
    if not a.fp32 and not a.align_only and not cuda_available():
        # 沒有 CUDA（AMD／Intel／Apple 或無 GPU）：PyTorch 在 CPU 上跑 fp16 很慢且部分運算不支援 → fp32。
        # 在計算快取鍵之前決定，同一台電腦每次結果一致，已產生的句子不會被重做。
        print("  ! 沒有可用的 CUDA GPU：CosyVoice 改用 CPU fp32（速度明顯較慢，品質相同）", flush=True)
        a.fp32 = True
    voice = {"engine": "cosyvoice3", "model": "Fun-CosyVoice3-0.5B-2512", "mode": "zero_shot",
             "reference": ref.relative_to(ROOT).as_posix() if ref.is_relative_to(ROOT) else str(ref),
             "reference_sha": sha_file(ref), "reference_text": ref_text, "speed": a.speed,
             "precision": "fp32" if a.fp32 else "fp16"}
    lines = load_lines(a.seq)
    chars = load_characters(a.seq)
    for _, ln in lines:
        sv = speaker_voice(ln, chars, ref.parent)
        if sv and not sv.get("same"):
            if sv["ref"]:
                rw = ref.parent / f"{sv['ref']}.wav"
                sv["reference_sha"] = sha_file(rw)
            ln["_spk"] = sv
    n_spk = sum(1 for _, ln in lines if ln.get("_spk"))
    if n_spk:
        print(f"擬人化角色：{n_spk} 句使用角色人聲（{'、'.join(sorted({ln['_spk']['id'] for _, ln in lines if ln.get('_spk')}))}）", flush=True)
    # 發音字典只作用在 TTS 文字：ln["_tts"]；字幕（subtitle）與旁白稿（speak）保持原樣，寫進 json 供追蹤
    pron = None if a.no_pron else PronunciationEngine(lang_for(LANG, os.environ.get("PIKARA_ASR_CC")), extra_dicts=a.pron_dict)
    for _, ln in lines:
        src = ln.get("speak") or ln["subtitle"]
        ln["_tts"], ln["_pron"] = pron.apply(src) if pron else (src, [])
    n_pron = sum(1 for _, ln in lines if ln["_pron"])
    if n_pron:
        print(f"發音字典：{n_pron} 句的英文術語改寫為 TTS 念法（{pron.lang}；字幕不變）", flush=True)
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

    def key(speak: str, speed: float | None = None, spk: dict | None = None) -> str:
        sk = {k: spk[k] for k in ("ref", "reference_sha", "pitch") if k in spk} if spk else None
        return make_key(speak, voice, a.speed if speed is None else speed, sk)

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

    todo = [(sc, ln) for sc, ln in lines if not cached(ln["id"], key(ln["_tts"], ln.get("cosySpeed"), ln.get("_spk")))]
    print(f"共 {len(lines)} 句，需要產生 {len(todo)} 句 → {out.relative_to(ROOT)}")

    cosy = None
    stats_all = []
    logd = COSY / "logs"
    logd.mkdir(exist_ok=True)
    gpulog = logd / f"gpu_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    class _NoSmi:
        def terminate(self):
            pass
    # GPU 記錄：本程序內的執行緒（舊版的 nvidia-smi -l 子程序在 python 被強制結束時會變成孤兒，持續輪詢 GPU 好幾小時）
    smi = GpuLogger(gpulog) if shutil.which("nvidia-smi") else _NoSmi()
    WD.cleanups.append(smi.terminate)
    try:
        bad_text = [ln["id"] for _, ln in lines if BROKEN_TEXT.search(ln["_tts"])]
        if bad_text:
            print(f"[錯誤] {len(bad_text)} 句的朗讀文字有錯誤寫法（「幺」不是「么」，會被念成 yāo）：{'、'.join(bad_text[:10])}。"
                  "請修正旁白（簡體稿請用 make_cn 重新產生 src_cn），不會用錯誤的文字合成。", flush=True)
            return 1
        rc = _run(a, lines, todo, out, key, voice, ref, ref_text)
        if a.align_only or a.retry_bad <= 0:
            return rc
        # 品質重試：Whisper 聽不出來的句子（吞字、念錯、半截）重新合成，保留錯誤率較低的一次，不直接使用壞音訊
        a.target_cps = None  # speed 已固定
        for rnd in range(1, a.retry_bad + 1):
            bad = [(sc, ln) for sc, ln in lines if (c := line_cer(out, ln["id"])) is not None and c > a.max_cer]
            if not bad:
                break
            print(f"重新合成 {len(bad)} 句（Whisper 字元錯誤率 > {a.max_cer}，第 {rnd}/{a.retry_bad} 輪，保留較好的一次）", flush=True)
            best = {}
            for _, ln in bad:
                lid = ln["id"]
                best[lid] = line_cer(out, lid)
                for ext in (".mp3", ".json"):
                    shutil.copy2(out / f"{lid}{ext}", out / f"{lid}.best{ext}")
            a.seed += 7919 * rnd
            release_asr()
            _run(a, bad, bad, out, key, voice, ref, ref_text)
            for _, ln in bad:
                lid = ln["id"]
                new = line_cer(out, lid)
                if new is None or new >= best[lid]:
                    for ext in (".mp3", ".json"):
                        shutil.copy2(out / f"{lid}.best{ext}", out / f"{lid}{ext}")
                    print(f"  ↺ {lid} 保留原本（CER {best[lid]:.3f}，新的 {'失敗' if new is None else f'{new:.3f}'}）", flush=True)
                else:
                    print(f"  ↑ {lid} CER {best[lid]:.3f} → {new:.3f}", flush=True)
                for ext in (".mp3", ".json"):
                    (out / f"{lid}.best{ext}").unlink(missing_ok=True)
        still = [ln["id"] for _, ln in lines if (c := line_cer(out, ln["id"])) is not None and c > a.max_cer]
        if still:
            print(f"  ! 重新合成後仍有 {len(still)} 句字元錯誤率 > {a.max_cer}（數字寫法、同音字也會提高錯誤率，請以發音檢查結果為準）：{'、'.join(still[:12])}", flush=True)
        missing = [ln["id"] for _, ln in lines if not (out / f"{ln['id']}.mp3").exists()]
        code = 1 if missing else rc
        # Studio 重新配音（v0.3）：候選音檔產生到獨立資料夾，下一步逐句驗證後才切換；部分句子失敗時不讓整個工作中止，
        # 讓成功的句子仍能進入驗證（失敗的句子由驗證步驟回報，舊音檔不變）
        if code and os.environ.get("PIKARA_TTS_PARTIAL_OK") == "1" and len(missing) < len(lines):
            print(f"  ! {len(missing)} 句沒有產生（{'、'.join(missing[:12])}）；其餘 {len(lines) - len(missing)} 句交給驗證步驟", flush=True)
            return 0
        return code
    finally:
        smi.terminate()


def line_cer(out: Path, lid: str) -> float | None:
    try:
        return float(json.loads((out / f"{lid}.json").read_text(encoding="utf-8"))["alignment"]["cer"])
    except Exception:  # noqa: BLE001
        return None


def _run(a, lines, todo, out, key, voice, ref, ref_text) -> int:
    cosy = None
    stats_all = []
    if todo and not a.align_only:
        WD.set("等待 GPU", "")
        wait_for_gpu()
        sys.path.insert(0, str(COSY))
        sys.path.insert(0, str(COSY / "third_party" / "Matcha-TTS"))
        import torch
        import torchaudio
        from cosyvoice.cli.cosyvoice import AutoModel
        t0 = time.time()
        vram_before = gpu_used_mb()
        WD.set("載入 CosyVoice", "", LOAD_LIMIT)
        cosy = AutoModel(model_dir=str(MODEL_DIR), fp16=not a.fp32)
        if not a.fp32:  # 官方 fp16 只開 autocast，權重仍是 fp32；直接轉成 half 省 VRAM、避免溢出到共享記憶體
            cosy.model.llm.half()
            if os.environ.get("PIKARA_FLOW_HALF", "1") == "1":
                cosy.model.flow.half()
        torch.backends.cudnn.benchmark = True
        gate = GpuGate(float(os.environ.get("PIKARA_GPU_CHECK_SEC", "20")))
        # CosyVoice 的 tts() 每句結束都呼叫 torch.cuda.empty_cache()：實測關掉後同一批 10 句快 4.8%（常駐）／8%（冷啟動），
        # 峰值 VRAM 不變（1878 MiB）。這裡只在合成迴圈期間停用，整批結束後清一次（見下方 del cosy 後的 empty_cache）。
        _empty_cache = torch.cuda.empty_cache
        if os.environ.get("PIKARA_PER_LINE_EMPTY_CACHE", "0") != "1":
            torch.cuda.empty_cache = lambda: None
        # 計數每句 LLM 產生的 speech token（原始時長＝token ÷ 25 秒），用來實測實際變速倍率、偵測吞字
        _llm_inf = cosy.model.llm.inference
        tok_count = {"n": 0}

        def _count_tokens(*x, **k):
            for t in _llm_inf(*x, **k):
                tok_count["n"] += 1
                yield t
        cosy.model.llm.inference = _count_tokens
        print("裝置：llm", next(cosy.model.llm.parameters()).device, next(cosy.model.llm.parameters()).dtype,
              "flow", next(cosy.model.flow.parameters()).device, "hift", next(cosy.model.hift.parameters()).device, flush=True)
        perf_log = ROOT / "out" / "cosy_perf.log"
        perf_log.parent.mkdir(exist_ok=True)
        cosy.add_zero_shot_spk(PROMPT_PREFIX + ref_text, str(ref), "pikara_ref")  # 參考音特徵只算一次
        spk_ids = {}  # 角色參考人聲 → zero-shot speaker id（同樣只算一次）
        for _, ln in todo:
            sv = ln.get("_spk")
            if sv and sv.get("ref") and sv["ref"] not in spk_ids:
                rw = ref.parent / f"{sv['ref']}.wav"
                rt = (ref.parent / f"{sv['ref']}.txt").read_text(encoding="utf-8").strip()
                sid = f"pikara_{sv['ref']}"
                cosy.add_zero_shot_spk(PROMPT_PREFIX + rt, str(rw), sid)
                spk_ids[sv["ref"]] = (sid, PROMPT_PREFIX + rt, str(rw))
                print(f"角色人聲：{sv['ref']}", flush=True)
        torch.cuda.empty_cache()
        print(f"模型載入 {time.time() - t0:.1f}s，precision={voice['precision']}，VRAM {gpu_used_mb()} MiB", flush=True)
        prompt_text = PROMPT_PREFIX + ref_text
        if a.target_cps:  # 用 2 句校準全域 speed（之後所有句子固定使用）
            cal = sorted(todo, key=lambda x: -len(norm(x[1]["_tts"])))[:2]
            WD.set("校準語速", "、".join(c[1]["id"] for c in cal), sum(line_limit(len(norm(c[1]["_tts"]))) for c in cal))
            sp = 1.0
            for it in range(2):
                n_chars, secs = 0, 0.0
                for _, ln in cal:
                    t = ln["_tts"]
                    with torch.inference_mode():
                        w = torch.cat([o["tts_speech"] for o in cosy.inference_zero_shot(t, "", "", zero_shot_spk_id="pikara_ref", stream=False, speed=sp)], dim=1)
                    n_chars += len(norm(t)); secs += w.shape[1] / cosy.sample_rate
                cps = n_chars / secs
                print(f"校準 {it + 1}：speed={sp:.2f} → {cps:.2f} 字/s", flush=True)
                want = sp * a.target_cps / cps
                sp = round(max(SPEED_MIN, min(SPEED_MAX, want)), 2)
                if abs(sp - want) > 0.01:
                    print(f"  ! 要達到 {a.target_cps} 字/s 需要 speed {want:.2f}，超出 {SPEED_MIN}–{SPEED_MAX}；限制為 {sp}（避免頻譜壓縮造成卡頓、吞字）", flush=True)
            a.speed = sp
            voice["speed"] = sp
            print(f"固定 speed={sp}（重跑時請加 --speed {sp}）", flush=True)
        for sc, ln in todo:
            lid = ln["id"]
            speak = ln.get("speak") or ln["subtitle"]
            tts = ln["_tts"]
            mp3, mj = out / f"{lid}.mp3", out / f"{lid}.json"
            part_wav, part_mp3 = out / f"{lid}.part.wav", out / f"{lid}.part.mp3"
            WD.set("等待 GPU", lid)  # 外部 GPU 忙碌時的等待有自己的 40 分鐘上限
            gate.check(lambda: max(0, gpu_used_mb() - vram_before) if vram_before else 0)
            WD.set("合成", lid, line_limit(len(norm(tts))))
            replaced = False  # 新音檔已取代舊檔、但 json 還沒寫：這時失敗才刪除（避免音檔與 json 不一致）
            try:
                t1 = time.time()
                takes = []
                for take in range(max(1, a.takes)):
                    # 同一句同一設定可重現（第 1 次的種子與舊版相同）；完整性檢查失敗才換種子
                    torch.manual_seed(a.seed + zlib.crc32(lid.encode("utf-8")) % 1_000_000 + 104729 * take)
                    tok_count["n"] = 0
                    for attempt in (1, 2):
                        try:
                            inject_fault(lid, attempt, torch)
                            with VramSampler() as vs, torch.inference_mode():
                                spk_id, p_text, p_wav = spk_ids.get((ln.get("_spk") or {}).get("ref"), ("pikara_ref", prompt_text, str(ref)))
                                chunks = [o["tts_speech"] for o in cosy.inference_zero_shot(tts, p_text, p_wav, zero_shot_spk_id=spk_id, stream=False, speed=ln.get("cosySpeed", a.speed))]
                            break
                        except torch.cuda.OutOfMemoryError:
                            _empty_cache()  # 真正的 empty_cache（合成迴圈期間 torch.cuda.empty_cache 被停用）
                            if attempt == 2:
                                # 不默默改用 CPU：這句標示失敗並寫明原因；重新執行只會重做失敗的句子
                                raise RuntimeError(f"CUDA 記憶體不足（重試後仍 OOM；本程序 {torch.cuda.memory_reserved() // 2**20} MiB、"
                                                   f"GPU 總用量 {gpu_used_mb()} MiB）。請關閉其他使用 GPU 的程式（遊戲、OBS、瀏覽器）後重新執行")
                            print(f"  ! {lid} CUDA OOM（GPU 總用量 {gpu_used_mb()} MiB）：釋放快取、等外部 GPU 工作結束後重試一次", flush=True)
                            gate.last = 0.0
                            gate.check(lambda: max(0, gpu_used_mb() - vram_before) if vram_before else 0)
                            time.sleep(5)
                    wav = torch.cat(chunks, dim=1).float().cpu()[0]
                    chk = audio_check(wav.numpy(), cosy.sample_rate, tts, LANG, tokens=tok_count["n"] or None, applied_speed=ln.get("cosySpeed", a.speed))
                    takes.append(chk)
                    if chk["ok"]:
                        break
                    print(f"  ↻ {lid} 第 {take + 1} 次合成未通過完整性檢查：{'、'.join(chk['problems'])}；換種子重新合成", flush=True)
                if not chk["ok"]:
                    raise RuntimeError(f"{len(takes)} 次合成都未通過完整性檢查（{'、'.join(chk['problems'])}）；這句不寫檔，重新執行只會重做這句")
                el = time.time() - t1
                sv = ln.get("_spk") or {}
                af = pitch_filter(sv["pitch"], cosy.sample_rate) if abs(sv.get("pitch") or 0) > 1e-6 else None
                err = encode_mp3(wav, cosy.sample_rate, part_mp3, af) if fault_for(lid) != "ffmpeg" else "（測試注入：ffmpeg 失敗）"
                pr = ffprobe(part_mp3) if not err else None
                if pr is None or pr["duration"] < 0.3:
                    raise RuntimeError("ffprobe 驗證失敗 " + err)
                part_mp3.replace(mp3)
                replaced = True
                audio_s = wav.shape[0] / cosy.sample_rate
                meta = {"id": lid, "scene": sc, "seq": a.seq, "key": key(tts, ln.get("cosySpeed"), ln.get("_spk")), "voice": {**voice, "speed": ln.get("cosySpeed", a.speed)}, "subtitle": ln["subtitle"],
                        **({"speaker": {k: v for k, v in sv.items() if k != "same"}} if sv else {}),
                        "speak": speak, "ttsText": tts, "pronunciation": ln["_pron"], "integrity": {**chk, "takes": len(takes)},
                        # 重新配音的候選檔在 .studio/revoice/ 底下（不在 public/），改記相對專案根目錄的路徑
                        "file": (mp3.relative_to(ROOT / "public") if mp3.is_relative_to(ROOT / "public") else mp3.relative_to(ROOT)).as_posix(), "duration": round(pr["duration"], 4),
                        "codec": pr["codec"], "sample_rate": pr["sample_rate"], "boundaries": [],
                        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "engine": "cosyvoice3",
                        "perf": {"seconds": round(el, 2), "rtf": round(el / audio_s, 3), "vram_peak_mib": vs.peak}}
                mj.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                msg = f"{time.strftime('%H:%M:%S')} {lid} audio={pr['duration']:.2f}s wall={el:.1f}s RTF={el / audio_s:.2f} peakVRAM(本程序)={vs.peak}MiB"
                FAILED_LINES.discard(lid)
                print("  ✓ " + msg, flush=True)
                with open(perf_log, "a", encoding="utf-8") as f:
                    f.write(msg + chr(10))
            except Exception as e:  # noqa: BLE001
                # 失敗時保留上一次的好音檔（--force 重做時舊檔仍可用；舊版這裡會把它刪掉）。
                # 只有新音檔已取代舊檔、json 卻沒寫成時才刪，避免音檔與 json 對不上。
                if replaced:
                    for p in (mp3, mj):
                        p.unlink(missing_ok=True)
                FAILED_LINES.add(lid)
                kept = "；保留上一次的音檔" if mp3.exists() else ""
                print(f"  ✗ {lid} 失敗：{type(e).__name__}: {e}{kept}", flush=True)
            finally:
                part_wav.unlink(missing_ok=True)
                part_mp3.unlink(missing_ok=True)
        WD.clear()
        del cosy
        import gc
        gc.collect()
        torch.cuda.empty_cache = _empty_cache
        torch.cuda.empty_cache()  # TTS 結束：釋放 VRAM 給接下來的渲染

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
        WD.set("對齊", ln["id"], ALIGN_LIMIT if _asr is not None else ALIGN_LIMIT + LOAD_LIMIT)  # 第一句含 Whisper 載入
        words = transcribe_words(mj.with_suffix(".mp3"))
        bnd, st = align(meta["speak"], words)  # 邊界對到旁白原文（字幕錨點用原文）
        # 念法與字幕不同的句子（字典 CUDA → 酷達，或 speak「C plus plus」對字幕「C++」）：Whisper 可能寫成任一種，
        # 錯誤率取最低者（沙盒 TEST004：念對了「C++」，只比 speak 會得到 0.348 而誤判）
        for ref_name in ("ttsText", "subtitle"):
            ref_text = meta.get(ref_name)
            if ref_text and ref_text != meta["speak"]:
                _, st2 = align(ref_text, words)
                if st2["cer"] < st["cer"]:
                    st = {**st, "cer": st2["cer"], "cerRef": ref_name, "asr": st2["asr"]}
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
    WD.clear()
    print(f"\n完成：{len(lines) - len(missing)}/{len(lines)} 句有音檔，{len(noalign)} 句缺少邊界。" + (f" 缺：{missing}" if missing else ""))
    if FAILED_LINES:
        print(f"  ! 這次有 {len(FAILED_LINES)} 句合成失敗：{'、'.join(sorted(FAILED_LINES))}（結束碼 1；重新執行只會重做這些句子）", flush=True)
    return 1 if missing or noalign or FAILED_LINES else 0


if __name__ == "__main__":
    sys.exit(main())
