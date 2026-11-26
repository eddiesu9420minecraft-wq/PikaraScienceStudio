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

# ---- 旁白語速（2026-11-24）----
# 「正常」語速以每個語言的實測正常值定義：zh-CN 4.4 字/秒（EP01–EP11 簡中版的實際中位數 4.3–5.0）；
# zh-TW 維持 CosyVoice 參考聲音的自然語速（不設目標）。CosyVoice 本身的 speed 參數是頻譜內插，>1.15 會糊字，
# 所以不再用它加速；改在這裡對「複本」做保留音高的時間伸縮（voice_tempo.py，Rubber Band），原始配音檔不動。
# 整集用同一個倍率（保留句子之間自然的快慢差異）；只會加快到正常語速，不會為了配合動畫長度而放慢或加快。
# 使用者的語速設定（0.9／1.0／1.1／1.2）乘在正常語速上：PIKARA_VOICE_TEMPO 或 --voice-tempo。
NORMAL_CPS = {"src_cn": 4.4}
VOICE_TEMPO = float(_arg("--voice-tempo", os.environ.get("PIKARA_VOICE_TEMPO", "1.0")) or 1.0)
_ncps = _arg("--normal-cps")
NORMAL = float(_ncps) if _ncps else NORMAL_CPS.get(_arg("--src", "src"))


# ---- 時間格點（v0.3）----
# 每句開始時間、每幕邊界、總長都對齊 0.1 秒格點（60fps 的 6 幀＝30fps 的 3 幀＝YT15 的 2 幀）。
# 這樣某一句重新配音、長度改變時，後面所有句子與場景只會「整格平移」，各場景內部的畫面完全相同，
# render.mjs 可以把它們的已渲染幀搬到新位置沿用，只重算真的改變的場景。對齊造成的時間差 ≤ 0.1 秒（停頓稍長），聽不出來。
GRID = float(_arg("--grid", os.environ.get("PIKARA_TIMELINE_GRID", "0.1")) or 0)


