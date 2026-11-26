# 旁白語速回歸測試（不用 GPU、不動任何正式檔案）：
#   tools\CosyVoice\.venv\Scripts\python.exe scripts/test_voice_tempo.py [--source-root <PROJECT_DIR> --seq ep15 --src src_cn]
# 取同一批真實 CosyVoice 句子（唯讀複製到沙盒 public/assets/audio/_vt_test/vt90），依序跑：
#   build_timeline.py（各語速設定）→ mix_audio.py → 封裝成 MP4（AAC 48 kHz，與 render.mjs 相同的音訊參數）→ voice_speed_check
# 檢查：1 原始長度正確 2 時間軸沒有意外變慢 3 MP4 語速與設定一致 4 音高不變 5 不會重複套用 6 原始檔／快取／恢復不受影響
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from voice_speed_check import decode, probe, units  # noqa: E402
from voice_tempo import ensure_tempo, tempo_path  # noqa: E402

SEQ = "vt90"
OUT = ROOT / "out" / "voice_tempo_test"
SRC = OUT / "src_vt"
VDIR = ROOT / "public" / "assets" / "audio" / "_vt_test"
PY = ["py", "-3.11", "-u"]
results: list[dict] = []


def check(name: str, ok: bool, **info) -> bool:
    results.append({"test": name, "pass": bool(ok), **info})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(info, ensure_ascii=False), flush=True)
    return ok


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(args, env=None, timeout=600) -> str:
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       env={**os.environ, "PYTHONUTF8": "1", **(env or {})})
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args))} → {r.returncode}\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")
    return r.stdout


def timeline(preset: float, normal: float | None) -> dict:
    args = [*PY, "scripts/build_timeline.py", "--seq", SEQ, "--src", str(SRC), "--voice-dir", str(VDIR.relative_to(ROOT)),
            "--srt-name", f"{SEQ}_test", "--voice-tempo", str(preset)]
    if normal:
        args += ["--normal-cps", str(normal)]
    log = run(args)
    tl = json.loads((SRC / "data" / "timeline.generated.json").read_text(encoding="utf-8"))[SEQ]
    tl["_log"] = log
    return tl


def mix_to_mp4(tag: str) -> Path:
    bgm = OUT / "bgm_quiet.wav"
    if not bgm.exists():  # 低音量粉紅雜訊當背景音樂：比合成配樂快，也能確認旁白在有背景聲時仍可量測
        run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.02:d=60:r=48000", "-ac", "2", str(bgm)])
    run([*PY, "scripts/mix_audio.py", "--seq", SEQ, "--src", str(SRC), "--mix-name", f"{SEQ}_test", "--bgm", str(bgm)])
    wav = ROOT / "public" / "assets" / "audio" / "mix" / f"{SEQ}_test.wav"
    mp4 = OUT / f"{tag}.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30", "-i", str(wav), "-shortest",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", str(mp4)])
    return mp4


