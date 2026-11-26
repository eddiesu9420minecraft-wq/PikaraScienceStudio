"""配音片段完整性檢查（每句 TTS 輸出在寫檔前檢查；不修改音訊，只判斷要不要重新合成）。

檢查項目：
  - silent     ：峰值太低（模型輸出空白）
  - clipping   ：數位削波（|x| ≥ 0.999 的取樣比例過高）
  - cut_tail   ：結尾 40 ms 的能量仍接近語音能量（句尾被截斷，沒有自然收尾）
  - cut_head   ：開頭 20 ms 就已經是滿能量（句首被截掉）
  - sped_up    ：實際變速倍率過高。倍率＝原始時長 ÷ 實際時長；原始時長＝LLM 產生的 speech token 數 ÷ 25（CosyVoice3 每秒
                 25 個 token，speed=1 時的自然長度）。這是實測值，不受句子長短、語者快慢影響（EP10 的 1.66 倍會被抓到）
  - few_tokens ：每個字分到的 speech token 太少（模型跳字／吞字；與變速無關）
  - too_fast   ：每秒字數超過上限。只在拿不到 token 數時當主要判斷；有 token 數時只是輔助（自然語速的短句可能偏快）
  - too_slow   ：每秒字數過低（拖長、含大段無聲或亂碼）
門檻以已上架集數（EP06、EP10 繁中、EP10 簡中）的真實配音校準：見 out/pron/calib_integrity.py。
"""
from __future__ import annotations

import re

import numpy as np

_CJK = re.compile(r"[㐀-鿿]")
_WORD = re.compile(r"[A-Za-z]+|\d+")

LIMITS = {"peak_min": 0.02, "clip_frac_max": 0.002, "tail_ratio_max": 0.6, "head_ratio_max": 0.8, "rate_min": 1.2, "rate_max": 7.0}  # 自然語速實測最高 5.9 字/秒；EP10 簡中 speed 1.66 為 5.8–7.8


def units(text: str, lang: str = "zh") -> int:
    """語音單位數：中文每字 1；英文每個字母組（單字或逐字母念的 G P U 每個字母）1；數字每位 1（中文念法）。"""
    if lang == "en":
        return max(1, len(re.findall(r"[A-Za-z]+|\d+", text)))
    n = len(_CJK.findall(text))
    for w in _WORD.findall(text):
        n += len(w) if (w.isdigit() or len(w) == 1 or w.isupper()) else max(1, round(len(w) / 3))
    return max(1, n)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0


TOKEN_HZ = 25.0  # CosyVoice3 speech token rate
SPEED_MAX = 1.2  # 實測倍率上限（生成器允許的 speed 是 0.85–1.15）
TOKENS_PER_UNIT_MIN = 2.0  # 由 out/ttsprof 實測校準：正常句子約 4–7 token/字


def analyze(wav, sr: int, text: str, lang: str = "zh", tokens: int | None = None, applied_speed: float | None = None) -> dict:
    w = np.asarray(wav, dtype=np.float32).reshape(-1)
    dur = w.size / sr if sr else 0.0
    peak = float(np.max(np.abs(w))) if w.size else 0.0
    clip_frac = float(np.mean(np.abs(w) >= 0.999)) if w.size else 0.0
    hop = max(1, int(sr * 0.02))
    frames = np.array([_rms(w[i:i + hop]) for i in range(0, max(0, w.size - hop + 1), hop)]) if w.size >= hop else np.array([0.0])
    voiced = frames[frames > max(0.01, peak * 0.05)]
    ref = float(np.median(voiced)) if voiced.size else 1e-9
    thr = max(0.008, ref * 0.12)
    on = np.nonzero(frames > thr)[0]
    lead_s = float(on[0] * hop / sr) if on.size else dur
    tail_s = float((frames.size - 1 - on[-1]) * hop / sr) if on.size else dur
    tail_ratio = _rms(w[-int(sr * 0.04):]) / ref if ref > 0 else 0.0
    head_ratio = _rms(w[:int(sr * 0.02)]) / ref if ref > 0 else 0.0
    speech_s = max(0.05, dur - lead_s - tail_s)
    rate = units(text, lang) / speech_s
    lim = LIMITS if lang != "en" else {**LIMITS, "rate_min": 0.6, "rate_max": 5.5}
    problems = []
    natural_s = tokens / TOKEN_HZ if tokens else None
    eff_speed = round(natural_s / dur, 3) if natural_s and dur > 0 else None
    tpu = round(tokens / units(text, lang), 2) if tokens else None
    if eff_speed is not None and eff_speed > SPEED_MAX:
        problems.append(f"sped_up（實測倍率 {eff_speed:.2f}×：原始 {natural_s:.2f}s → 實際 {dur:.2f}s）")
    if applied_speed is not None and not (0.85 - 1e-6 <= applied_speed <= 1.15 + 1e-6):
        problems.append(f"sped_up（設定 speed {applied_speed}）")
    if tpu is not None and tpu < TOKENS_PER_UNIT_MIN and peak >= lim["peak_min"]:
        problems.append(f"few_tokens（每字 {tpu} 個 token，可能吞字）")
    if peak < lim["peak_min"]:
        problems.append(f"silent（峰值 {peak:.3f}）")
    if clip_frac > lim["clip_frac_max"]:
        problems.append(f"clipping（削波 {clip_frac:.2%}）")
    if tail_ratio > lim["tail_ratio_max"]:
        problems.append(f"cut_tail（結尾能量 {tail_ratio:.2f}× 語音）")
    if head_ratio > lim["head_ratio_max"]:
        problems.append(f"cut_head（開頭能量 {head_ratio:.2f}× 語音）")
    if peak < lim["peak_min"]:
        pass  # 無聲時語速沒有意義，只回報 silent
    elif rate > lim["rate_max"] and (eff_speed is None or eff_speed > 1.1):
        # 有實測倍率且接近 1×（自然語速）時，偏快只是這句本來就短而密，不算錯
        problems.append(f"too_fast（{rate:.1f} 字/秒）")
    elif rate < lim["rate_min"] and units(text, lang) >= 4:
        problems.append(f"too_slow（{rate:.1f} 字/秒）")
    return {"ok": not problems, "problems": problems, "duration": round(dur, 3), "peak": round(peak, 4), "clip_frac": round(clip_frac, 5),
            "lead_s": round(lead_s, 3), "tail_s": round(tail_s, 3), "tail_ratio": round(tail_ratio, 3), "head_ratio": round(head_ratio, 3),
            "rate": round(rate, 2), "units": units(text, lang), "tokens": tokens, "naturalSec": None if natural_s is None else round(natural_s, 3),
            "effectiveSpeed": eff_speed, "appliedSpeed": applied_speed, "tokensPerUnit": tpu}
