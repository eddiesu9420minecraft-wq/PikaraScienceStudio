"""Whisper 文字與旁白比對前的正規化：繁簡字形與數字寫法。

Whisper 把念出來的數字寫成阿拉伯數字（「一九四六年」→「1946年」、「F P 六十四」→「fp64」），
逐字的字元錯誤率（CER）因此偏高，但讀音完全正確。品質重試只應該重做真的念錯的句子，
旁白是簡體、Whisper 輸出卻被轉成繁體（或反過來）時，每個字都算錯。重試與發音檢查應該只看讀音，
所以比對前兩邊都轉成簡體，ASR 裡的每一串數字改寫成旁白實際使用的念法
（逐位「一九四六」或完整「一千九百四十六」，看旁白用哪一種），再算 CER。原始值另存為 alignment.cerRaw。
"""
from __future__ import annotations

import re

DIGITS = "零一二三四五六七八九"


def cn_number(n: int) -> str:
    """完整念法：16 → 十六，105 → 一百零五，1946 → 一千九百四十六，30000 → 三萬（與 Studio quality.rs 相同規則）。"""
    if n == 0:
        return "零"

    def group(g: int) -> str:
        units = ["千", "百", "十", ""]
        ds = [g // 1000, g // 100 % 10, g // 10 % 10, g % 10]
        out, zero = "", False
        for i, d in enumerate(ds):
            if d == 0:
                zero = bool(out)
                continue
            if zero:
                out += "零"
                zero = False
            out += DIGITS[d] + units[i]
        return out

    out = ""
    for g, unit in ((n // 10**8, "億"), (n // 10**4 % 10**4, "萬"), (n % 10**4, "")):
        if g == 0:
            continue
        if out and g < 1000 and not out.endswith("零"):
            out += "零"
        out += group(g) + unit
    if out.startswith("一十"):
        out = out[1:]
    return out


def readings(num: str) -> list[str]:
    """一串數字（可含小數點）可能的念法。"""
    if "." in num:
        a, b = num.split(".", 1)
        frac = "".join(DIGITS[int(c)] for c in b)
        return [r + "點" + frac for r in readings(a)] + [r + "点" + frac for r in readings(a)]
    out = ["".join(DIGITS[int(c)] for c in num)]
    if len(num) <= 12 and not (len(num) > 1 and num.startswith("0")):
        full = cn_number(int(num))
        out.append(full)
        if full.startswith("二") and len(num) in (3, 4):  # 200 → 兩百、2000 → 兩千
            out.append("兩" + full[1:])
            out.append("两" + full[1:])
    return out


_NUM = re.compile(r"\d+(?:\.\d+)?")


def normalize_hyp(hyp: str, target: str) -> str:
    """把 hyp 裡的數字改成 target 用的念法（target 裡找得到的那一種；都找不到就用完整念法）。"""

    def rep(m: re.Match) -> str:
        rs = readings(m.group(0))
        for r in sorted(rs, key=len, reverse=True):
            if r in target:
                return r
        return rs[-1] if len(rs) > 1 else rs[0]

    return _NUM.sub(rep, hyp)


def cer(target: str, hyp: str) -> float:
    d = list(range(len(hyp) + 1))
    for i, ca in enumerate(target, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
            prev, d[j] = d[j], cur
    return d[len(hyp)] / max(1, len(target))


_T2S = None


def fold(s: str) -> str:
    """繁簡不分：兩邊都轉成簡體再比（Whisper 輸出經 s2twp／t2s 轉換，旁白可能是另一種字形；繁→簡是多對一，最穩定）。"""
    global _T2S
    if _T2S is None:
        try:
            import opencc
            _T2S = opencc.OpenCC("t2s").convert
        except Exception:  # noqa: BLE001  沒有 opencc 時只做數字正規化
            _T2S = lambda x: x  # noqa: E731
    return _T2S(s)


def norm_cer(target: str, hyp: str) -> float:
    """讀音相關的錯誤率：繁簡字形與數字寫法不算錯。target、hyp 都已去標點空白並轉小寫（generate_voiceover_cosy.norm）。"""
    t, h = fold(target), fold(hyp)
    return min(cer(t, h), cer(t, normalize_hyp(h, t)))
