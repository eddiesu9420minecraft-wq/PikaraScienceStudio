"""
原創配樂產生器（ffmpeg aevalsrc 合成，確定性、無第三方授權）。

每一幕一種氛圍，段落之間以 acrossfade 交叉淡化：
  mystery  開場：低音持續音 + 稀疏的五聲音階鐘聲，神秘、帶科技感
  light    原理講解：明亮的大七／小七和弦鋪底 + 輕柔撥弦琶音
  pulse    晶片運算：規律的柔和低鼓 + 細碎刷聲 + 小調鋪底，有節奏但不機械
  rise     高潮：較飽滿的鋪底 + 十六分音符琶音，逐漸增強
  outro    結尾：溫暖的大和弦緩慢收尾

設計原則：所有音色經低通與殘響柔化，和弦每小節以正弦包絡呼吸（換和弦時振幅趨近 0，避免爆音），
琶音音符有 5ms 起音避免喀聲；音量刻意偏低，最後再由 mix_audio.py 正規化並在旁白下 ducking。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

SR = 48000

# 音高（Hz）
N = {
    "A1": 55.0, "D2": 73.42, "E2": 82.41, "F2": 87.31, "G2": 98.0, "A2": 110.0, "C3": 130.81, "D3": 146.83, "E3": 164.81,
    "F3": 174.61, "G3": 196.0, "A3": 220.0, "B3": 246.94, "C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23,
    "G4": 392.0, "A4": 440.0, "B4": 493.88, "C5": 523.25, "D5": 587.33, "E5": 659.25, "G5": 783.99, "A5": 880.0,
}


def _choose(idx_expr: str, values: list[float]) -> str:
    """產生 if(eq(idx,0),v0,if(eq(idx,1),v1,...)) 的巢狀選擇式。"""
    expr = f"{values[-1]}"
    for i in range(len(values) - 2, -1, -1):
        expr = f"if(eq({idx_expr},{i}),{values[i]},{expr})"
    return expr


def _pad(chords: list[list[str]], bar: float, gain: float) -> str:
    """每小節一個和弦；用 sin^0.6 呼吸包絡，換和弦時歸零（無爆音）。"""
    idx = f"mod(floor(t/{bar}),{len(chords)})"
    env = f"pow(sin(PI*mod(t,{bar})/{bar}),0.6)"
    voices = []
    for v in range(len(chords[0])):
        f = _choose(idx, [N[c[v]] for c in chords])
        # 兩個略微失諧的正弦，產生溫暖的合唱感
        voices.append(f"(sin(2*PI*{f}*t)+0.6*sin(2*PI*{f}*1.003*t))")
    return f"({'+'.join(voices)})*{env}*{gain}"


def _arp(notes: list[str], step: float, gain: float, decay: float = 7.0) -> str:
    idx = f"mod(floor(t/{step}),{len(notes)})"
    f = _choose(idx, [N[n] for n in notes])
    ph = f"mod(t,{step})"
    env = f"min(1,{ph}*200)*exp(-{ph}*{decay})"
    return f"(sin(2*PI*{f}*t)+0.25*sin(4*PI*{f}*t))*{env}*{gain}"


def _bells(notes: list[str], step: float, gain: float) -> str:
    idx = f"mod(floor(t/{step}),{len(notes)})"
    f = _choose(idx, [N[n] for n in notes])
    ph = f"mod(t,{step})"
    env = f"min(1,{ph}*300)*exp(-{ph}*1.6)"
    return f"(sin(2*PI*{f}*t)+0.4*sin(2*PI*{f}*2.76*t)*exp(-{ph}*4))*{env}*{gain}"


def _kick(beat: float, gain: float) -> str:
    ph = f"mod(t,{beat})"
    # 頻率由 110Hz 下滑到 50Hz 的柔和低鼓
    return f"sin(2*PI*(50*{ph}+30*(1-exp(-{ph}*25))/25*2))*exp(-{ph}*9)*min(1,{ph}*400)*{gain}"


PRESETS = {
    "mystery": lambda: "+".join([
        f"(sin(2*PI*{N['A1']}*t)+0.5*sin(2*PI*{N['E2']}*t))*(0.75+0.25*sin(2*PI*t/9))*0.10",
        _pad([["A2", "E3", "B3", "C4"], ["F2", "C3", "A3", "E4"]], 8.0, 0.035),
        _bells(["A4", "C5", "E5", "D5", "G4", "E5", "A4", "B4"], 2.4, 0.05),
    ]),
    "light": lambda: "+".join([
        _pad([["C3", "G3", "B3", "E4"], ["A2", "E3", "G3", "C4"], ["F2", "C3", "A3", "E4"], ["G2", "D3", "B3", "E4"]], 2.666, 0.05),
        _arp(["C4", "E4", "G4", "B4", "A3", "C4", "E4", "G4", "F3", "A3", "C4", "E4", "G3", "B3", "D4", "E4"], 0.333, 0.045),
    ]),
    "pulse": lambda: "+".join([
        _pad([["D3", "A3", "C4", "E4"], ["B2" if False else "G2", "D3", "A3", "C4"], ["F2", "C3", "A3", "E4"], ["A2", "E3", "G3", "C4"]], 2.4, 0.04),
        _kick(0.6, 0.20),
        # 細碎刷聲：只用頻率很高的正弦簇模擬，避免白噪音的刺耳
        f"(sin(2*PI*6200*t)*0.5+sin(2*PI*7900*t)*0.5)*exp(-mod(t+0.3,0.6)*45)*0.010",
        _arp(["D4", "A4", "C5", "A4", "E4", "A4", "D5", "A4"], 0.3, 0.025, 9.0),
    ]),
    "rise": lambda: "+".join([
        _pad([["F2", "C3", "A3", "E4"], ["G2", "D3", "B3", "E4"], ["A2", "E3", "C4", "G4"], ["C3", "G3", "E4", "B4"]], 2.0, 0.05),
        _arp(["A4", "C5", "E5", "C5", "B4", "D5", "G5", "D5", "C5", "E5", "A5", "E5", "E5", "G5", "B4", "G5"], 0.125, 0.022, 14.0),
        _kick(0.5, 0.12),
    ]),
    "outro": lambda: "+".join([
        _pad([["C3", "G3", "C4", "E4"], ["F2", "C3", "A3", "E4"], ["G2", "D3", "B3", "D4"], ["C3", "G3", "E4", "G4"]], 3.0, 0.05),
        _bells(["E5", "G4", "C5", "D5"], 3.0, 0.03),
    ]),
}


def render_segment(preset: str, duration: float, out: Path, ff) -> None:
    expr = PRESETS[preset]()
    ff([
        "-f", "lavfi", "-i", f"aevalsrc='{expr}|{expr}':s={SR}:d={duration:.3f}",
        "-af", "lowpass=f=5200,highpass=f=35,aecho=0.8:0.6:380|560:0.22|0.15,"
               "stereotools=mlev=1:slev=1.15,afade=t=in:d=1.5",
        "-ar", str(SR), "-c:a", "pcm_s24le", str(out),
    ])


def _segment_key(preset: str, duration: float) -> str:
    import hashlib
    # 運算式、長度與濾鏡都相同 → 輸出逐位元相同，可以重用（重新配音後只有長度改變的場景要重做）
    return hashlib.sha256(f"{SEGMENT_VERSION}|{preset}|{PRESETS[preset]()}|{duration:.3f}|{SR}".encode()).hexdigest()[:16]


SEGMENT_VERSION = "1"


def build_score(segments: list[tuple[str, float]], workdir: Path, out: Path, ff, xfade: float = 2.5) -> None:
    """segments: [(preset, 秒數)]，相鄰段以 acrossfade 交叉淡化；總長等於各段總和。

    每段是獨立的單執行緒 ffmpeg（aevalsrc），平行產生（最多一半的邏輯核心，渲染同時進行也留有餘裕），
    並以內容雜湊快取：EP16 實測 10 段依序產生 247 秒。"""
    import os
    from concurrent.futures import ThreadPoolExecutor

    files, todo, reused = [], [], 0
    for i, (preset, dur) in enumerate(segments):
        # 交叉淡化會吃掉重疊長度，除最後一段外每段多產生 xfade 秒
        extra = xfade if i < len(segments) - 1 else 0.0
        f = workdir / f"music_{i:02d}_{preset}.wav"
        key = _segment_key(preset, dur + extra)
        stamp = f.with_suffix(".key")
        if f.exists() and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == key:
            reused += 1
        else:
            stamp.unlink(missing_ok=True)
            todo.append((preset, dur + extra, f, stamp, key))
        files.append(f)

    def one(job):
        preset, d, f, stamp, key = job
        render_segment(preset, d, f, ff)
        stamp.write_text(key, encoding="utf-8")

    cap = int(os.environ.get("PIKARA_MIX_WORKERS") or 0) or (os.cpu_count() or 2) // 2
    workers = max(1, min(len(todo), cap))
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(one, todo))  # 任何一段失敗都會在這裡拋出
    print(f"   配樂分段：產生 {len(todo)} 段（並行 {workers if todo else 0}），重用 {reused} 段", flush=True)
    if len(files) == 1:
        total = segments[0][1]
        ff(["-i", str(files[0]), "-af", f"afade=t=out:st={max(0, total - 3):.3f}:d=3,atrim=end={total:.3f}", "-c:a", "pcm_s24le", str(out)])
        return
    args: list[str] = []
    for f in files:
        args += ["-i", str(f)]
    chain = []
    last = "[0:a]"
    for i in range(1, len(files)):
        lbl = f"[x{i}]"
        chain.append(f"{last}[{i}:a]acrossfade=d={xfade}:c1=qsin:c2=qsin{lbl}")
        last = lbl
    total = sum(d for _, d in segments)
    ff([*args, "-filter_complex", ";".join(chain) + f";{last}afade=t=out:st={max(0, total - 4):.3f}:d=4,atrim=end={total:.3f}[out]",
        "-map", "[out]", "-c:a", "pcm_s24le", str(out)])