def speed_check(mp4: Path, tag: str) -> dict:
    j = OUT / f"{tag}.speed.json"
    run([sys.executable, "scripts/voice_speed_check.py", "--seq", SEQ, "--timeline", str(SRC / "data" / "timeline.generated.json"),
         "--root", str(ROOT), "--mp4", str(mp4), "--lines", "0", "--json", str(j)], timeout=900)
    return json.loads(j.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-root", default=r"<PROJECT_DIR>")
    ap.add_argument("--seq", default="ep15")
    ap.add_argument("--src", default="src_cn")
    ap.add_argument("--lines", type=int, default=8)
    a = ap.parse_args()
    sroot = Path(a.source_root)
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.rmtree(VDIR, ignore_errors=True)
    (SRC / "data").mkdir(parents=True)
    (VDIR / SEQ).mkdir(parents=True)
    nar = json.loads((sroot / a.src / "data" / "narration.json").read_text(encoding="utf-8"))
    src_lines = [ln for sc in nar["sequences"][a.seq]["scenes"] for ln in sc["lines"]]
    pick = [src_lines[i] for i in sorted(set(np.linspace(0, len(src_lines) - 1, a.lines).round().astype(int)))]
    vsrc = sroot / "public" / "assets" / "audio" / ("voiceover_cosy_cn" if a.src == "src_cn" else "voiceover_cosy") / a.seq
    for ln in pick:
        for ext in (".mp3", ".json"):
            shutil.copy2(vsrc / f"{ln['id']}{ext}", VDIR / SEQ / f"{ln['id']}{ext}")
    half = len(pick) // 2
    seq = {"title": "voice tempo test", "voiceEngine": "cosyvoice",
           "scenes": [{"id": "s01", "title": "a", "lines": pick[:half]}, {"id": "s02", "title": "b", "lines": pick[half:]}]}
    for ln in pick:
        ln.pop("anchors", None)
    (SRC / "data" / "narration.json").write_text(json.dumps({**{k: v for k, v in nar.items() if k != "sequences"}, "sequences": {SEQ: seq}},
                                                            ensure_ascii=False, indent=1), encoding="utf-8")
    originals = {p.name: sha(p) for p in (VDIR / SEQ).iterdir()}
    keys = {p.stem: json.loads(p.read_text(encoding="utf-8")).get("key") for p in (VDIR / SEQ).glob("*.json")}

    # 1 原始長度正確：檔案長度＝產生器記錄的長度，取樣率 24 kHz
    bad = []
    for ln in pick:
        m = json.loads((VDIR / SEQ / f"{ln['id']}.json").read_text(encoding="utf-8"))
        p = probe(VDIR / SEQ / f"{ln['id']}.mp3")
        if abs(p["dur"] - m["duration"]) > 0.06 or p["sr"] != m.get("sample_rate", 24000):
            bad.append((ln["id"], p["dur"], m["duration"], p["sr"]))
    check("1_raw_length_matches_generator", not bad, lines=len(pick), mismatches=bad)

    # 2 時間軸沒有意外變慢：沒有語速目標時，時間軸長度＝原始長度、音檔就是原始檔
    tl = timeline(1.0, None)
    diffs = [abs(x["duration"] - probe(ROOT / "public" / x["audio"])["dur"]) for x in tl["lines"]]
    raw_dur = {x["id"]: probe(ROOT / "public" / x["sourceAudio"])["dur"] for x in tl["lines"]}
    check("2_timeline_no_stretch_without_target", tl["voiceTempo"]["tempo"] == 1.0 and max(diffs) < 0.01
          and all(x["audio"] == x["sourceAudio"] for x in tl["lines"]), tempo=tl["voiceTempo"], maxDiff=round(max(diffs), 4))
    mp4 = mix_to_mp4("t_none")
    r = speed_check(mp4, "t_none")["summary"]
    check("3a_mp4_unchanged_when_tempo_1", abs(r["stretchMedian"] - 1) <= 0.01 and r["stretchErrorMax"] <= 0.015, **r)

    # 3／4 各語速設定：時間軸長度＝原始÷倍率、MP4 實測伸縮比＝1÷倍率、字/秒＝目標、音高不變
    raw_cps = tl["voiceTempo"]["rawCps"]
    for preset in (0.9, 1.0, 1.1, 1.2):
        tl = timeline(preset, 4.4)
        vt = tl["voiceTempo"]
        want = round(min(1.6, max(0.85, vt["base"] * preset)), 3)
        base_ok = abs(vt["base"] - max(1.0, 4.4 / raw_cps)) < 0.01  # rawCps 已四捨五入到 0.01
        dd = [abs(x["duration"] - raw_dur[x["id"]] / vt["tempo"]) for x in tl["lines"]]
        check(f"2_timeline_tempo_{preset}", base_ok and abs(vt["tempo"] - want) < 0.002 and max(dd) < 0.06 and all(x["tempo"] == vt["tempo"] for x in tl["lines"]),
              rawCps=raw_cps, tempo=vt["tempo"], expected=want, maxDurErr=round(max(dd), 3))
        mp4 = mix_to_mp4(f"t_{preset}")
        rep = speed_check(mp4, f"t_{preset}")
        r = rep["summary"]
        check(f"3_mp4_rate_matches_setting_{preset}", r["matched"] == len(pick) and r["stretchErrorMax"] <= 0.015
              and abs(r["finalCpsMedian"] - raw_cps * vt["tempo"]) / (raw_cps * vt["tempo"]) < 0.05,
              tempo=vt["tempo"], stretchMedian=r["stretchMedian"], stretchErrorMax=r["stretchErrorMax"], finalCps=r["finalCpsMedian"], targetCps=vt["targetCps"])
        check(f"4_pitch_preserved_{preset}", 0.95 <= r["pitchMedian"] <= 1.06, pitchMedian=r["pitchMedian"])

    # 5 不會重複套用：第二次建時間軸用快取（檔案沒重寫）、倍率仍是一次、已調速的檔案不能再調速
    der = sorted((VDIR / SEQ / "_tempo").glob("*.mp3"))
    before = {p.name: p.stat().st_mtime_ns for p in der}
    tl2 = timeline(1.2, 4.4)
    after = {p.name: p.stat().st_mtime_ns for p in (VDIR / SEQ / "_tempo").glob("*.mp3")}
    same = all(after.get(k) == v for k, v in before.items())
    k = tl2["voiceTempo"]["tempo"]
    once = all(abs(x["duration"] - raw_dur[x["id"]] / k) < 0.06 for x in tl2["lines"])
    try:
        ensure_tempo(ROOT / "public" / tl2["lines"][0]["audio"], 1.2)
        refused = False
    except ValueError:
        refused = True
    check("5_no_double_tempo", same and once and refused and all("_tempo" not in x["sourceAudio"] for x in tl2["lines"]),
          cachedFilesUnchanged=same, appliedOnce=once, derivedRefused=refused)
    # 來源改變 → 只重做那一句
    first = VDIR / SEQ / f"{pick[0]['id']}.mp3"
    bak = OUT / "first.bak.mp3"
    shutil.copy2(first, bak)
    with open(first, "ab") as f:
        f.write(b"\0" * 417)  # 模擬重新配音（內容改變）
    mt = {p.name: p.stat().st_mtime_ns for p in (VDIR / SEQ / "_tempo").glob("*.mp3")}
    time.sleep(0.05)
    timeline(1.2, 4.4)
    mt2 = {p.name: p.stat().st_mtime_ns for p in (VDIR / SEQ / "_tempo").glob("*.mp3")}
    changed = [n for n in mt if mt2.get(n) != mt[n]]
    shutil.copy2(bak, first)
    check("5b_cache_invalidates_only_changed_source", changed == [tempo_path(first, k).name], regenerated=changed)

    # 6 原始配音檔、產生器快取鍵（恢復／只補未完成）都沒變
    timeline(1.2, 4.4)
    now = {p.name: sha(p) for p in (VDIR / SEQ).iterdir() if p.is_file()}
    keys2 = {p.stem: json.loads(p.read_text(encoding="utf-8")).get("key") for p in (VDIR / SEQ).glob("*.json")}
    check("6_originals_and_cache_keys_untouched", now == originals and keys2 == keys, files=len(now))
    # 生產端原始檔也沒被動到
    check("6b_source_episode_untouched", all(sha(vsrc / n) == originals[n] for n in originals))

    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = all(r["pass"] for r in results)
    print(f"{sum(r['pass'] for r in results)}/{len(results)} passed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
