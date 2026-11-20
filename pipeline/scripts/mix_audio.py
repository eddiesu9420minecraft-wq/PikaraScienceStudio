"""
音訊後製：python scripts/mix_audio.py [--seq arttest|ep01|ep02…] [--src src|src_cn] [--mix-name ep02_cn]

  ep01 使用手工音效表（ep01_events）與逐幕配樂；其他集數使用通用規則（generic_events / generic_moods）：
  幕間轉場音、錨點提示音（克制、間隔至少 1.5 秒）、片尾鐘聲；配樂依 narration.json 的 scenes[].mood
  （mystery / light / pulse / rise / outro），未指定時依幕的位置自動選擇。

  旁白（各句依時間軸 adelay 排入）→ 兩段式 loudnorm（-16 LUFS / -1.5 dBTP）
  背景音樂（本腳本以 ffmpeg 合成的原創氛圍音，無授權疑慮）→ 依旁白「說話區段」自動壓低（ducking）
  音效（按鍵、送出、穿越、乘加、品牌，同樣由 ffmpeg 合成）
  → amix(normalize=0) → 整體 loudnorm → 前視限幅器（避免爆音）→ public/assets/audio/mix/<seq>.wav

設計參考（改寫，非逐字複製）：
  - 說話區段合併與 ducking 關鍵影格：heygen-com/hyperframes packages/cli/src/media-use/lib/duck.mjs（Apache-2.0）
  - 靜音底軌 + amix normalize=0 + alimiter 補償延遲：givemotion/givemotion src/ffmpeg.js（MIT）
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SRC = sys.argv[sys.argv.index("--src") + 1] if "--src" in sys.argv else "src"
_MIXNAME = sys.argv[sys.argv.index("--mix-name") + 1] if "--mix-name" in sys.argv else None
TIMELINE = ROOT / _SRC / "data" / "timeline.generated.json"
SHOTS_TS = ROOT / "src" / "scenes" / "test" / "shots.ts"
PUBLIC = ROOT / "public"
GEN = PUBLIC / "assets" / "audio" / "generated"
MIX = PUBLIC / "assets" / "audio" / "mix"
SR = 48000

VOICE_LUFS = -16.0
FINAL_LUFS = -16.0
TRUE_PEAK = -1.5
BGM_LEVEL_DB = -29.0  # 背景音樂基準（說話時再降低）
DUCK_DB = -11.0  # 說話時額外降低量
DUCK_ATTACK = 0.15
DUCK_RELEASE = 0.45
MERGE_GAP = 0.6

sys.stdout.reconfigure(encoding="utf-8")


def ff(args: list[str], capture: bool = False) -> str:
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-y", *args], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    except FileNotFoundError:
        raise SystemExit("[錯誤] 找不到 ffmpeg。請安裝 ffmpeg 並加入 PATH，例如：winget install Gyan.FFmpeg")
    if r.returncode != 0:
        raise SystemExit(f"[ffmpeg 失敗]\n{' '.join(args)[:600]}\n{r.stderr[-3000:]}")
    return r.stderr if capture else ""


def loudnorm_measure(path: Path) -> dict:
    err = ff(["-i", str(path), "-af", f"loudnorm=I={VOICE_LUFS}:TP={TRUE_PEAK}:LRA=11:print_format=json", "-f", "null", "-"], capture=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if not m:
        raise SystemExit("[錯誤] loudnorm 量測失敗")
    return json.loads(m.group(0))


def loudnorm_apply(src: Path, dst: Path, target: float) -> None:
    m = loudnorm_measure(src)
    af = (f"loudnorm=I={target}:TP={TRUE_PEAK}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    ff(["-i", str(src), "-af", f"{af},aresample={SR}", "-ar", str(SR), "-c:a", "pcm_s24le", str(dst)])


def ebur128(path: Path) -> tuple[float, float]:
    err = ff(["-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"], capture=True)
    i = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])
    tp = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", err)[-1])
    return i, tp


# ---------------- 合成素材（確定性，原創） ----------------

def synth_assets() -> dict[str, Path]:
    GEN.mkdir(parents=True, exist_ok=True)
    out = {
        "click": GEN / "sfx_key_click.wav",
        "send": GEN / "sfx_send.wav",
        "whoosh": GEN / "sfx_whoosh.wav",
        "shimmer": GEN / "sfx_shimmer.wav",
        "brand": GEN / "sfx_brand_chime.wav",
    }
    specs = {
        # 按鍵：短促的高通雜訊脈衝
        "click": ("aevalsrc='(random(0)*2-1)*exp(-t*260)*0.6':s=48000:d=0.05", "highpass=f=1800,lowpass=f=9000"),
        # 送出：上滑的柔和正弦
        "send": ("aevalsrc='sin(2*PI*(660*t+900*t*t))*exp(-t*14)*0.35':s=48000:d=0.28", "lowpass=f=5000"),
        # 穿越玻璃：帶通雜訊，包絡先升後降
        "whoosh": ("aevalsrc='(random(0)*2-1)*pow(sin(PI*t/1.4),2)*0.5':s=48000:d=1.4", "bandpass=f=900:width_type=o:w=2,lowpass=f=3500"),
        # 乘加波前：輕微上行的泛音
        "shimmer": ("aevalsrc='(sin(2*PI*523.25*t)+0.6*sin(2*PI*784*t)+0.3*sin(2*PI*1046.5*t))*sin(PI*t/1.2)*0.12':s=48000:d=1.2", "lowpass=f=6000"),
        # 品牌：三音鐘聲，緩慢衰減
        "brand": ("aevalsrc='(sin(2*PI*659.25*t)*exp(-t*2.2)+0.7*sin(2*PI*987.77*t)*exp(-t*2.8)+0.4*sin(2*PI*1318.5*t)*exp(-t*3.6))*0.22':s=48000:d=2.4", "lowpass=f=7000"),
    }
    for k, (src, flt) in specs.items():
        ff(["-f", "lavfi", "-i", src, "-af", f"{flt},aformat=channel_layouts=stereo", "-ar", str(SR), "-c:a", "pcm_s16le", str(out[k])])
    return out


def synth_bgm(duration: float, path: Path) -> None:
    """原創氛圍音：A 小調 add9 與 F 大七和弦交替，慢速 LFO，低通柔化。"""
    chord_a = "sin(2*PI*110*t)+0.6*sin(2*PI*164.81*t)+0.5*sin(2*PI*246.94*t)+0.35*sin(2*PI*261.63*t)"
    chord_f = "sin(2*PI*87.31*t)+0.6*sin(2*PI*130.81*t)+0.5*sin(2*PI*220*t)+0.35*sin(2*PI*329.63*t)"
    mixw = "(0.5+0.5*cos(2*PI*t/16))"  # 16 秒一循環，平滑交叉
    expr = f"(({chord_a})*{mixw}+({chord_f})*(1-{mixw}))*(0.8+0.2*sin(2*PI*t/5.3))*0.08"
    ff(["-f", "lavfi", "-i", f"aevalsrc='{expr}|{expr}':s=48000:d={duration:.3f}",
        "-af", f"lowpass=f=1400,aecho=0.8:0.7:420|610:0.25|0.18,afade=t=in:d=2.0,afade=t=out:st={max(0, duration - 2.5):.3f}:d=2.5",
        "-ar", str(SR), "-c:a", "pcm_s16le", str(path)])


# ---------------- ducking（改寫自 hyperframes duck.mjs 的作法） ----------------

def speech_spans(tl: dict) -> list[tuple[float, float]]:
    spans: list[tuple[float, float]] = []
    for line in [x for x in tl["lines"] if not x.get("estimated")]:
        meta = json.loads((PUBLIC / Path(line["audio"]).with_suffix(".json")).read_text(encoding="utf-8"))
        words = [b for b in meta.get("boundaries", []) if b["type"] == "WordBoundary"]
        if words:
            spans += [(line["start"] + w["start"], line["start"] + w["end"]) for w in words]
        else:
            spans.append((line["start"], line["end"]))
    spans.sort()
    merged: list[list[float]] = []
    for s, e in spans:
        if merged and s - merged[-1][1] < MERGE_GAP:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def duck_expr(spans: list[tuple[float, float]]) -> str:
    """回傳 volume=eval=frame 的分段線性增益（線性倍率）。"""
    low = 10 ** (DUCK_DB / 20)
    keys: list[tuple[float, float]] = [(0.0, 1.0)]
    for s, e in spans:
        keys += [(max(0.0, s - DUCK_ATTACK), 1.0), (s, low), (e, low), (e + DUCK_RELEASE, 1.0)]
    keys.sort()
    clean: list[tuple[float, float]] = []
    for t, v in keys:
        if clean and t <= clean[-1][0]:
            clean[-1] = (clean[-1][0], min(clean[-1][1], v))
        else:
            clean.append((t, v))
    terms = []
    for (t0, v0), (t1, v1) in zip(clean, clean[1:]):
        terms.append(f"between(t,{t0:.3f},{t1:.3f})*({v0:.4f}+({v1 - v0:.4f})*(t-{t0:.3f})/{t1 - t0:.3f})")
    return f"if(gte(t,{clean[-1][0]:.3f}),1,{'+'.join(terms)})"


# ---------------- 樣板影格 → 實際秒數（與 Remotion 端 timewarp 相同錨點） ----------------

def template_to_seconds(tl: dict):
    src = SHOTS_TS.read_text(encoding="utf-8")
    block = re.search(r"TEMPLATE_ANCHORS[^{]*\{(.*?)\};", src, re.S).group(1)
    tpl = {m.group(1): float(m.group(2)) for m in re.finditer(r"(\w+):\s*([\d.]+)", block)}
    total_tpl = float(re.search(r"total:\s*(\d+)", src).group(1))
    pairs = [(0.0, 0.0)] + sorted((tpl[k], a["frame"]) for k, a in tl["anchors"].items() if k in tpl) + [(total_tpl, tl["totalFrames"])]
    fps = tl["fps"]

    def conv(f_tpl: float) -> float:
        for (t0, r0), (t1, r1) in zip(pairs, pairs[1:]):
            if f_tpl <= t1:
                return (r0 + (r1 - r0) * (f_tpl - t0) / (t1 - t0)) / fps
        return pairs[-1][1] / fps

    return conv


def ep01_events(tl: dict) -> list[tuple[str, float, float]]:
    """EP01 音效：依旁白錨點（實際時間）放置，數量克制，避免干擾旁白。"""
    fps = tl["fps"]
    sc = {s["id"]: s for s in tl["scenes"]}
    at = lambda act, name: sc[act]["anchors"][name]["time"] if name in sc.get(act, {}).get("anchors", {}) else None  # noqa: E731
    ev: list[tuple[str, float, float]] = []
    # 第一幕：打字聲（「晚上」到「答案」之間對應樣板 18–118 的打字段）
    o, ans = at("act01", "open"), at("act01", "answer")
    if o is not None and ans is not None:
        t0, t1 = o + (ans - o) * (18 - 14) / (128 - 14), o + (ans - o) * (118 - 14) / (128 - 14)
        t, k = t0, 0
        while t < t1:
            ev.append(("click", t, -16.0 + (k % 3) * -2.0))
            t += 0.085 * (4.2 + ((k * 7) % 5) * 0.9)
            k += 1
        ev.append(("send", ans, -14.0))
    e, off = at("act01", "enter"), at("act01", "offline")
    if e is not None and off is not None:
        ev.append(("whoosh", e + (off - e) * (178 - 150) / (210 - 150) - 0.5, -15.0))
    m = at("act01", "multiply")
    if m is not None:
        ev.append(("shimmer", m, -19.0))
    # 幕與幕之間的資料點轉場
    for s in tl["scenes"][1:]:
        ev.append(("whoosh", s["startFrame"] / fps - 0.55, -21.0))
    # 少量重點提示音
    for act, name in [("act02", "packet"), ("act02", "return"), ("act03", "notdb"), ("act04", "notdelete"), ("act04", "container"),
                      ("act05", "offload"), ("act06", "sample"), ("act06", "append")]:
        t = at(act, name)
        if t is not None:
            ev.append(("send", t, -22.0))
    b = at("act07", "brand")
    if b is not None:
        ev.append(("brand", b - 0.2, -13.0))
    return ev


MOODS = ("mystery", "light", "pulse", "rise", "outro")
EP01_MOODS = {"act01": "mystery", "act02": "light", "act03": "light", "act04": "pulse", "act05": "pulse", "act06": "rise", "act07": "outro"}


def generic_moods(seq: str, tl: dict) -> list[str]:
    """沒有手工配樂表的集數：narration.json 的 scenes[].mood 優先，否則開場 mystery／中段輪替／結尾 outro。"""
    try:
        nar = json.loads((ROOT / _SRC / "data" / "narration.json").read_text(encoding="utf-8"))
        given = {sc["id"]: sc.get("mood") for sc in nar["sequences"][seq]["scenes"]}
    except (OSError, KeyError, json.JSONDecodeError):
        given = {}
    scenes = tl["scenes"]
    out = []
    for i, sc in enumerate(scenes):
        m = given.get(sc["id"])
        if m not in MOODS:
            if len(scenes) == 1:
                m = "light"
            elif i == 0:
                m = "mystery"
            elif i == len(scenes) - 1:
                m = "outro"
            else:
                m = ("light", "pulse", "rise")[(i - 1) % 3]
        out.append(m)
    return out


def generic_events(tl: dict) -> list[tuple[str, float, float]]:
    """通用音效：幕間資料點轉場、錨點提示（間隔 ≥ 1.5 秒，避免干擾旁白）、片尾鐘聲。"""
    fps = tl["fps"]
    ev: list[tuple[str, float, float]] = []
    for s in tl["scenes"][1:]:
        ev.append(("whoosh", s["startFrame"] / fps - 0.55, -21.0))
    last = -9.0
    for t in sorted(a["time"] for s in tl["scenes"] for a in s["anchors"].values()):
        if t - last >= 1.5:
            ev.append(("send", t, -24.0))
            last = t
    dur = tl["totalFrames"] / fps
    ev.append(("brand", max(0.0, dur - 2.6), -16.0))
    return [e for e in ev if e[1] >= 0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", default="arttest")
    ap.add_argument("--src", default="src")
    ap.add_argument("--mix-name", default=None)
    ap.add_argument("--bgm", default=None, help="使用者提供的背景音樂（WAV／MP3…），循環或裁切到影片長度；不指定則自動合成配樂")
    a = ap.parse_args()
    if not TIMELINE.exists():
        print(f"[錯誤] 找不到時間軸 {TIMELINE.relative_to(ROOT)}，請先執行 build_timeline.py --seq {a.seq}")
        return 1
    all_tl = json.loads(TIMELINE.read_text(encoding="utf-8"))
    if a.seq not in all_tl:
        print(f"[錯誤] {TIMELINE.relative_to(ROOT)} 裡沒有 {a.seq}（現有：{'、'.join(all_tl) or '無'}）。請先執行 build_timeline.py --seq {a.seq}")
        return 1
    tl = all_tl[a.seq]
    dur = tl["totalFrames"] / tl["fps"]
    MIX.mkdir(parents=True, exist_ok=True)
    work = MIX / f"_{_MIXNAME or a.seq}"
    work.mkdir(exist_ok=True)

    # 1) 旁白軌
    inputs, chains = ["-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=stereo:d={dur:.3f}"], []
    vlines = [x for x in tl["lines"] if not x.get("estimated")]
    if len(vlines) < len(tl["lines"]):
        print(f"   ! 有 {len(tl['lines']) - len(vlines)} 句尚無音檔（估算），本次混音不含這些句子")
    for i, line in enumerate(vlines, start=1):
        inputs += ["-i", (PUBLIC / line["audio"]).relative_to(ROOT).as_posix()]
        ms = round(line["start"] * 1000)
        chains.append(f"[{i}:a]aresample={SR},aformat=channel_layouts=stereo,adelay={ms}|{ms}[v{i}]")
    labels = "".join(f"[v{i}]" for i in range(1, len(vlines) + 1))
    voice_raw = work / "voice_raw.wav"
    ff([*inputs, "-filter_complex", ";".join(chains) + f";[0:a]{labels}amix=inputs={len(vlines) + 1}:normalize=0:duration=first:dropout_transition=0[out]",
        "-map", "[out]", "-c:a", "pcm_s24le", str(voice_raw)])
    voice = work / "voice_norm.wav"
    loudnorm_apply(voice_raw, voice, VOICE_LUFS)

    # 2) 背景音樂 + ducking（EP01：每一幕不同氛圍，見 scripts/music.py）
    bgm_raw = work / "bgm_raw.wav"
    user_bgm = Path(a.bgm) if a.bgm else None
    if user_bgm is not None and not user_bgm.is_absolute():
        user_bgm = ROOT / user_bgm
    if user_bgm is not None:
        if not user_bgm.is_file():
            print(f"[錯誤] 找不到背景音樂檔：{a.bgm}")
            return 1
        print(f"   配樂（使用者提供）：{user_bgm.name}，循環／裁切到 {dur:.1f}s，結尾 2 秒淡出")
        ff(["-stream_loop", "-1", "-i", str(user_bgm), "-t", f"{dur:.3f}", "-af",
            f"aresample={SR},aformat=channel_layouts=stereo,afade=t=out:st={max(0.0, dur - 2.0):.3f}:d=2",
            "-c:a", "pcm_s24le", str(bgm_raw)])
    elif tl.get("scenes") and a.seq != "arttest":
        sys.path.insert(0, str(Path(__file__).parent))
        import music  # noqa: E402
        if a.seq == "ep01":
            moods = [EP01_MOODS.get(sc["id"], "light") for sc in tl["scenes"]]
        else:
            moods = generic_moods(a.seq, tl)
            print(f"   配樂（通用）：{'、'.join(moods)}")
        segs = [(m, (sc["endFrame"] - sc["startFrame"]) / tl["fps"]) for m, sc in zip(moods, tl["scenes"])]
        music.build_score(segs, work, bgm_raw, ff)
    else:
        synth_bgm(dur, bgm_raw)
    bgm_lvl = work / "bgm_level.wav"
    loudnorm_apply(bgm_raw, bgm_lvl, BGM_LEVEL_DB)
    bgm = work / "bgm_ducked.wav"
    # Ducking：以旁白為側鏈壓縮背景音樂（長片也不受濾鏡運算式長度限制）。
    # 參數：門檻約 -36 dBFS、比例 10、起音 120ms、釋放 500ms → 說話時約降低 10–12 dB。
    ff(["-i", str(bgm_lvl), "-i", str(voice), "-filter_complex",
        "[1:a]aformat=channel_layouts=stereo,volume=6dB[sc];[0:a][sc]sidechaincompress=threshold=0.016:ratio=10:attack=120:release=500:knee=4:makeup=1[out]",
        "-map", "[out]", "-c:a", "pcm_s24le", str(bgm)])

    # 3) 音效
    sfx = synth_assets()
    events: list[tuple[str, float, float]] = []  # (素材, 秒, 增益 dB)
    if a.seq == "ep01":
        events = ep01_events(tl)
    elif a.seq != "arttest":
        events = generic_events(tl)
    else:
        conv = template_to_seconds(tl)
        # 按鍵聲：對齊 DeskScene 的打字區段（樣板 18–118）；固定節奏 + 確定性微抖動
        t, k = 18.0, 0
        while t < 118:
            events.append(("click", conv(t), -15.0 + (k % 3) * -2.0))
            t += 4.2 + ((k * 7) % 5) * 0.9
            k += 1
        events += [("send", conv(128), -13.0), ("whoosh", conv(178), -14.0), ("shimmer", conv(640), -18.0), ("brand", conv(760), -12.0)]
    sfx_inputs = ["-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=stereo:d={dur:.3f}"]
    used = {}
    for name, _, _ in events:
        if name not in used:
            used[name] = len(used) + 1
            sfx_inputs += ["-i", str(sfx[name])]
    counts = {n: sum(1 for e in events if e[0] == n) for n in used}
    parts = [f"[{idx}:a]asplit={counts[n]}" + "".join(f"[{n}{j}]" for j in range(counts[n])) for n, idx in used.items()]
    seen = {n: 0 for n in used}
    for ei, (n, sec, gain) in enumerate(events):
        ms = max(0, round(sec * 1000))
        parts.append(f"[{n}{seen[n]}]volume={gain}dB,adelay={ms}|{ms}[e{ei}]")
        seen[n] += 1
    sfx_track = work / "sfx.wav"
    ff([*sfx_inputs, "-filter_complex", ";".join(parts) + ";[0:a]" + "".join(f"[e{i}]" for i in range(len(events)))
        + f"amix=inputs={len(events) + 1}:normalize=0:duration=first:dropout_transition=0[out]", "-map", "[out]", "-c:a", "pcm_s24le", str(sfx_track)])

    # 4) 混音 → 整體響度 → 前視限幅（補償 alimiter 延遲，長度不變）
    pre = work / "premix.wav"
    ff(["-i", str(voice), "-i", str(bgm), "-i", str(sfx_track), "-filter_complex",
        "[0:a][1:a][2:a]amix=inputs=3:normalize=0:duration=first:dropout_transition=0[out]", "-map", "[out]", "-c:a", "pcm_s24le", str(pre)])
    normed = work / "premix_norm.wav"
    loudnorm_apply(pre, normed, FINAL_LUFS)
    final = MIX / f"{_MIXNAME or a.seq}.wav"
    ff(["-i", str(normed), "-af", f"apad=pad_len=240,alimiter=limit=0.89:attack=5:release=50:level=disabled,atrim=start_sample=239,asetpts=PTS-STARTPTS,atrim=end={dur:.3f}",
        "-ar", str(SR), "-c:a", "pcm_s16le", str(final)])

    # 5) 驗證
    i_all, tp_all = ebur128(final)
    i_v, _ = ebur128(voice)
    i_b, _ = ebur128(bgm)
    print(f"[{a.seq}] 混音完成：{final.relative_to(ROOT)}  長度 {dur:.2f}s")
    print(f"   成品響度 {i_all:.1f} LUFS，峰值 {tp_all:.1f} dBFS")
    print(f"   旁白 {i_v:.1f} LUFS ／ 背景音樂（ducking 後）{i_b:.1f} LUFS → 差距 {i_v - i_b:.1f} dB")
    print(f"   音效事件 {len(events)} 個；說話區段 {len(speech_spans(tl))} 段")
    if tp_all > -0.5:
        print("   ! 峰值偏高")
    tl["mix"] = final.relative_to(PUBLIC).as_posix()
    all_tl[a.seq] = tl
    TIMELINE.write_text(json.dumps(all_tl, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
