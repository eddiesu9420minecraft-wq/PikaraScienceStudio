# python scripts/test_pronunciation.py — PronunciationEngine 單元測試（不需要 GPU / 模型）
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pronunciation import PronunciationEngine, lang_for  # noqa: E402

tw, cn, en = PronunciationEngine("zh-TW"), PronunciationEngine("zh-CN"), PronunciationEngine("en")


def say(e, s):
    return e.apply(s)[0]


cases = [
    (tw, "為什麼 GPU 不能取代 CPU？", "為什麼 G P U 不能取代 C P U？"),
    (cn, "为什么 GPU 不能取代 CPU？", "为什么 G P U 不能取代 C P U？"),
    (tw, "用 CUDA 寫程式", "用 酷達 寫程式"),
    (cn, "用 CUDA 写程序", "用 库达 写程序"),
    (tw, "cuda 小寫也算", "酷達 小寫也算"),
    (en, "CUDA runs on NVIDIA GPUs", "Cuda runs on Nvidia GPUs"),  # en：CPU/GPU 不拆字母、GPUs 不比對
    (tw, "NVIDIA、AMD、Intel 都有", "Nvidia、A M D、intel 都有"),
    (tw, "Python 跑在 Linux 和 Windows", "Python 跑在 Linux 和 Windows"),
    # 邊界：不改到較長的字
    (tw, "Intelligence 與 CPUs", "Intelligence 與 CPUs"),
    (tw, "PyTorch 不是 Python", "PyTorch 不是 Python"),
    # 已手寫的逐字母寫法不再處理
    (tw, "G P U 很快", "G P U 很快"),
    # 字典沒有的縮寫：中文語音逐字母；英文語音不動
    (tw, "SSD 和 USB", "S S D 和 U S B"),
    (en, "SSD and USB", "SSD and USB"),
    # 中文緊貼英文：補空白，避免黏成一個詞
    (tw, "為什麼GPU不能", "為什麼 G P U 不能"),
    (tw, "Node.js 很常見", "Node 點 js 很常見"),
    (cn, "Node.js 很常见", "Node 点 js 很常见"),
    # 數字不動（交給 CosyVoice 的文字正規化）
    (tw, "RTX 4050 有 6 GB", "R T X 4050 有 6 G B"),
    (tw, "沒有英文", "沒有英文"),
]
bad = 0
for eng, src, want in cases:
    got = say(eng, src)
    ok = got == want
    bad += not ok
    print(("ok  " if ok else "FAIL"), eng.lang, repr(src), "→", repr(got), "" if ok else f"(want {want!r})")

# 原文不被修改、changes 記錄來源
orig = "為什麼 GPU 不能取代 CPU？"
t, ch = tw.apply(orig)
assert orig == "為什麼 GPU 不能取代 CPU？" and [c["from"] for c in ch] == ["GPU", "CPU"] and ch[0]["source"] == "pronunciation.json", ch

# 使用者覆寫：後載入者優先
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "my.json"
    p.write_text(json.dumps({"terms": [{"term": "CUDA", "kind": "product", "say": "Cuda"}, {"term": "Pikara", "kind": "brand", "say": "皮卡拉"}]}), encoding="utf-8")
    u = PronunciationEngine("zh-TW", extra_dicts=[p])
    got = u.apply("Pikara 用 CUDA")[0]
    assert got == "皮卡拉 用 Cuda", got

assert lang_for("en") == "en" and lang_for("zh", "t2s") == "zh-CN" and lang_for("zh", "s2twp") == "zh-TW"
try:
    PronunciationEngine("ja")
    raise AssertionError("unknown lang must fail")
except ValueError:
    pass
print(f"\n{len(cases) - bad}/{len(cases)} cases passed")
sys.exit(1 if bad else 0)
