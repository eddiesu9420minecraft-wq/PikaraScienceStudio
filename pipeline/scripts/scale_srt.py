"""SRT 時間戳縮放：py -3.11 scripts/scale_srt.py in.srt out.srt 1.5   （1.5 倍速 → 所有時間 ÷ 1.5）"""
import re
import sys

src, dst, speed = sys.argv[1], sys.argv[2], float(sys.argv[3])


def scale(m: re.Match) -> str:
    h, mi, s, ms = map(int, m.groups())
    t = ((h * 60 + mi) * 60 + s) * 1000 + ms
    t = round(t / speed)
    return f"{t // 3600000:02d}:{t // 60000 % 60:02d}:{t // 1000 % 60:02d},{t % 1000:03d}"


text = open(src, encoding="utf-8").read()
out = re.sub(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})", scale, text)
open(dst, "w", encoding="utf-8").write(out)
print(f"{dst}：時間 ÷ {speed}")
