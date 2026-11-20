"""由 narration.json + timeline.generated.json 產生 voiceover.md（配音稿）：python scripts/export_voiceover_md.py"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")
n = json.loads((ROOT / "src/data/narration.json").read_text(encoding="utf-8"))
tl = json.loads((ROOT / "src/data/timeline.generated.json").read_text(encoding="utf-8"))
v = n["voice"]


def ts(s: float) -> str:
    return f"{int(s // 60):02d}:{s % 60:05.2f}"


L = [
    "# Pikara Science EP01 配音稿",
    "",
    "《AI 是怎麼在你的電腦上運行的？深入理解 llama.cpp》",
    "",
    f"- 配音：Edge-TTS `{v['name']}`（台灣男聲），rate {v['rate']}、pitch {v['pitch']}、volume {v['volume']}；全片不更換配音員。",
    "- 單一資料來源：`src/data/narration.json`。改稿後執行 `npm run voiceover` → `npm run voiceover:sync`，動畫會依新的字詞時間自動對齊。",
    "- 「朗讀」只在與字幕不同時列出（英文技術名詞的念法），字幕保留原始拼寫。",
    "- 「錨點」是畫面事件的觸發詞：旁白念到該詞的那一幀，對應的動畫才開始。",
    "- 手動補配音：把錄音放在 `public/assets/audio/voiceover/manual/<段落>/<句子ID>.wav`，產生器會優先使用。",
    "",
]
for sid in ["ep01", "arttest"]:
    seq = n["sequences"][sid]
    t = tl.get(sid, {})
    lines = {l["id"]: l for l in t.get("lines", [])}
    scenes = {s["id"]: s for s in t.get("scenes", [])}
    L += [f"## {seq['title']}（`{sid}`）", ""]
    if t:
        est = sum(1 for l in t.get("lines", []) if l.get("estimated"))
        L += [f"> 總長 {t['duration']:.1f} 秒（{t['duration'] / 60:.1f} 分鐘）、{len(t['lines'])} 句、字幕 {len(t['cues'])} 段" + (f"；其中 {est} 句尚未產生音檔，時間為估算。" if est else "。"), ""]
    for sc in seq["scenes"]:
        span = scenes.get(sc["id"])
        head = f"### {sc['id']}　{sc.get('title', '')}"
        if span:
            head += f"　`{ts(span['start'])} – {ts(span['end'])}`"
        L += [head, ""]
        for line in sc["lines"]:
            tl_line = lines.get(line["id"])
            tag = ""
            if tl_line:
                tag = f"`{ts(tl_line['start'])}`　" + ("（估算）" if tl_line.get("estimated") else "")
            L.append(f"- **{line['id']}**　{tag}{line['subtitle']}")
            if line.get("speak"):
                L.append(f"  - 朗讀：{line['speak']}")
            if line.get("anchors"):
                L.append("  - 錨點：" + "、".join(f"`{k}`←「{w}」" for k, w in line["anchors"].items()))
        L.append("")
(ROOT / "voiceover.md").write_text("\n".join(L), encoding="utf-8")
print("voiceover.md 已更新")
