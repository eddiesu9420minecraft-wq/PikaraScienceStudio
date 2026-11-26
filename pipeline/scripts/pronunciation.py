"""PronunciationEngine：英文專有名詞 → TTS 朗讀文字。

只作用在「送進 TTS 的文字」：字幕、旁白稿、narration.json 都不會被改（呼叫端自己保留原文）。

規則（依序）：
  1. 字典（scripts/pronunciation.json → 專案根目錄 pronunciation.user.json → --pron-dict 檔案；後載入者覆寫同名術語）。
     多字術語先比對（最長優先）；比對有「英數字邊界」：CPU 不會改到 CPUs 以外的字、Intel 不會改到 Intelligence。
  2. 字典沒有的全大寫 2–4 字母縮寫（RAM、SSD、USB、API）→ 逐字母「S S D」（只有中文語音；英文語音本來就會念）。
  3. 英文字母之間的「.」（Node.js）→「點／点」：CosyVoice 前端會把 . 變成句號而停頓。
  4. 已經是「G P U」這種單字母加空白的寫法不會再被處理（旁白稿手寫的 speak 原樣保留）。
其他英文單字原樣交給 TTS（CosyVoice3 能念一般英文單字）。

用法：
    eng = PronunciationEngine("zh-TW")            # 或 "zh-CN" / "en"
    tts_text, changes = eng.apply("為什麼 GPU 不能取代 CPU？")
    # tts_text == "為什麼 G P U 不能取代 C P U？"；changes 記錄每一處替換（寫進配音 json 供追蹤）
CLI：python scripts/pronunciation.py zh-TW "用 CUDA 跑 Python"
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DICT = ROOT / "scripts" / "pronunciation.json"
USER_DICT = ROOT / "pronunciation.user.json"
LANGS = ("zh-TW", "zh-CN", "en")
# 不是英數字、也不是底線的邊界（中文字、空白、標點都算邊界）
_B0, _B1 = r"(?<![A-Za-z0-9_])", r"(?![A-Za-z0-9_])"
_AUTO_ACRONYM = re.compile(_B0 + r"([A-Z]{2,4})" + _B1)
_DOT = re.compile(r"(?<=[A-Za-z])\.(?=[A-Za-z])")


@dataclass
class Term:
    term: str
    kind: str = "word"
    say: dict | str | None = None
    ignore_case: bool | None = None
    source: str = ""

    def spoken(self, lang: str) -> str:
        s = self.say
        if isinstance(s, dict):
            s = s.get(lang) or (s.get("zh-TW") if lang.startswith("zh") else None) or s.get("en")
        if s:
            return s
        if self.kind == "acronym" and lang != "en":
            return spell(self.term)
        return self.term

    def pattern(self) -> re.Pattern:
        ic = self.ignore_case if self.ignore_case is not None else self.kind != "acronym"
        body = r"\s+".join(re.escape(w) for w in self.term.split())
        return re.compile(_B0 + body + _B1, re.IGNORECASE if ic else 0)


def spell(word: str) -> str:
    return " ".join(ch for ch in word if not ch.isspace())


@dataclass
class PronunciationEngine:
    lang: str = "zh-TW"
    extra_dicts: list = field(default_factory=list)
    auto_acronyms: bool = True

    def __post_init__(self):
        if self.lang not in LANGS:
            raise ValueError(f"lang 必須是 {LANGS} 之一，收到 {self.lang!r}")
        self.terms: dict[str, Term] = {}
        for p in [DEFAULT_DICT, USER_DICT, *map(Path, self.extra_dicts)]:
            if p.exists():
                self.load(p)
        # 最長的術語先比對（"Visual Studio Code" 先於 "Code"）
        self._compiled = sorted(((t.pattern(), t) for t in self.terms.values()), key=lambda x: -len(x[1].term))

    def load(self, path: Path) -> None:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        for e in doc.get("terms", []):
            if not e.get("term"):
                continue
            t = Term(e["term"], e.get("kind", "word"), e.get("say"), e.get("ignoreCase"), str(path))
            self.terms[t.term.lower()] = t

    def apply(self, text: str) -> tuple[str, list[dict]]:
        changes: list[dict] = []
        # 先把要替換的位置找出來（在原文上比對，避免替換結果再被別的規則比對到）
        taken: list[tuple[int, int, str, str, str]] = []

        def free(a: int, b: int) -> bool:
            return all(b <= x or a >= y for x, y, *_ in taken)

        for pat, t in self._compiled:
            for m in pat.finditer(text):
                if free(m.start(), m.end()):
                    taken.append((m.start(), m.end(), t.spoken(self.lang), t.kind, t.source))
        if self.auto_acronyms and self.lang != "en":
            for m in _AUTO_ACRONYM.finditer(text):
                if free(m.start(), m.end()):
                    taken.append((m.start(), m.end(), spell(m.group(1)), "acronym(auto)", "rule"))
        if self.lang != "en":
            dot = "點" if self.lang == "zh-TW" else "点"
            for m in _DOT.finditer(text):
                if free(m.start(), m.end()):
                    taken.append((m.start(), m.end(), f" {dot} ", "dot", "rule"))
        out, pos = [], 0
        for a, b, rep, kind, src in sorted(taken):
            out.append(text[pos:a])
            orig = text[a:b]
            if rep != orig:
                # 中文字緊貼英文時補空白，避免 CosyVoice 把字母和中文黏成一個詞
                pre = " " if a > 0 and text[a - 1].isalnum() and rep[:1].isascii() and rep[:1].isalnum() else ""
                post = " " if b < len(text) and text[b].isalnum() and rep[-1:].isascii() and rep[-1:].isalnum() else ""
                out.append(pre + rep + post)
                changes.append({"from": orig, "to": rep, "kind": kind, "at": a, "source": Path(src).name if src != "rule" else "rule"})
            else:
                out.append(orig)
            pos = b
        out.append(text[pos:])
        return "".join(out), changes


def lang_for(voice_lang: str | None, cc: str | None = None) -> str:
    """generate_voiceover_cosy 的語言設定 → 字典語言。"""
    if voice_lang and voice_lang.lower().startswith("en"):
        return "en"
    if cc and cc.lower().startswith("t2s"):
        return "zh-CN"
    return "zh-TW"


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("用法：python scripts/pronunciation.py zh-TW|zh-CN|en \"文字\"")
    t, ch = PronunciationEngine(sys.argv[1]).apply(" ".join(sys.argv[2:]))
    print(t)
    for c in ch:
        print("  ", c)
