"""Same-text A/B harness for TTS backends (docs/MACOS.md §3). Runs every candidate on the fixed test set
(scripts/voice_ab_texts.json), measures what can be measured and prepares a blind listening sheet for what cannot.

    python scripts/voice_ab.py --candidates ab_candidates.json --out out/voice_ab [--ref ref.wav --ref-text "..."]
                               [--locales zh-TW zh-CN] [--asr auto|faster-whisper|mlx-whisper|none] [--repeat 1]

ab_candidates.json — each candidate is an external command (so the harness needs none of the TTS libraries and
one candidate's crash cannot affect another):

    [{"name": "cosyvoice3-mps", "license": "Apache-2.0", "modelSizeMiB": 1900,
      "cmd": ["{venv}/bin/python", "scripts/tts_cli_cosy.py", "--device", "mps", "--text-file", "{text_file}",
              "--out", "{out}", "--ref", "{ref}", "--ref-text-file", "{ref_text_file}"],
      "env": {"PYTORCH_ENABLE_MPS_FALLBACK": "1"}}]

Measured per line: wall seconds, audio seconds, real-time factor, chars/s, peak RSS of the whole process tree
(psutil, sampled every 50 ms; on Apple Silicon RSS includes Metal buffers mapped into the process), exit code,
CER against the text after ASR (Traditional/Simplified folded with OpenCC so 臺/台, 裏/里 never count as errors),
and the long-text line's duration drift. Naturalness, Taiwan accent and cloning similarity are NOT computed: the
harness writes listen.md with anonymised file names (A, B, C…) and a key file kept separately.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent


def peak_rss_tree(proc: subprocess.Popen, stop: threading.Event, out: dict):
    try:
        import psutil  # noqa: PLC0415
    except ImportError:
        out["peakMiB"] = None
        return
    peak = 0
    try:
        root = psutil.Process(proc.pid)
        while not stop.is_set():
            try:
                rss = root.memory_info().rss + sum(c.memory_info().rss for c in root.children(recursive=True))
                peak = max(peak, rss)
            except psutil.Error:
                pass
            time.sleep(0.05)
    except psutil.Error:
        pass
    out["peakMiB"] = round(peak / 2**20)


def wav_seconds(p: Path) -> float | None:
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:  # noqa: BLE001
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)], capture_output=True, text=True, timeout=30)
            return float(r.stdout.strip())
        except Exception:  # noqa: BLE001
            return None


_cc = None


def fold(s: str) -> str:
    """Comparable form: Simplified, no punctuation / spaces, lower-case Latin, full-width folded."""
    global _cc
    s = unicodedata.normalize("NFKC", s)
    try:
        if _cc is None:
            import opencc  # noqa: PLC0415

            _cc = opencc.OpenCC("t2s")
        s = _cc.convert(s)
    except Exception:  # noqa: BLE001
        pass
    return re.sub(r"[\W_]+", "", s.lower())


def cer(ref: str, hyp: str) -> float:
    r, h = fold(ref), fold(hyp)
    if not r:
        return 0.0
    d = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hc in enumerate(h, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (rc != hc))
            prev, d[j] = d[j], cur
    return d[len(h)] / len(r)


def make_asr(kind: str):
    if kind == "none":
        return None
    order = ["mlx-whisper", "faster-whisper"] if kind == "auto" else [kind]
    for k in order:
        try:
            if k == "mlx-whisper":
                import mlx_whisper  # noqa: PLC0415

                repo = os.environ.get("PIKARA_AB_MLX_WHISPER", "mlx-community/whisper-large-v3-turbo")
                return k, lambda p, lang: mlx_whisper.transcribe(str(p), path_or_hf_repo=repo, language=lang)["text"]
            if k == "faster-whisper":
                from faster_whisper import WhisperModel  # noqa: PLC0415

                m = WhisperModel(os.environ.get("PIKARA_AB_WHISPER", "large-v3"), device="auto", compute_type="auto")
                return k, lambda p, lang: "".join(s.text for s in m.transcribe(str(p), language=lang, beam_size=5)[0])
        except Exception as e:  # noqa: BLE001
            print(f"  ASR {k} 不可用：{e}", flush=True)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out", default="out/voice_ab")
    ap.add_argument("--ref", default="")
    ap.add_argument("--ref-text", default="")
    ap.add_argument("--locales", nargs="+", default=["zh-TW", "zh-CN"])
    ap.add_argument("--asr", default="auto")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=900)
    a = ap.parse_args()

    texts = json.loads((HERE / "voice_ab_texts.json").read_text(encoding="utf-8"))
    cands = json.loads(Path(a.candidates).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="pikara-ab-"))
    ref_text_file = tmp / "ref.txt"
    ref_text_file.write_text(a.ref_text, encoding="utf-8")
    rows = []
    for c in cands:
        for loc in a.locales:
            for t in texts.get(loc, []):
                for rep in range(a.repeat):
                    tf = tmp / f"{t['id']}.txt"
                    tf.write_text(t["text"], encoding="utf-8")
                    wav = out / c["name"] / f"{t['id']}{'' if rep == 0 else f'-r{rep}'}.wav"
                    wav.parent.mkdir(parents=True, exist_ok=True)
                    subst = {"text_file": str(tf), "out": str(wav), "ref": a.ref, "ref_text_file": str(ref_text_file), "locale": loc, "venv": c.get("venv", "")}
                    cmd = [x.format(**subst) for x in c["cmd"]]
                    env = {**os.environ, **c.get("env", {})}
                    t0 = time.perf_counter()
                    p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
                    stop, mem = threading.Event(), {}
                    th = threading.Thread(target=peak_rss_tree, args=(p, stop, mem), daemon=True)
                    th.start()
                    try:
                        log, _ = p.communicate(timeout=a.timeout)
                    except subprocess.TimeoutExpired:
                        p.kill()
                        log, _ = p.communicate()
                    stop.set()
                    th.join()
                    wall = time.perf_counter() - t0
                    secs = wav_seconds(wav) if wav.exists() else None
                    row = {"candidate": c["name"], "locale": loc, "id": t["id"], "rep": rep, "exit": p.returncode, "wallS": round(wall, 2),
                           "audioS": round(secs, 2) if secs else None, "rtf": round(wall / secs, 3) if secs else None,
                           "charsPerS": round(len(t["text"]) / wall, 2), "peakMiB": mem.get("peakMiB"), "file": str(wav) if wav.exists() else None,
                           "logTail": "\n".join(log.splitlines()[-5:]) if p.returncode else None}
                    rows.append(row)
                    print(json.dumps(row, ensure_ascii=False), flush=True)
    asr = make_asr(a.asr)
    if asr:
        name, fn = asr
        for r in rows:
            if r["file"]:
                text = next(t["text"] for t in texts[r["locale"]] if t["id"] == r["id"])
                try:
                    hyp = fn(r["file"], "zh")
                    r.update(asr=name, hyp=hyp, cer=round(cer(text, hyp), 4))
                except Exception as e:  # noqa: BLE001
                    r["asrError"] = str(e)[:200]
    # blind listening sheet
    files = [r for r in rows if r["file"] and r["rep"] == 0]
    random.Random(7).shuffle(files)
    key, sheet = {}, ["# 盲聽評分表（自然度、台灣腔、克隆相似度、停頓節奏、術語念法，各 1–5 分）", ""]
    for i, r in enumerate(files):
        tag = f"S{i + 1:03d}"
        key[tag] = {"candidate": r["candidate"], "id": r["id"]}
        sheet.append(f"- {tag}　`{Path(r['file']).name}`（{r['id']}）　自然度＿ 腔調＿ 相似度＿ 節奏＿ 術語＿")
    (out / "listen.md").write_text("\n".join(sheet) + "\n", encoding="utf-8")
    (out / "listen.key.json").write_text(json.dumps(key, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "results.json").write_text(json.dumps({"measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "platform": sys.platform, "candidates": cands, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    # summary per candidate
    print("\ncandidate               ok/total  chars/s  RTF    peakMiB  meanCER")
    for c in cands:
        rs = [r for r in rows if r["candidate"] == c["name"]]
        ok = [r for r in rs if r["exit"] == 0 and r["file"]]
        mean = lambda k: (sum(r[k] for r in ok if r.get(k) is not None) / max(1, len([r for r in ok if r.get(k) is not None]))) if ok else float("nan")  # noqa: E731
        print(f"{c['name']:<23} {len(ok)}/{len(rs):<7} {mean('charsPerS'):7.2f} {mean('rtf'):6.3f} {max([r['peakMiB'] or 0 for r in rs] or [0]):8} {mean('cer') if asr else float('nan'):7.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
