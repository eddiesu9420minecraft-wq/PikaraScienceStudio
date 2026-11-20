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
import shutil
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")


class QAError(Exception):
    """可預期的使用者錯誤：以繁體中文訊息結束，不顯示 Python Traceback。"""


def which(name: str) -> str | None:
    return shutil.which(name)


def run(args: list[str]) -> subprocess.CompletedProcess:
    """執行外部程式；stdout 與 stderr 分開保存（ffprobe 的 JSON 只在 stdout）。"""
    try:
        return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    except FileNotFoundError:
        raise QAError(f"找不到「{args[0]}」。請安裝 ffmpeg（含 ffprobe）並加入 PATH，例如：winget install Gyan.FFmpeg")


def run_text(args: list[str]) -> str:
    """ffmpeg 濾鏡（blackdetect 等）的結果寫在 stderr；回傳 stderr，失敗時報錯。"""
    r = run(args)
    if r.returncode != 0:
        raise QAError(f"ffmpeg 分析失敗（代碼 {r.returncode}）：{r.stderr.strip().splitlines()[-1] if r.stderr.strip() else '無錯誤訊息'}")
    return r.stderr


def opt(name: str, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else default


def infer_seq(video: Path) -> str | None:
    """由檔名推斷集數：EP02_Final.mp4 → ep02；TEST001_Final.mp4 → test001。"""
    t = re.search(r"(?i)\bTEST\s*0*(\d{1,3})", video.stem)
    if t:
        return f"test{int(t.group(1)):03d}"
    m = re.search(r"(?i)\bEP\s*0*(\d{1,3})", video.stem)
    return f"ep{int(m.group(1)):02d}" if m else None


def infer_src(video: Path) -> str:
    """簡體版（檔名含 zh-CN／Bilibili）使用 src_cn 的時間軸。"""
    return "src_cn" if re.search(r"(?i)zh-?cn|bilibili", video.name) else "src"


def probe_video(video: Path) -> dict:
    if not video.exists():
        raise QAError(f"找不到影片檔：{video}")
    if video.stat().st_size == 0:
        raise QAError(f"影片檔是空的（0 位元組）：{video}")
    if not which("ffprobe"):
        raise QAError("找不到 ffprobe。請安裝 ffmpeg（含 ffprobe）並加入 PATH，例如：winget install Gyan.FFmpeg")
    r = run(["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,sample_rate,channels:stream_tags=encoder:format=duration,bit_rate",
             "-of", "json", str(video)])
    if r.returncode != 0:
        msg = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "未知錯誤"
        raise QAError(f"ffprobe 無法讀取這個影片（可能已損壞或不是影片檔）：{msg}")
    try:
        probe = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise QAError("ffprobe 的輸出不是有效的 JSON，影片可能已損壞。")
    streams = probe.get("streams") or []
    if not any(s.get("codec_type") == "video" for s in streams):
        raise QAError("這個檔案沒有影像串流，可能已損壞或只有音訊。")
    try:
        float(probe["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        raise QAError("無法取得影片長度，檔案可能沒有寫完（渲染中斷）或已損壞。")
    # 完整性：解碼最後 1 秒。faststart 的 MP4 即使被截斷，檔頭仍記載完整長度，只有實際解碼才看得出來。
    tail = run(["ffmpeg", "-hide_banner", "-v", "error", "-sseof", "-1", "-i", str(video), "-map", "0:v:0", "-frames:v", "1", "-f", "framecrc", "-"])
    decoded = [ln for ln in tail.stdout.splitlines() if ln and not ln.startswith("#")]
    if tail.returncode != 0 or not decoded or re.search(r"(?i)(invalid|error|truncat|corrupt|moov)", tail.stderr):
        msg = tail.stderr.strip().splitlines()[-1] if tail.stderr.strip() else ("結尾沒有可解碼的畫面" if not decoded else f"ffmpeg 代碼 {tail.returncode}")
        raise QAError(f"影片檔不完整或已損壞（可能渲染、編碼或下載中斷），無法解碼結尾：{msg}")
    return probe


def load_timeline(src: str, seq: str) -> dict:
    path = ROOT / src / "data" / "timeline.generated.json"
    if not path.exists():
        raise QAError(f"找不到時間軸檔：{path.relative_to(ROOT)}。請先執行 build_timeline.py 產生時間軸。")
    try:
        all_tl = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise QAError(f"時間軸檔格式錯誤：{path.relative_to(ROOT)}（{e.msg}，第 {e.lineno} 行）")
    if seq not in all_tl:
        have = "、".join(k for k in all_tl if isinstance(all_tl[k], dict)) or "（無）"
        raise QAError(f"時間軸中沒有集數「{seq}」（{path.relative_to(ROOT)} 目前有：{have}）。請確認 --seq，或先為這一集產生時間軸。")
    return all_tl[seq]


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1].startswith("--"):
        raise QAError("用法：py -3.11 scripts/qa_video.py <影片.mp4> [--seq ep02] [--src src|src_cn] [--speed 1.5]")
    video = Path(sys.argv[1])
    if not video.is_absolute():
        video = (Path.cwd() / video).resolve()
    seq = opt("--seq") or infer_seq(video)
    if not seq:
        raise QAError(f"無法從檔名「{video.name}」判斷集數，請加上 --seq（例如 --seq ep02）。")
    src = opt("--src") or infer_src(video)
    probe = probe_video(video)
    tl = load_timeline(src, seq)
    dur_probe = float(probe["format"]["duration"])
    speed_arg = opt("--speed")
    if speed_arg is not None:
        try:
            speed = float(speed_arg)
        except ValueError:
            raise QAError(f"--speed 必須是數字，收到「{speed_arg}」")
    else:
        # 未指定時，依影片長度與時間軸長度自動判斷是否為倍速版
        ratio = tl["duration"] / dur_probe if dur_probe > 0 else 1.0
        speed = next((k for k in (1.0, 1.25, 1.5, 2.0) if abs(ratio - k) / k < 0.01), 1.0)
    print(f"[QA] 影片 {video.name}｜集數 {seq}｜時間軸 {src}｜倍速 {speed}")
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
    bd = run_text(["ffmpeg", "-hide_banner", "-i", str(video), "-vf", "blackdetect=d=0.25:pic_th=0.985:pix_th=0.06", "-an", "-f", "null", "-"])
    blacks = re.findall(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", bd)
    out += ["## 2. 黑幀（> 0.25 秒）", ""]
    out += [f"- {float(s):.2f}s → {float(e):.2f}s（{float(d):.2f}s）" for s, e, d in blacks] or ["- 無"]
    # 場景交界的短暫收合（iris「資料點」轉場）是設計，不算問題：≤ 1 秒、且距離場景交界 1 秒內
    bounds = [float(sc.get("start", 0)) / speed for sc in tl.get("scenes", [])[1:]]
    def at_boundary(b):
        s0, e0 = float(b[0]), float(b[1])
        return e0 - s0 <= 1.0 and any(s0 - 1.0 <= t <= e0 + 1.0 for t in bounds)
    real_blacks = [b for b in blacks if float(b[0]) > 0.5 and float(b[1]) < dur - 1.0 and not at_boundary(b)]
    n_trans = sum(1 for b in blacks if float(b[0]) > 0.5 and float(b[1]) < dur - 1.0 and at_boundary(b))
    if n_trans:
        out.append(f"- 其中 {n_trans} 段位於場景交界（轉場），不計入問題")
    problems += len(real_blacks)
    out.append("")

    # 3. 長時間靜止
    fz = run_text(["ffmpeg", "-hide_banner", "-i", str(video), "-vf", "scale=480:-2,freezedetect=n=0.0015:d=4", "-an", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", fz)]
    durs = [float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", fz)]
    out += ["## 3. 長時間幾乎靜止的畫面（> 4 秒）", ""]
    out += [f"- {s:.2f}s 起，持續 {d:.2f}s" for s, d in zip(starts, durs)] or ["- 無"]
    out.append("")

    # 4. 音訊
    if a:
        eb = run_text(["ffmpeg", "-hide_banner", "-i", str(video), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"])
        i_ = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", eb)[-1])
        tp = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", eb)[-1])
        sd = run_text(["ffmpeg", "-hide_banner", "-i", str(video), "-vn", "-af", "silencedetect=n=-45dB:d=1.6", "-f", "null", "-"])
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
    try:
        sys.exit(main())
    except QAError as e:
        print(f"[QA 錯誤] {e}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        print("[QA] 已取消", file=sys.stderr)
        sys.exit(130)
