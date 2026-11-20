"""
產生大陸簡體版原始碼樹：py -3.11 scripts/make_cn.py [--seq ep02 ...|all] [--reconvert]
  src/  →  src_cn/（所有 .ts/.tsx/.json 內的中文：先套用大陸科技用語對照表，再用 OpenCC tw2sp 轉換）
  字型改用 Noto Sans SC（SIL OFL 1.1）。
動畫程式碼完全相同，只換文字；改動 src 後重新執行即可同步程式碼。

繁體（src）與簡體（src_cn）的旁白各自管理：
  - src_cn/data/narration.json 已有的集數「不會」被覆寫（保留簡體版的手動修改）；
    只有 src_cn 還沒有的集數才會由繁體稿轉換產生（voiceEngine = cosyvoice）。
  - --seq 只處理指定集數（預設：src 中所有 epNN 集數）；--reconvert 才會用繁體稿重新轉換並覆寫指定集數。
  - src_cn/data/timeline.generated.json（由真實簡中配音建立）每一集都保留，不會被覆寫。
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

try:
    import opencc
except ImportError:
    print("[錯誤] 缺少 opencc 套件。請執行：py -3.11 -m pip install opencc-python-reimplemented")
    sys.exit(1)

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


def retry(fn, tries: int = 6):
    """Windows 上防毒或索引程式可能暫時鎖住剛建立的檔案（Errno 13/22）：稍等後重試。"""
    import time
    for i in range(tries):
        try:
            return fn()
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(0.5 * (i + 1))


def write_retry(p: Path, data: bytes) -> None:
    retry(lambda: p.write_bytes(data))


EPISODE = re.compile(r"^ep\d{2,3}$")


def convert_seq(ep: dict) -> dict:
    ep = json.loads(json.dumps(ep, ensure_ascii=False))
    ep["title"] = conv(ep.get("title", ""))
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
    return ep


def main() -> int:
    args = sys.argv[1:]
    want: list[str] = []
    for i, a in enumerate(args):
        if a == "--seq" and i + 1 < len(args):
            want += [x for x in args[i + 1].split(",") if x]
    reconvert = "--reconvert" in args
    src_nar = json.loads((SRC / "data" / "narration.json").read_text(encoding="utf-8"))
    src_seqs = src_nar.get("sequences", {})
    if not want or want == ["all"]:
        want = [k for k in src_seqs if EPISODE.match(k)]
    missing = [k for k in want if k not in src_seqs]
    if missing:
        print(f"[錯誤] src/data/narration.json 沒有這些集數：{'、'.join(missing)}（現有：{'、'.join(src_seqs)}）")
        return 1
    # 保留簡體版既有旁白（各集獨立管理）
    nar_keep = None
    nar_path = DST / "data" / "narration.json"
    if nar_path.exists():
        try:
            nar_bytes = nar_path.read_bytes()
            nar_keep = json.loads(nar_bytes.decode("utf-8"))
        except json.JSONDecodeError as e:
            print(f"[錯誤] src_cn/data/narration.json 不是有效 JSON（{e}），為避免覆蓋簡體稿，已停止。請先修正該檔。")
            return 1
    # 保留已產生的簡體時間軸（由真實簡中配音建立），重新轉換程式碼時不可覆蓋
    tl_keep = None
    tl_path = DST / "data" / "timeline.generated.json"
    if tl_path.exists():
        tl_keep = tl_path.read_bytes()
    # 先在暫存資料夾完整產生，成功後才替換 src_cn（中途失敗不會留下半套 src_cn，也不會遺失簡體稿與時間軸）
    stage = ROOT / ".src_cn.building"
    if stage.exists():
        shutil.rmtree(stage)
    shutil.copytree(SRC, stage, ignore=shutil.ignore_patterns("timeline.generated.json"))
    n = 0
    for p in stage.rglob("*"):
        if p.suffix in (".ts", ".tsx") and p.is_file():
            s = p.read_text(encoding="utf-8")
            t = conv_code(s)
            if t != s:
                write_retry(p, t.encode("utf-8"))
                n += 1
    # 字型：Noto Sans SC
    f = stage / "theme" / "fonts.ts"
    write_retry(f, f.read_text(encoding="utf-8").replace("NotoSansTC-VF.ttf", "NotoSansSC-VF.ttf").replace('"Noto Sans TC"', '"Noto Sans SC"').replace("Microsoft JhengHei", "Microsoft YaHei").encode("utf-8"))
    # 旁白：既有簡體集數保留；缺少的集數（或 --reconvert 指定的集數）由繁體稿逐句轉換
    #（同一轉換函式處理字幕、朗讀文字與錨點詞，錨點必然仍出現在朗讀文字中）
    out = nar_keep if nar_keep is not None else {k: v for k, v in src_nar.items() if k != "sequences"}
    out.setdefault("sequences", {})
    made, kept = [], []
    for k in want:
        if k in out["sequences"] and not reconvert:
            kept.append(k)
            continue
        out["sequences"][k] = convert_seq(src_seqs[k])
        made.append(k)
    if made or nar_keep is None:
        write_retry(stage / "data" / "narration.json", json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))
    else:
        write_retry(stage / "data" / "narration.json", nar_bytes)  # 沒有變更：原樣寫回（位元組不變）
    # 時間軸：沿用既有的簡體時間軸（所有集數）；沒有時寫入空物件（之後由 build_timeline --src src_cn 產生）
    write_retry(stage / "data" / "timeline.generated.json", tl_keep if tl_keep is not None else b"{}")
    # 替換：src_cn → .src_cn.old，暫存 → src_cn，再刪除舊的
    old = ROOT / ".src_cn.old"
    if old.exists():
        shutil.rmtree(old)
    if DST.exists():
        retry(lambda: DST.rename(old))
    retry(lambda: stage.rename(DST))
    shutil.rmtree(old, ignore_errors=True)
    n_lines = sum(len(sc["lines"]) for k in made for sc in out["sequences"][k]["scenes"])
    print(f"src_cn 已產生：轉換 {n} 個程式檔；旁白新轉換 {len(made)} 集（{'、'.join(made) or '無'}，{n_lines} 句），"
          f"保留簡體既有 {len(kept)} 集（{'、'.join(kept) or '無'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
