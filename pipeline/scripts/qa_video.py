"""
成片自動品質檢查：python scripts/qa_video.py <影片.mp4> [--seq ep01]

檢查項目（全部以 ffmpeg 實際分析成片，不是看設定）：
  1. 規格：解析度、幀率、幀數、編碼器、音訊格式、長度是否與時間軸一致
  2. 黑幀：blackdetect（> 0.25 秒的全黑片段；轉場中央的資料點畫面不算全黑）
  3. 長時間靜止畫面：freezedetect（> 4 秒幾乎不動 → 可能像投影片）
  4. 音訊：整體響度、真峰值（> -1.0 dBTP 視為爆音風險）、旁白區段內的異常長靜音（> 1.6 秒）
  5. 字幕：與旁白句子是否重疊、每段字數、最短顯示時間
輸出：out/qa/<影片名>.md
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")


def run(args: list[str]) -> str:
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    return r.stdout + r.stderr


def main() -> int:
    video = Path(sys.argv[1])
    seq = sys.argv[sys.argv.index("--seq") + 1] if "--seq" in sys.argv else "ep01"
    src = sys.argv[sys.argv.index("--src") + 1] if "--src" in sys.argv else "src"
    speed = float(sys.argv[sys.argv.index("--speed") + 1]) if "--speed" in sys.argv else 1.0
    tl = json.loads((ROOT / src / "data" / "timeline.generated.json").read_text(encoding="utf-8"))[seq]
    if speed != 1.0:  # 倍速版：時間軸所有時間 ÷ speed
        tl["duration"] /= speed
        for ln in tl["lines"]:
            ln["start"] /= speed
            ln["end"] /= speed
        for c in tl["cues"]:
            c["start"] /= speed
            c["end"] /= speed
    out = []
    problems = 0

    probe = json.loads(run(["ffprobe", "-v", "error", "-show_entries",
                            "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,sample_rate,channels:stream_tags=encoder:format=duration,bit_rate",
                            "-of", "json", str(video)]))
    v = next(s for s in probe["streams"] if s["codec_type"] == "video")
    a = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
    dur = float(probe["format"]["duration"])
    out += ["## 1. 規格", "",
            f"- 影像：{v['codec_name']} {v['width']}×{v['height']} @ {v['avg_frame_rate']}，{v.get('nb_frames')} 幀，編碼器標籤 `{v.get('tags', {}).get('encoder', '?')}`",
            f"- 音訊：{a['codec_name']} {a['sample_rate']} Hz {a['channels']} ch" if a else "- 音訊：**沒有音軌**",
            f"- 長度：{dur:.2f}s（時間軸 {tl['duration']:.2f}s，差 {dur - tl['duration']:+.2f}s）", ""]
    if not a:
        problems += 1
    if abs(dur - tl["duration"]) > 0.2:
        problems += 1
        out.append("- ⚠ 長度與時間軸不一致")

    # 2. 黑幀
    bd = run(["ffmpeg", "-hide_banner", "-i", str(video), "-vf", "blackdetect=d=0.25:pic_th=0.985:pix_th=0.06", "-an", "-f", "null", "-"])
    blacks = re.findall(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", bd)
    out += ["## 2. 黑幀（> 0.25 秒）", ""]
    out += [f"- {float(s):.2f}s → {float(e):.2f}s（{float(d):.2f}s）" for s, e, d in blacks] or ["- 無"]
    real_blacks = [b for b in blacks if float(b[0]) > 0.5 and float(b[1]) < dur - 1.0]
    problems += len(real_blacks)
    out.append("")

    # 3. 長時間靜止
    fz = run(["ffmpeg", "-hide_banner", "-i", str(video), "-vf", "scale=480:-2,freezedetect=n=0.0015:d=4", "-an", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", fz)]
    durs = [float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", fz)]
    out += ["## 3. 長時間幾乎靜止的畫面（> 4 秒）", ""]
    out += [f"- {s:.2f}s 起，持續 {d:.2f}s" for s, d in zip(starts, durs)] or ["- 無"]
    out.append("")

    # 4. 音訊
    if a:
        eb = run(["ffmpeg", "-hide_banner", "-i", str(video), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"])
        i_ = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", eb)[-1])
        tp = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", eb)[-1])
        sd = run(["ffmpeg", "-hide_banner", "-i", str(video), "-vn", "-af", "silencedetect=n=-45dB:d=1.6", "-f", "null", "-"])
        sil = list(zip([float(x) for x in re.findall(r"silence_start: ([\d.]+)", sd)], [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sd)]))
        in_voice = []
        for s, e in sil:
            for ln in tl["lines"]:
                if s < ln["end"] - 0.3 and e > ln["start"] + 0.3:
                    in_voice.append((s, e, ln["id"]))
        out += ["## 4. 音訊", "", f"- 整體響度 {i_:.1f} LUFS，真峰值 {tp:.1f} dBFS" + ("（⚠ 爆音風險）" if tp > -1.0 else "（無爆音風險）"),
                f"- 長於 1.6 秒的靜音段：{len(sil)} 段；落在旁白句子內的：{len(in_voice)} 段"]
        out += [f"  - ⚠ {s:.2f}–{e:.2f}s（{lid}）" for s, e, lid in in_voice]
        problems += len(in_voice) + (1 if tp > -1.0 else 0)
        out.append("")

    # 5. 字幕
    cues = tl["cues"]
    over = [c for c in cues if len(re.sub(r"\s", "", c["text"])) > 20]
    short = [c for c in cues if c["end"] - c["start"] < 0.8]
    overlap = [(x, y) for x, y in zip(cues, cues[1:]) if y["start"] < x["end"] - 0.01]
    out += ["## 5. 字幕", "", f"- 共 {len(cues)} 段；超過 20 字：{len(over)}；顯示少於 0.8 秒：{len(short)}；互相重疊：{len(overlap)}"]
    out += [f"  - 過長：{c['text']}" for c in over] + [f"  - 過短：{c['text']}（{c['end'] - c['start']:.2f}s）" for c in short]
    problems += len(overlap)
    out.append("")

    report = [f"# QA：{video.name}", "", f"自動檢出需注意的問題：**{problems}**（長時間靜止畫面僅供參考，需人工判斷）", ""] + out
    qa_dir = ROOT / "out" / "qa"
    qa_dir.mkdir(parents=True, exist_ok=True)
    (qa_dir / f"{video.stem}.md").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
