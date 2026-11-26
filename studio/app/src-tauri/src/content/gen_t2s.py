# Regenerate t2s_chars.txt: every CJK character that OpenCC (t2s) changes, one "繁简" pair per line.
# Used by the requirement checker to compare Traditional and Simplified text (content/matcher.rs).
#   py -3.11 studio/app/src-tauri/src/content/gen_t2s.py      (needs `pip install opencc`)
import pathlib

import opencc

cc = opencc.OpenCC("t2s")
pairs = []
for cp in list(range(0x3400, 0x4DC0)) + list(range(0x4E00, 0xA000)) + list(range(0xF900, 0xFB00)):
    ch = chr(cp)
    s = cc.convert(ch)
    if s != ch and len(s) == 1:
        pairs.append(ch + s)
out = pathlib.Path(__file__).with_name("t2s_chars.txt")
out.write_text("\n".join(pairs) + "\n", encoding="utf-8")
print(len(pairs), "pairs →", out)
