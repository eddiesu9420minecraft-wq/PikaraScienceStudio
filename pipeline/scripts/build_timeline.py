"""
由「實際音檔」建立時間軸：python scripts/build_timeline.py [--seq arttest|ep01|all]

流程：narration.json + 每句 MP3 的 ffprobe 長度 + Edge-TTS WordBoundary
  → 每句起訖時間、字幕分段（依標點與字數）、具名錨點（例如「GPU」一詞被念出的那一幀）
  → src/data/timeline.generated.json（Remotion 直接 import）
  → out/subtitles/<seq>.srt

動畫不寫死秒數：Remotion 端用錨點把動畫的「樣板時間」映射到旁白的實際時間。
換成真人錄音：把 MP3/WAV 放到同樣路徑並移除對應 .json 的 boundaries，
本腳本會改用字數比例估算字幕與錨點（會印出警告）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def _arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


SRC = ROOT / _arg("--src", "src")  # 例：--src src_cn（大陸簡體版）
VOICE_DIR_OVERRIDE = _arg("--voice-dir")  # 例：--voice-dir public/assets/audio/voiceover_cosy_cn
SRT_NAME = _arg("--srt-name")
NARRATION = SRC / "data" / "narration.json"
VO_DIRS = {  # narration.json sequences.<seq>.voiceEngine 選擇旁白來源（預設 edge）
    "edge": ROOT / "public" / "assets" / "audio" / "voiceover",
    "cosyvoice": ROOT / "public" / "assets" / "audio" / "voiceover_cosy",
}
OUT_JSON = SRC / "data" / "timeline.generated.json"
SRT_DIR = ROOT / "out" / "subtitles"
MAX_CUE_CHARS = 18  # 1920 寬、44px 字幕，一行約 30 字；18 字以內閱讀較舒適
PUNCT = "，。？！；：、,.?!;:「」『』（）() "

sys.stdout.reconfigure(encoding="utf-8")
ESTIMATE = "--estimate" in sys.argv


def norm(s: str) -> str:
    return "".join(ch for ch in s if ch not in PUNCT and not ch.isspace()).lower()


def ffprobe_duration(p: Path) -> float:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                           capture_output=True, text=True)
    except FileNotFoundError:
        raise SystemExit("[錯誤] 找不到 ffprobe。請安裝 ffmpeg（含 ffprobe）並加入 PATH，例如：winget install Gyan.FFmpeg")
    if r.returncode != 0 or not r.stdout.strip():
        raise SystemExit(f"[錯誤] 無法讀取音檔：{p}")
    return float(r.stdout.strip())


def char_times(speak: str, boundaries: list[dict], duration: float) -> list[tuple[float, float]]:
    """回傳 norm(speak) 每個字元的 (start, end) 秒。有邊界時精確對齊，否則按比例。"""
    target = norm(speak)
    n = len(target)
    times: list[tuple[float, float] | None] = [None] * n
    pos = 0
    for b in [b for b in boundaries if b["type"] == "WordBoundary"]:
        w = norm(b["text"])
        if not w:
            continue
        idx = target.find(w, pos)
        if idx < 0:
            continue
        span = (b["end"] - b["start"]) / len(w)
        for k in range(len(w)):
            times[idx + k] = (b["start"] + span * k, b["start"] + span * (k + 1))
        pos = idx + len(w)
    # 補洞：線性內插
    last = 0.0
    for i in range(n):
        if times[i] is None:
            nxt = next((times[j][0] for j in range(i + 1, n) if times[j] is not None), duration)
            gap = [j for j in range(i, n) if times[j] is None]
            run = 1
            while i + run < n and times[i + run] is None:
                run += 1
            step = (nxt - last) / (run + 1)
            for k in range(run):
                times[i + k] = (last + step * (k + 0.5), last + step * (k + 1.5))
        last = times[i][1]
    return times  # type: ignore[return-value]


LANG_EN = os.environ.get("PIKARA_LANG", "zh").lower().startswith("en")
MAX_CUE_EN = 46  # 英文：不含空白的字母數（約 8–9 個單字、一行）


def split_cues(text: str) -> list[str]:
    if LANG_EN:
        # 英文：在後面接空白（或結尾）的標點處斷開，避免拆開 3.5、e.g. 之類的寫法
        parts = [p for p in re.findall(r".+?(?:[,.?!;:](?=\s|$)|$)", text.strip()) if p.strip()]
        cues_en: list[str] = []
        cur = ""
        for p in parts:
            for w in p.split():
                if cur and len(norm(cur + w)) > MAX_CUE_EN:
                    cues_en.append(cur.strip())
                    cur = ""
                cur += w + " "
            if cur and (re.search(r"[.?!;:]\s*$", cur) or len(norm(cur)) >= MAX_CUE_EN // 2):
                cues_en.append(cur.strip())
                cur = ""
        if cur.strip():
            cues_en.append(cur.strip())
        return [re.sub(r"[,;:]$", "", c).strip() for c in cues_en]
    parts = re.findall(r"[^，。？！；：、]+[，。？！；：、]?", text)
    cues: list[str] = []
    cur = ""
    for p in parts:
        if cur and len(norm(cur + p)) > MAX_CUE_CHARS:
            cues.append(cur)
            cur = p
        else:
            cur += p
    if cur:
        cues.append(cur)
    # 字幕尾端不保留逗號、頓號（句號問號保留）
    return [re.sub(r"[，、；：]$", "", c).strip() for c in cues]


def build(seq_id: str, seq: dict, data: dict) -> dict:
    fps = data["fps"]
    engine = seq.get("voiceEngine", "edge")
    if engine not in VO_DIRS:
        raise SystemExit(f"[錯誤] {seq_id} 的 voiceEngine「{engine}」不支援（可用：{'、'.join(VO_DIRS)}）")
    VO_DIR = ROOT / VOICE_DIR_OVERRIDE if VOICE_DIR_OVERRIDE else VO_DIRS[engine]
    print(f"[{seq_id}] 旁白來源：{engine}（{VO_DIR.relative_to(ROOT).as_posix()}）")
    d = {**data["defaults"], **{k: v for k, v in seq.items() if k in data["defaults"]}}
    t = d["leadIn"]
    lines_out, cues_out, anchors, warnings = [], [], {}, []
    scene_spans: list[dict] = []
    for si, scene in enumerate(seq["scenes"]):
        span = {"id": scene["id"], "title": scene.get("title", ""), "voiceStart": round(t, 3), "anchors": {}}
        for li, line in enumerate(scene["lines"]):
            meta_p = VO_DIR / seq_id / f"{line['id']}.json"
            mp3 = VO_DIR / seq_id / f"{line['id']}.mp3"
            speak = line.get("speak") or line["subtitle"]
            if not mp3.exists():
                if not ESTIMATE:
                    raise SystemExit(f"[錯誤] 缺少音檔 {mp3.relative_to(ROOT)}，請先執行 npm run voiceover")
                # 估算模式：依實測語速（約 5.3 字／秒）估計，供動畫先行製作；有音檔後重建即可自動對齊
                meta, dur = {}, len(norm(speak)) / 5.3 + 0.35
                warnings.append(f"{line['id']}：尚無音檔，使用估算長度 {dur:.2f}s")
            else:
                meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}
                dur = ffprobe_duration(mp3)
            if meta.get("speak") not in (None, speak):
                warnings.append(f"{line['id']}：音檔與目前文字不一致，請重新產生")
            bnd = meta.get("boundaries") or []
            if not bnd:
                warnings.append(f"{line['id']}：沒有時間邊界，字幕與錨點以字數比例估算")
            ct = char_times(speak, bnd, dur)
            n_speak = len(norm(speak))
            same = norm(speak) == norm(line["subtitle"])

            def time_at_sub_char(i_sub: int, n_sub: int, end: bool) -> float:
                i = i_sub if same else min(n_speak - 1, round(i_sub / max(1, n_sub) * n_speak))
                i = max(0, min(n_speak - 1, i))
                return ct[i][1] if end else ct[i][0]

            sub_norm_len = len(norm(line["subtitle"]))
            consumed = 0
            line_cues = []
            for ci, cue in enumerate(split_cues(line["subtitle"])):
                cl = len(norm(cue))
                s = time_at_sub_char(consumed, sub_norm_len, False) if ci else 0.0
                e = time_at_sub_char(consumed + cl - 1, sub_norm_len, True)
                consumed += cl
                line_cues.append({"text": cue, "start": round(t + s, 3), "end": round(t + e, 3)})
            # 字幕最短顯示 0.9 秒，並延到下一段開始前（避免閃爍）
            for k, c in enumerate(line_cues):
                nxt = line_cues[k + 1]["start"] if k + 1 < len(line_cues) else t + dur + 0.3
                c["end"] = round(max(c["end"], min(nxt, c["start"] + 0.9)), 3)
                if k + 1 < len(line_cues):
                    c["end"] = round(nxt, 3)
            for name, word in (line.get("anchors") or {}).items():
                idx = norm(speak).find(norm(word))
                if idx < 0:
                    raise SystemExit(f"[錯誤] {line['id']} 找不到錨點詞「{word}」")
                a_ = {"time": round(t + ct[idx][0], 3), "frame": round((t + ct[idx][0]) * fps), "line": line["id"], "word": word}
                anchors.setdefault(name, a_)
                if name in span["anchors"]:
                    raise SystemExit(f"[錯誤] {scene['id']} 錨點名稱重複：{name}")
                span["anchors"][name] = a_
            lines_out.append({
                "id": line["id"], "scene": scene["id"], "subtitle": line["subtitle"], "speak": speak,
                "audio": mp3.relative_to(ROOT / "public").as_posix(), "start": round(t, 3), "duration": round(dur, 3),
                "end": round(t + dur, 3), "startFrame": round(t * fps), "durationFrames": round(dur * fps),
                "voice": meta.get("voice"), "timingSource": ("edge-tts WordBoundary" if engine == "edge" else "cosyvoice3 + whisper alignment") if bnd else "proportional",
                "estimated": not mp3.exists(),
            })
            cues_out += line_cues
            last_line = li == len(scene["lines"]) - 1
            if last_line:
                span["voiceEnd"] = round(t + dur, 3)
            pause = line.get("pauseAfter", d["sceneGap"] if last_line else d["pauseAfter"])
            t += dur + pause
        scene_spans.append(span)
    total = t - (pause if lines_out else 0) + d["tail"]
    # 每一幕的畫面範圍：從上一幕旁白結束與本幕旁白開始的中間點切開（第一幕從 0、最後一幕到結尾）
    for i, sp in enumerate(scene_spans):
        start = 0.0 if i == 0 else (scene_spans[i - 1]["voiceEnd"] + sp["voiceStart"]) / 2
        end = total if i == len(scene_spans) - 1 else (sp["voiceEnd"] + scene_spans[i + 1]["voiceStart"]) / 2
        sp["start"], sp["end"] = round(start, 3), round(end, 3)
        sp["startFrame"], sp["endFrame"] = round(start * fps), round(end * fps)
        sp["durationFrames"] = sp["endFrame"] - sp["startFrame"]
        for a_ in sp["anchors"].values():
            a_["local"] = a_["frame"] - sp["startFrame"]
    for c in cues_out:
        c["from"] = round(c["start"] * fps)
        c["to"] = round(c["end"] * fps)
    return {
        "id": seq_id, "fps": fps, "voiceEngine": engine, "duration": round(total, 3), "totalFrames": round(total * fps),
        "lines": lines_out, "cues": cues_out, "anchors": anchors, "scenes": scene_spans, "warnings": warnings,
    }


def srt_time(s: float) -> str:
    ms = round(s * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", default="arttest")
    ap.add_argument("--estimate", action="store_true", help="缺少音檔時以字數估算（僅供動畫先行製作）")
    ap.add_argument("--src", default="src")
    ap.add_argument("--voice-dir", default=None)
    ap.add_argument("--srt-name", default=None)
    a = ap.parse_args()
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    existing = json.loads(OUT_JSON.read_text(encoding="utf-8")) if OUT_JSON.exists() else {}
    if a.seq != "all" and a.seq not in data["sequences"]:
        raise SystemExit(f"[錯誤] {NARRATION.relative_to(ROOT)} 沒有 sequences.{a.seq}（現有：{'、'.join(data['sequences'])}）")
    seqs = data["sequences"] if a.seq == "all" else {a.seq: data["sequences"][a.seq]}
    SRT_DIR.mkdir(parents=True, exist_ok=True)
    for sid, seq in seqs.items():
        tl = build(sid, seq, data)
        if existing.get(sid, {}).get("mix"):
            tl["mix"] = existing[sid]["mix"]  # 保留既有混音路徑；時間軸改變後請重新執行 mix_audio.py
            print("   提醒：時間軸已更新，請重新執行 npm run voiceover:mix 讓混音對齊")
        existing[sid] = tl
        with open(SRT_DIR / f"{SRT_NAME or sid}.srt", "w", encoding="utf-8") as f:
            for i, c in enumerate(tl["cues"], 1):
                f.write(f"{i}\n{srt_time(c['start'])} --> {srt_time(c['end'])}\n{c['text']}\n\n")
        print(f"[{sid}] {len(tl['lines'])} 句、{len(tl['cues'])} 段字幕、總長 {tl['duration']:.2f}s（{tl['totalFrames']} 幀）")
        for sp in tl["scenes"]:
            print(f"   {sp['id']:<6} {sp['start']:7.2f}s → {sp['end']:7.2f}s  ({sp['durationFrames']} 幀, {len(sp['anchors'])} 錨點)")
        for w in tl["warnings"]:
            print(f"   ! {w}")
    OUT_JSON.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
