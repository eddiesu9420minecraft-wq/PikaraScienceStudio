# 旁白語速逐階段對照：原始配音檔 → 最終影片。
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/voice_speed_check.py --seq ep15 --src src_cn --mp4 <影片> [--lines 8] [--json out.json]
# 每句：原始檔長度、取樣率、字/秒；在影片中找到同一句（時間軸 start），以能量包絡在 0.55–1.25 倍間搜尋最佳時間伸縮比，
# 以 YIN 量測中位音高比。正常應為：伸縮比 1.000±0.01、音高比 1.00±0.03（只要不是 1 就代表某一階段改了速度或音高）。
# 也可以用 --wav 比對任何混音檔（例如 public/assets/audio/mix/ep15_cn.wav）。
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SR = 16000
HOP = 160  # 10 ms


def decode(path, start=None, dur=None, sr=SR) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, start):.3f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=120).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def probe(path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,codec_name:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True, timeout=60)
    j = json.loads(r.stdout)
    return {"sr": int(j["streams"][0]["sample_rate"]), "codec": j["streams"][0]["codec_name"], "dur": float(j["format"]["duration"])}


def envelope(x: np.ndarray) -> np.ndarray:
    n = len(x) // HOP
    e = np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(axis=1) + 1e-10)
    e = np.log(e)
    e = np.diff(e, prepend=e[0]).clip(min=0)  # 起音（onset）強度：對背景音樂的穩定能量不敏感
    return (e - e.mean()) / (e.std() + 1e-9)


def best_stretch(raw: np.ndarray, seg: np.ndarray) -> tuple[float, float, float]:
    """回傳（伸縮比、在片段中的位移秒數、相關係數）；伸縮比 >1 代表影片中這句被拉長（變慢）。"""
    er, es = envelope(raw), envelope(seg)
    best = (1.0, 0.0, -1.0)
    for ratio in np.arange(0.55, 1.2501, 0.0025):  # 0.55＝最快 1.8 倍；1.25＝慢 20%
        m = int(round(len(er) * ratio))
        if m < 10 or m > len(es):
            continue
        r = np.interp(np.linspace(0, len(er) - 1, m), np.arange(len(er)), er)
        c = np.correlate(es, r, mode="valid") / m
        k = int(c.argmax())
        if c[k] > best[2]:
            best = (float(ratio), k * HOP / SR, float(c[k]))
    return best


def median_f0(x: np.ndarray) -> float | None:
    import librosa
    f0 = librosa.yin(x, fmin=70, fmax=500, sr=SR, frame_length=1024, hop_length=HOP)
    rms = librosa.feature.rms(y=x, frame_length=1024, hop_length=HOP)[0][: len(f0)]
    v = f0[: len(rms)][rms > np.percentile(rms, 60)]
    return float(np.median(v)) if len(v) else None


def units(t: str) -> int:
    return len(re.findall(r"[一-鿿]", t)) + len(re.findall(r"[A-Za-z]+|\d+", t))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", required=True)
    ap.add_argument("--src", default="src")
    ap.add_argument("--mp4", help="最終影片（或任何含音訊的檔案）")
    ap.add_argument("--wav", help="改為比對混音檔")
    ap.add_argument("--lines", type=int, default=8, help="平均分布抽查幾句（0＝全部）")
    ap.add_argument("--root", default=str(ROOT), help="專案根目錄（時間軸與音檔的位置）")
    ap.add_argument("--timeline", help="時間軸檔（預設 <root>/<src>/data/timeline.generated.json）")
    ap.add_argument("--json")
    a = ap.parse_args()
    root = Path(a.root)
    tl = json.loads(Path(a.timeline or root / a.src / "data" / "timeline.generated.json").read_text(encoding="utf-8"))[a.seq]
    lines = tl["lines"]
    if a.lines and len(lines) > a.lines:
        idx = np.linspace(0, len(lines) - 1, a.lines).round().astype(int)
        lines = [lines[i] for i in sorted(set(idx))]
    target = Path(a.mp4 or a.wav)
    out = []
    for ln in lines:
        mp3 = root / "public" / (ln.get("sourceAudio") or ln["audio"])  # 一律和「原始」配音檔比
        tempo = float(ln.get("tempo") or 1.0)
        p = probe(mp3)
        raw = decode(mp3)
        u = units(ln["subtitle"])
        seg = decode(target, ln["start"] - 0.4, p["dur"] * 1.3 + 0.8)
        ratio, off, corr = best_stretch(raw, seg)
        a0 = int((off) * SR)
        s_al = seg[a0: a0 + int(len(raw) * ratio)]
        f_raw, f_fin = median_f0(raw), median_f0(s_al) if len(s_al) > 2048 else None
        row = {"id": ln["id"], "rawSec": round(p["dur"], 3), "rawSr": p["sr"], "timelineSec": ln["duration"], "cps": round(u / p["dur"], 2),
               "voiceSpeed": (ln.get("voice") or {}).get("speed"), "tempo": tempo, "expectedStretch": round(1 / tempo, 4),
               "stretch": round(ratio, 4), "stretchError": round(ratio * tempo - 1, 4), "finalCps": round(u / (p["dur"] * ratio), 2), "corr": round(corr, 3),
               "offsetSec": round(off - 0.4, 3), "f0Raw": round(f_raw, 1) if f_raw else None, "f0Final": round(f_fin, 1) if f_fin else None,
               "pitchRatio": round(f_fin / f_raw, 3) if f_raw and f_fin else None}
        out.append(row)
        print(f"{row['id']}: 原始 {row['rawSec']:.2f}s {row['rawSr']}Hz {row['cps']} 字/s speed={row['voiceSpeed']}｜時間軸 {row['timelineSec']}s 倍率 ×{tempo}｜"
              f"影片伸縮比 {row['stretch']:.4f}（預期 {row['expectedStretch']}，相關 {row['corr']}，位移 {row['offsetSec']:+.2f}s）→ {row['finalCps']} 字/s｜"
              f"音高 {row['f0Raw']}→{row['f0Final']} Hz ×{row['pitchRatio']}", flush=True)
    good = [r for r in out if r["corr"] >= 0.3]
    summary = {"seq": a.seq, "target": target.name, "targetSr": probe(target)["sr"], "lines": len(out), "matched": len(good),
               "stretchMedian": round(float(np.median([r["stretch"] for r in good])), 4) if good else None,
               "stretchErrorMax": round(float(max(abs(r["stretchError"]) for r in good)), 4) if good else None,
               "finalCpsMedian": round(float(np.median([r["finalCps"] for r in good])), 2) if good else None,
               "pitchMedian": round(float(np.median([r["pitchRatio"] for r in good if r["pitchRatio"]])), 3) if good else None,
               "cpsMedian": round(float(np.median([r["cps"] for r in out])), 2), "speeds": sorted({str(r["voiceSpeed"]) for r in out})}
    print(json.dumps(summary, ensure_ascii=False))
    if a.json:
        Path(a.json).parent.mkdir(parents=True, exist_ok=True)
        Path(a.json).write_text(json.dumps({"summary": summary, "lines": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