def snap(x: float, up: bool = True) -> float:
    if GRID <= 0:
        return x
    ms, g = round(x * 1000), round(GRID * 1000)
    q = -(-ms // g) if up else (ms + g // 2) // g
    return q * g / 1000


def speech_units(t: str) -> int:
    """語速用的字數：中日韓字＋英文單字＋數字串（與 voice_speed_check.py 相同）。"""
    return len(re.findall(r"[一-鿿]", t)) + len(re.findall(r"[A-Za-z]+|\d+", t))


def episode_tempo(raw: list[tuple[str, float]], normal_cps: float | None, preset: float) -> dict:
    """raw：[(字幕, 原始秒數)]。回傳 {tempo, rawCps, targetCps, preset}。
    base＝把整集中位語速拉到正常值所需的倍率，只加快不放慢（已經夠快的舊集數＝1.0，避免重複加速）。"""
    import statistics
    cps = [speech_units(t) / d for t, d in raw if d > 0.3 and speech_units(t) >= 4]
    med = statistics.median(cps) if cps else None
    base = max(1.0, normal_cps / med) if (normal_cps and med) else 1.0
    if base < 1.05:  # 已在正常語速 5% 內（例如舊集數以 CosyVoice speed 1.4–1.6 產生的音檔）：不再加速、不重新編碼
        base = 1.0
    from voice_tempo import TEMPO_MAX, TEMPO_MIN
    tempo = round(min(TEMPO_MAX, max(TEMPO_MIN, base * preset)), 3)
    return {"tempo": tempo, "rawCps": round(med, 2) if med else None, "targetCps": round(normal_cps * preset, 2) if normal_cps else None,
            "preset": preset, "base": round(base, 3)}


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
    raw = [(ln["subtitle"], ffprobe_duration(VO_DIR / seq_id / f"{ln['id']}.mp3")) for sc in seq["scenes"] for ln in sc["lines"]
           if (VO_DIR / seq_id / f"{ln['id']}.mp3").exists()]
    vt = episode_tempo(raw, NORMAL, VOICE_TEMPO)
    tempo = vt["tempo"]
    if raw:
        print(f"[{seq_id}] 旁白語速：原始中位 {vt['rawCps']} 字/s"
              + (f"，正常 {NORMAL} 字/s" if NORMAL else "（自然語速）")
              + f"，設定 ×{VOICE_TEMPO} → 倍率 ×{tempo}"
              + ("（Rubber Band 保留音高，原始檔不變）" if abs(tempo - 1) >= 1e-3 else "（不伸縮）"))
    if abs(tempo - 1) >= 1e-3:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from voice_tempo import ensure_tempo
    t = snap(d["leadIn"])
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
            src_mp3 = mp3
            if mp3.exists() and abs(tempo - 1) >= 1e-3:
                mp3 = ensure_tempo(mp3, tempo)  # 從原始檔產生（或取快取），不會對已調速的檔案再套一次
            if mp3.exists():
                dur = ffprobe_duration(mp3)
            if meta.get("speak") not in (None, speak):
                warnings.append(f"{line['id']}：音檔與目前文字不一致，請重新產生")
            bnd = meta.get("boundaries") or []
            if bnd and mp3 != src_mp3:  # 逐字時間跟著縮放
                bnd = [{**b, "start": b["start"] / tempo, "end": b["end"] / tempo} for b in bnd]
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
                "tempo": tempo if mp3 != src_mp3 else 1.0, "sourceAudio": src_mp3.relative_to(ROOT / "public").as_posix(),
            })
            cues_out += line_cues
            last_line = li == len(scene["lines"]) - 1
            if last_line:
                span["voiceEnd"] = round(t + dur, 3)
            pause = line.get("pauseAfter", d["sceneGap"] if last_line else d["pauseAfter"])
            if last_line:
                span["gapAfter"] = pause
            t = snap(t + dur + pause)
        scene_spans.append(span)
    total = snap(t - (pause if lines_out else 0) + d["tail"])
    # 每一幕的畫面範圍：在兩幕之間的停頓正中間切開（第一幕從 0、最後一幕到結尾）。
    # 切點＝本幕旁白開始 − 停頓的一半（停頓長度來自腳本，與上一幕的音檔長度無關），所以上一幕某句重新配音、
    # 長度改變時，本幕的開頭不會跟著變動（v0.3：只重新渲染真的改變的場景）。GRID=0 時維持原本的中點算法。
    for i, sp in enumerate(scene_spans):
        def cut(k):  # 第 k 幕的開始
            if GRID <= 0:
                return (scene_spans[k - 1]["voiceEnd"] + scene_spans[k]["voiceStart"]) / 2
            return snap(scene_spans[k]["voiceStart"] - snap(scene_spans[k - 1].get("gapAfter", d["sceneGap"]) / 2, up=False), up=False)
        start = 0.0 if i == 0 else cut(i)
        end = total if i == len(scene_spans) - 1 else cut(i + 1)
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
        "voiceTempo": {**vt, "method": "rubberband (pitch/formant preserved)" if abs(tempo - 1) >= 1e-3 else "none"},
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
    ap.add_argument("--voice-tempo", type=float, default=None, help="旁白語速設定 0.9／1.0／1.1／1.2（相對於正常語速；預設讀 PIKARA_VOICE_TEMPO，否則 1.0）")
    ap.add_argument("--normal-cps", type=float, default=None, help="正常語速（字/秒）；預設 src_cn＝4.4，其他＝不設目標（自然語速）")
    ap.add_argument("--grid", type=float, default=None, help="時間格點秒數（預設 0.1；0＝不對齊）")
    ap.add_argument("--out", default=None, help="試算：只把這一集的時間軸寫到這個檔案，不改 timeline.generated.json、不寫 SRT（重新渲染前的計畫用）")
    a = ap.parse_args()
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    existing = json.loads(OUT_JSON.read_text(encoding="utf-8")) if OUT_JSON.exists() else {}
    if a.seq != "all" and a.seq not in data["sequences"]:
        raise SystemExit(f"[錯誤] {NARRATION.relative_to(ROOT)} 沒有 sequences.{a.seq}（現有：{'、'.join(data['sequences'])}）")
    seqs = data["sequences"] if a.seq == "all" else {a.seq: data["sequences"][a.seq]}
    if a.out:
        if a.seq == "all":
            raise SystemExit("[錯誤] --out 只能用在單一集數")
        tl = build(a.seq, seqs[a.seq], data)
        if existing.get(a.seq, {}).get("mix"):
            tl["mix"] = existing[a.seq]["mix"]
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps({a.seq: tl}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{a.seq}] 試算時間軸 → {a.out}：總長 {tl['duration']:.2f}s（{tl['totalFrames']} 幀）")
        return 0
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
