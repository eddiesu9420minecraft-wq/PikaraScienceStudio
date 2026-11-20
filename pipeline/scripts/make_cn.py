"""
產生大陸簡體版原始碼樹：py -3.11 scripts/make_cn.py
  src/  →  src_cn/（所有 .ts/.tsx/.json 內的中文：先套用大陸科技用語對照表，再用 OpenCC tw2sp 轉換）
  字型改用 Noto Sans SC（SIL OFL 1.1）。
  narration.json 只保留 ep01，voiceEngine 改為 cosyvoice（音檔目錄由 build_timeline --voice-dir 指定）。
動畫程式碼完全相同，只換文字；改動 src 後重新執行即可同步。
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import opencc

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DST = ROOT / "src_cn"
sys.stdout.reconfigure(encoding="utf-8")

# 大陸常用科技用語（繁體原文 → 繁體中間詞；之後由 OpenCC 轉為簡體）。順序重要：長詞在前。
PRE = [
    ("顯示記憶體", "顯存"), ("系統記憶體", "系統內存"), ("記憶體頻寬", "內存帶寬"), ("頻寬", "帶寬"),
    ("載入記憶體", "加載到內存"), ("記憶體", "內存"), ("顯示卡", "顯卡"), ("筆電", "筆記本電腦"), ("中繼資料", "元數據"), ("資料中心", "數據中心"),
    ("網路封包", "網絡數據包"), ("封包", "數據包"), ("資料", "數據"), ("位元組", "字節"), ("位元數", "位數"),
    ("個位元", "位"), ("的位元", "的位數"), ("位元", "位"), ("檔頭", "文件頭"), ("檔案格式", "文件格式"), ("檔案", "文件"),
    ("函式庫", "庫"), ("命令列", "命令行"), ("分詞器", "分詞器"), ("詞彙表", "詞表"),
    ("取樣", "採樣"), ("晶片", "芯片"), ("硬碟", "硬盤"), ("伺服器", "服務器"), ("效能", "性能"), ("軟體", "軟件"),
    ("硬體", "硬件"), ("人工智慧", "人工智能"), ("螢幕", "屏幕"), ("滑鼠", "鼠標"), ("影片", "視頻"), ("網路", "網絡"),
    ("預設", "默認"), ("支援", "支持"), ("訊息", "消息"), ("介面", "界面"), ("示意圖", "示意圖"), ("消費級顯卡", "消費級顯卡"),
    ("演算法", "算法"), ("平行", "並行"), ("離線", "離線"), ("載入", "加載"), ("開源", "開源"), ("雲端", "雲端"),
]
CC = opencc.OpenCC("tw2sp")
# OpenCC 之後的修正（tw2sp 會把部分詞轉成不符本片語境的大陸用語）
POST = [("文档", "文件"), ("脱机", "离线"), ("回答品质", "回答质量"), ("品质", "质量"), ("矢量", "向量"), ("中文本", "中文字"),
        ("英文单字", "英文单词"), ("单字", "单词"), ("几率", "概率"), ("变回了文本", "变回了文字"), ("文本冒出来", "文字冒出来"),
        ("本机", "本地"), ("进程把它跑起来", "程序把它跑起来"), ("同一套进程", "同一套程序")]
CJK = re.compile(r"[　-〿㐀-鿿＀-￯「」『』]+")


def conv(text: str) -> str:
    for a, b in PRE:
        text = text.replace(a, b)
    text = CC.convert(text)
    for a, b in POST:
        text = text.replace(a, b)
    return text


def conv_code(code: str) -> str:
    # 只轉換含中文的片段，避免動到程式碼
    return CJK.sub(lambda m: conv(m.group(0)), code)


def main() -> int:
    if DST.exists():
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST, ignore=shutil.ignore_patterns("timeline.generated.json"))
    n = 0
    for p in DST.rglob("*"):
        if p.suffix in (".ts", ".tsx") and p.is_file():
            s = p.read_text(encoding="utf-8")
            t = conv_code(s)
            if t != s:
                p.write_text(t, encoding="utf-8")
                n += 1
    # 字型：Noto Sans SC
    f = DST / "theme" / "fonts.ts"
    f.write_text(f.read_text(encoding="utf-8").replace("NotoSansTC-VF.ttf", "NotoSansSC-VF.ttf").replace('"Noto Sans TC"', '"Noto Sans SC"').replace("Microsoft JhengHei", "Microsoft YaHei"), encoding="utf-8")
    # 旁白：逐句轉換字幕、朗讀文字與錨點詞（同一轉換函式，錨點必然仍出現在朗讀文字中）
    nar = json.loads((SRC / "data" / "narration.json").read_text(encoding="utf-8"))
    ep = nar["sequences"]["ep01"]
    ep["title"] = conv(ep["title"])
    ep["voiceEngine"] = "cosyvoice"
    for sc in ep["scenes"]:
        sc["title"] = conv(sc.get("title", ""))
        for line in sc["lines"]:
            line["subtitle"] = conv(line["subtitle"])
            if "speak" in line:
                line["speak"] = conv(line["speak"])
            line.pop("cosySpeed", None)  # 台灣版的逐句語速不沿用；大陸版由產生器統一校準
            if "anchors" in line:
                line["anchors"] = {k: conv(v) for k, v in line["anchors"].items()}
    nar["sequences"] = {"ep01": ep}
    (DST / "data" / "narration.json").write_text(json.dumps(nar, ensure_ascii=False, indent=2), encoding="utf-8")
    # 時間軸佔位（之後由 build_timeline --src src_cn 產生）
    tl = DST / "data" / "timeline.generated.json"
    if not tl.exists():
        tl.write_text(json.dumps({"ep01": json.loads((SRC / "data" / "timeline.generated.json").read_text(encoding="utf-8"))["ep01"]}, ensure_ascii=False), encoding="utf-8")
    print(f"src_cn 已產生：轉換 {n} 個程式檔、{sum(len(s['lines']) for s in ep['scenes'])} 句旁白")
    return 0


if __name__ == "__main__":
    sys.exit(main())
