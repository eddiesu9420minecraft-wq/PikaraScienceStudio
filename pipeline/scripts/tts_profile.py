"""CosyVoice3 配音效能剖析（實測，不估計）。

    tools/CosyVoice/.venv/Scripts/python.exe scripts/tts_profile.py --device cuda --precision fp16 --out out/ttsprof/gpu_fp16.json
    （CPU 基準：--device cpu，會設定 CUDA_VISIBLE_DEVICES= 讓 PyTorch／onnxruntime 都看不到 GPU）

量測項目（每句、每階段，GPU 階段前後 torch.cuda.synchronize）：
  import → 模型載入 → 文字正規化 → frontend（文字 token、說話人特徵）→ LLM（自回歸 speech token）→ flow（token→mel）
  → HiFT vocoder（mel→波形）→ 寫 MP3 → Whisper 對齊；另外量測 generate_voiceover_cosy 每句的 GPU 協調開銷
  （tasklist／nvidia-smi 子程序）與 CosyVoice 每句 torch.cuda.empty_cache() 的影響。
  全程以 nvidia-smi -lms 500 記錄 GPU 使用率與 VRAM；CPU 使用率＝本程序 CPU 時間 ÷ 牆鐘時間。
  模型常駐 vs 冷啟動：同一程序跑 --passes 輪，第 1 輪含 CUDA kernel 初始化／cudnn benchmark。
每個輸出都過完整性檢查（無聲、削波、截斷、語速）與 Whisper 聽寫，避免「快但念錯」。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
T_START = time.perf_counter()

ap = argparse.ArgumentParser()
ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
ap.add_argument("--precision", choices=["fp16", "fp32", "bf16"], default="fp16")
ap.add_argument("--passes", type=int, default=2)
ap.add_argument("--keep-empty-cache", action="store_true", help="保留 CosyVoice 每句 empty_cache（預設也保留；--no-empty-cache 關掉）")
ap.add_argument("--no-empty-cache", action="store_true")
ap.add_argument("--voices", default="tw,cn")
ap.add_argument("--out", required=True)
a = ap.parse_args()
if a.device == "cpu":
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"  # 空字串在 Windows 上仍會讓 is_available() 回傳 True
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

COSY = ROOT / "tools" / "CosyVoice"
sys.path[:0] = [str(COSY), str(COSY / "third_party" / "Matcha-TTS"), str(ROOT / "scripts")]
import numpy as np  # noqa: E402
import torch  # noqa: E402

t_import = time.perf_counter()
import generate_voiceover_cosy as g  # noqa: E402
from audio_integrity import analyze  # noqa: E402
from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402
from pronunciation import PronunciationEngine  # noqa: E402

t_import = time.perf_counter() - T_START

TEXT = {
    "tw": ["什麼？", "為什麼 GPU 不能取代 CPU？", "CUDA 是 NVIDIA 推出的平行運算平台，讓 GPU 能執行一般的計算工作。",
           "Python 程式可以在 Linux 和 Windows 上執行，你知道嗎？", "顯示卡裡有幾千個小核心，適合同時處理大量相同的運算。"],
    "cn": ["什么？", "为什么 GPU 不能取代 CPU？", "CUDA 是 NVIDIA 推出的并行计算平台，让 GPU 能执行一般的计算工作。",
           "Python 程序可以在 Linux 和 Windows 上运行，你知道吗？", "显卡里有几千个小核心，适合同时处理大量相同的运算。"],
}
REF = {"tw": "reference", "cn": "reference_cn"}

# ---------------- GPU / CPU 取樣 ----------------
smi_csv = Path(a.out).with_suffix(".smi.csv")
Path(a.out).parent.mkdir(parents=True, exist_ok=True)
try:
    smi = subprocess.Popen(["nvidia-smi", "--query-gpu=timestamp,utilization.gpu,memory.used,power.draw,temperature.gpu", "--format=csv,noheader,nounits",
                            "-lms", "500", "-f", str(smi_csv)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except OSError:
    smi = None
# 例外結束（例如 bf16 型別錯誤）時也要停掉取樣子程序：2026-11-23 因此留下兩個 -lms 500 的孤兒 nvidia-smi 跑了 4 小時
import atexit  # noqa: E402
atexit.register(lambda: smi is not None and smi.poll() is None and smi.terminate())
marks: list[tuple[float, str]] = []  # (epoch, label) 用來把 nvidia-smi 取樣切到各階段


def mark(label):
    marks.append((time.time(), label))


# ---------------- 階段計時（包裝 CosyVoice 內部函式）----------------
cuda = torch.cuda.is_available() and torch.cuda.device_count() > 0
sync = torch.cuda.synchronize if cuda else (lambda: None)
acc: dict[str, float] = {}
lock = threading.Lock()


def add(k, v):
    with lock:
        acc[k] = acc.get(k, 0.0) + v


def timed(name, fn):
    def w(*x, **k):
        sync()
        t = time.perf_counter()
        r = fn(*x, **k)
        sync()
        add(name, time.perf_counter() - t)
        return r
    return w


def timed_gen(name, fn):
    def w(*x, **k):
        t = time.perf_counter()
        for item in fn(*x, **k):
            add("tokens", 1)
            yield item
        sync()
        add(name, time.perf_counter() - t)
    return w


mark("load")
t0 = time.perf_counter()
cosy = AutoModel(model_dir=str(g.MODEL_DIR), fp16=(a.precision == "fp16" and cuda))
fallback = None
if cuda and a.precision == "fp16":
    cosy.model.llm.half()
    cosy.model.flow.half()
elif cuda and a.precision == "bf16":
    try:
        cosy.model.llm.to(torch.bfloat16)
        cosy.model.flow.to(torch.bfloat16)
    except Exception as e:  # noqa: BLE001
        fallback = f"bf16 轉換失敗：{e}"
torch.backends.cudnn.benchmark = cuda
sync()
t_load = time.perf_counter() - t0
vram_load = torch.cuda.memory_allocated() // 2**20 if cuda else 0

m = cosy.model
devices = {}
for name in ("llm", "flow", "hift"):
    mod = getattr(m, name)
    ps = list(mod.parameters())
    devices[name] = {"device": str(ps[0].device), "dtype": str(ps[0].dtype).replace("torch.", ""),
                     "paramsM": round(sum(p.numel() for p in ps) / 1e6, 1), "MiB": round(sum(p.numel() * p.element_size() for p in ps) / 2**20, 1)}
fe = cosy.frontend
devices["speech_tokenizer(onnx)"] = {"providers": fe.speech_tokenizer_session.get_providers()}
devices["campplus(onnx)"] = {"providers": fe.campplus_session.get_providers()}

fe.text_normalize = timed("text", fe.text_normalize)
fe.frontend_zero_shot = timed("frontend", fe.frontend_zero_shot)
m.llm.inference = timed_gen("llm", m.llm.inference)
m.flow.inference = timed("flow", m.flow.inference)
m.hift.inference = timed("hift", m.hift.inference)
if a.no_empty_cache and cuda:
    torch.cuda.empty_cache = lambda: None  # CosyVoice 的 tts() 每句結束都會清 cache：量測關掉的效果

# 生成器每句的 GPU 協調開銷（子程序）
coord = {}
for nm, f in (("render_running(tasklist)", g.render_running), ("gpu_used_mb(nvidia-smi)", g.gpu_used_mb), ("gpu_temp(nvidia-smi)", g.gpu_temp)):
    ts = []
    for _ in range(5):
        t = time.perf_counter()
        f()
        ts.append(time.perf_counter() - t)
    coord[nm] = round(sum(ts) / len(ts), 3)

results, per_voice = [], {}
for voice in a.voices.split(","):
    ref = COSY / REF[voice] / "reference.wav"
    ref_text = (COSY / REF[voice] / "reference.txt").read_text(encoding="utf-8").strip()
    t = time.perf_counter()
    cosy.add_zero_shot_spk(g.PROMPT_PREFIX + ref_text, str(ref), f"spk_{voice}")
    per_voice[voice] = {"spk_setup_s": round(time.perf_counter() - t, 3)}
    eng = PronunciationEngine("zh-TW" if voice == "tw" else "zh-CN")
    for pas in range(a.passes):
        for i, sub in enumerate(TEXT[voice]):
            tts, _ = eng.apply(sub)
            acc.clear()
            if cuda:
                torch.cuda.reset_peak_memory_stats()
            mark(f"{voice}{pas}-{i}")
            torch.manual_seed(20261122 + i)
            c0, w0 = time.process_time(), time.perf_counter()
            with torch.inference_mode():
                wav = torch.cat([o["tts_speech"] for o in cosy.inference_zero_shot(tts, "", "", zero_shot_spk_id=f"spk_{voice}", stream=False)], dim=1).float().cpu()[0]
            synth = time.perf_counter() - w0
            cpu_s = time.process_time() - c0
            ntok = int(acc.pop("tokens", 0))
            stages = {k: round(v, 3) for k, v in acc.items()}
            nan = bool(torch.isnan(wav).any() or torch.isinf(wav).any())
            out = Path(a.out).parent / f"{Path(a.out).stem}_{voice}{pas}_{i}.mp3"
            t = time.perf_counter()
            err = g.encode_mp3(wav, cosy.sample_rate, out)
            write_s = time.perf_counter() - t
            asr, cer = "", None
            if pas == a.passes - 1:  # 只對最後一輪做聽寫（對齊耗時另計）
                g.LANG = "zh"
                os.environ["PIKARA_ASR_CC"] = "s2twp" if voice == "tw" else "t2s"
                g._asr = None if voice == "cn" and i == 0 else g._asr
                t = time.perf_counter()
                words = g.transcribe_words(out)
                _, st = g.align(sub, words)
                _, st2 = g.align(tts, words)
                align_s = time.perf_counter() - t
                asr, cer = st["asr"], min(st["cer"], st2["cer"])
            else:
                align_s = None
            audio_s = wav.shape[0] / cosy.sample_rate
            chk = analyze(wav.numpy(), cosy.sample_rate, tts, "zh", tokens=ntok or None, applied_speed=1.0)
            results.append({"voice": voice, "pass": pas, "i": i, "text": sub, "ttsText": tts, "audio_s": round(audio_s, 3), "synth_s": round(synth, 3),
                            "rtf": round(synth / audio_s, 3), "audio_per_s": round(audio_s / synth, 3), "stages": stages,
                            "other_s": round(synth - sum(stages.values()), 3), "write_s": round(write_s, 3), "align_s": None if align_s is None else round(align_s, 3),
                            "cpu_cores": round(cpu_s / synth, 2), "cpu_pct_machine": round(100 * cpu_s / synth / os.cpu_count(), 1),
                            "peak_alloc_MiB": torch.cuda.max_memory_allocated() // 2**20 if cuda else 0,
                            "nan": nan, "integrity": chk["problems"] or "OK", "tokens": ntok, "effectiveSpeed": chk["effectiveSpeed"], "tokensPerUnit": chk["tokensPerUnit"], "cps": chk["rate"], "asr": asr, "cer": cer, "mp3_err": err or None, "file": out.name})
            print(f"{voice} p{pas} #{i} audio {audio_s:.2f}s synth {synth:.2f}s RTF {synth / audio_s:.2f} {stages} cpu {cpu_s / synth:.2f} cores {chk['problems'] or 'OK'} {asr}", flush=True)
mark("end")
if smi:
    time.sleep(0.8)
    smi.terminate()

# nvidia-smi 取樣切到每句
gpu_by = {}
if smi_csv.exists():
    import datetime as dt
    rows = []
    for ln in smi_csv.read_text(encoding="utf-8", errors="replace").splitlines():
        f = [x.strip() for x in ln.split(",")]
        try:
            ts = dt.datetime.strptime(f[0], "%Y/%m/%d %H:%M:%S.%f").timestamp()
            rows.append((ts, float(f[1]), float(f[2])))
        except Exception:  # noqa: BLE001
            pass
    for (t1, lab), (t2, _) in zip(marks, marks[1:]):
        seg = [r for r in rows if t1 <= r[0] < t2]
        if seg:
            gpu_by[lab] = {"util_avg": round(sum(r[1] for r in seg) / len(seg), 1), "util_max": max(r[1] for r in seg), "vram_max": max(r[2] for r in seg)}
for r in results:
    r["gpu"] = gpu_by.get(f"{r['voice']}{r['pass']}-{r['i']}")


def tot(pas):
    rs = [r for r in results if r["pass"] == pas]
    return {"sentences": len(rs), "audio_s": round(sum(r["audio_s"] for r in rs), 2), "synth_s": round(sum(r["synth_s"] for r in rs), 2),
            "rtf": round(sum(r["synth_s"] for r in rs) / max(1e-9, sum(r["audio_s"] for r in rs)), 3),
            "stages": {k: round(sum(r["stages"].get(k, 0) for r in rs), 2) for k in ("text", "frontend", "llm", "flow", "hift")},
            "write_s": round(sum(r["write_s"] for r in rs), 2), "align_s": round(sum(r["align_s"] or 0 for r in rs), 2),
            "gpu_util_avg": round(sum((r["gpu"] or {}).get("util_avg", 0) for r in rs) / max(1, len(rs)), 1),
            "cpu_cores_avg": round(sum(r["cpu_cores"] for r in rs) / max(1, len(rs)), 2),
            "problems": [f"{r['voice']}#{r['i']}:{r['integrity']}" for r in rs if r["integrity"] != "OK" or r["nan"]]}


rep = {"device": a.device, "precision": a.precision, "noEmptyCache": a.no_empty_cache, "torch": torch.__version__, "cuda": torch.version.cuda,
       "cudaAvailable": cuda, "gpu": torch.cuda.get_device_name(0) if cuda else None, "bf16Supported": bool(cuda and torch.cuda.is_bf16_supported()),
       "fallback": fallback, "import_s": round(t_import, 2), "load_s": round(t_load, 2), "vram_after_load_MiB": vram_load,
       "cold_to_first_audio_s": round(results[0]["synth_s"] + t_load + t_import + per_voice[a.voices.split(',')[0]]["spk_setup_s"], 2) if results else None,
       "modules": devices, "coordination_overhead_s_per_call": coord, "voices": per_voice,
       "pass": {str(p): tot(p) for p in range(a.passes)}, "results": results}
Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({k: rep[k] for k in ("device", "precision", "load_s", "vram_after_load_MiB", "cold_to_first_audio_s", "modules", "coordination_overhead_s_per_call")}, ensure_ascii=False, indent=1))
print(json.dumps(rep["pass"], ensure_ascii=False, indent=1))
