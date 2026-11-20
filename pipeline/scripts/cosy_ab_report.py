"""CosyVoice vs Edge-TTS A/B: builds edge|0.8s|cosy files and prints objective metrics.
tools\\CosyVoice\\.venv\\Scripts\\python.exe scripts\\cosy_ab_report.py [--cosy-dir _test] [--ab-dir _ab] a1-00 a4-09 a6-06"""
import argparse, json, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import generate_voiceover_cosy as g  # noqa: E402

ROOT = g.ROOT
EDGE = ROOT / "public" / "assets" / "audio" / "voiceover" / "ep01"


def metrics(p: Path, speak: str) -> dict:
    dur = g.ffprobe(p)["duration"]
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(p), "-af", "silencedetect=noise=-40dB:d=0.25,ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, errors="replace").stderr
    sil = [float(x) for x in re.findall(r"silence_duration: ([\d.]+)", r)]
    i = re.findall(r"I:\s+(-?[\d.]+) LUFS", r)
    tp = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", r)
    _, st = g.align(speak, g.transcribe_words(p))
    n = len(g.norm(speak))
    return {"dur": round(dur, 2), "cps": round(n / dur, 2), "pauses": len(sil), "max_pause": max(sil, default=0),
            "lufs": float(i[-1]) if i else None, "tp": float(tp[-1]) if tp else None, "cer": st["cer"], "asr": st["asr"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cosy-dir", default="_test")
    ap.add_argument("--ab-dir", default="_ab")
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args()
    lines = {ln["id"]: ln for _, ln in g.load_lines("ep01")}
    cdir, abd = g.OUT_DIR / a.cosy_dir, g.OUT_DIR / a.ab_dir
    abd.mkdir(parents=True, exist_ok=True)
    rows = []
    for lid in a.ids:
        speak = lines[lid].get("speak") or lines[lid]["subtitle"]
        e, c = EDGE / f"{lid}.mp3", cdir / f"{lid}.mp3"
        me, mc = (metrics(e, speak) if e.exists() else None), metrics(c, speak)
        rows.append((lid, me, mc))
        if e.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(e), "-i", str(c), "-filter_complex",
                            "[0:a]aresample=24000,aformat=channel_layouts=mono,apad=pad_dur=0.8[a];[1:a]aresample=24000,aformat=channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[o]",
                            "-map", "[o]", "-c:a", "libmp3lame", "-b:a", "160k", str(abd / f"{lid}_edge_then_cosy.mp3")], check=True)
    print(json.dumps([{"id": r[0], "edge": r[1], "cosy": r[2]} for r in rows], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
