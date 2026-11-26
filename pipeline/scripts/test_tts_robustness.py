# tools/CosyVoice/.venv/Scripts/python.exe scripts/test_tts_robustness.py
# 配音完整性檢查（合成訊號）＋ 沒有 nvidia-smi（AMD／Intel／Apple／無 GPU）時 TTS 腳本的 GPU 協調函式不會崩潰。
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audio_integrity import analyze, units  # noqa: E402

SR = 24000
rng = np.random.default_rng(0)


def speech(sec, amp=0.4, fade=True):
    """類語音訊號：有包絡的噪音＋基頻，首尾 80 ms 淡入淡出（自然收尾）。"""
    t = np.arange(int(SR * sec)) / SR
    w = amp * (0.6 * np.sin(2 * np.pi * 180 * t) + 0.4 * rng.standard_normal(t.size) * 0.3) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t) ** 2)
    if fade:
        n = int(SR * 0.08)
        w[:n] *= np.linspace(0, 1, n)
        w[-n:] *= np.linspace(1, 0, n)
    return np.concatenate([np.zeros(int(SR * 0.15)), w, np.zeros(int(SR * 0.2))]).astype(np.float32) if fade else w.astype(np.float32)


text = "為什麼 GPU 不能取代 CPU？"  # 7 個中文字＋G P U＋C P U＝13 單位
assert units(text) == 13, units(text)
cases = {
    "normal": (speech(3.4), True, None),
    "silent": (np.zeros(SR * 3, dtype=np.float32), False, "silent"),
    "clipping": (np.clip(speech(3.4) * 6, -1, 1), False, "clipping"),
    "cut_tail": (np.concatenate([np.zeros(int(SR * 0.15)), speech(3.4, fade=False)]), False, "cut_tail"),
    "too_fast": (speech(1.5), False, "too_fast"),  # 13 單位 / 1.5 秒 ≈ 8.7 字/秒（吞字）
    "too_slow": (speech(16.0), False, "too_slow"),
}
bad = 0
for name, (w, want_ok, want_problem) in cases.items():
    r = analyze(w, SR, text)
    ok = r["ok"] == want_ok and (want_problem is None or any(p.startswith(want_problem) for p in r["problems"]))
    bad += not ok
    print("ok  " if ok else "FAIL", f"{name:9s}", r["problems"] or "通過", f"rate={r['rate']}")

# 實測變速倍率：原始時長＝token ÷ 25。3.75 秒的音訊對應 140 token（5.6 秒）＝ 1.49× → sped_up；94 token（3.76 秒）＝ 1.0× → 通過
w = speech(3.4)
dur = w.size / SR
for tokens, want in ((int(dur * 25 * 1.5), "sped_up"), (int(dur * 25), None), (int(13 * 1.5), "few_tokens")):
    r = analyze(w, SR, text, tokens=tokens, applied_speed=1.0)
    ok = (want is None and r["ok"]) or (want is not None and any(p.startswith(want) for p in r["problems"]))
    bad += not ok
    cases[f"tokens={tokens}"] = None
    print("ok  " if ok else "FAIL", f"tokens={tokens:<4d} 倍率 {r['effectiveSpeed']}×，每字 {r['tokensPerUnit']} token", r["problems"] or "通過")
r = analyze(w, SR, text, applied_speed=1.66)
ok = any(p.startswith("sped_up") for p in r["problems"])
bad += not ok
cases["applied=1.66"] = None
print("ok  " if ok else "FAIL", "設定 speed 1.66", r["problems"])
# 自然語速但字很密（7.5 字/秒、倍率 1.0×）：不應誤判為 too_fast
fast_nat = speech(13 / 7.5)
r = analyze(fast_nat, SR, text, tokens=int(fast_nat.size / SR * 25), applied_speed=1.0)
ok = r["ok"]
bad += not ok
cases["dense-natural"] = None
print("ok  " if ok else "FAIL", f"自然語速的密集短句 {r['rate']} 字/秒、倍率 {r['effectiveSpeed']}×", r["problems"] or "通過（不誤判）")

# 沒有 nvidia-smi：GPU 協調函式回傳 0 / False，不丟例外
import generate_voiceover_cosy as g  # noqa: E402

real_run, real_popen = subprocess.run, subprocess.Popen


def no_smi(cmd, *a, **k):
    if cmd and str(cmd[0]).startswith("nvidia-smi"):
        raise FileNotFoundError("nvidia-smi")
    return real_run(cmd, *a, **k)


subprocess.run = no_smi
try:
    assert g.gpu_used_mb() == 0 and g.gpu_temp() == 0 and g._smi("-L") == ""
    assert isinstance(g.render_running(), bool)
    print("ok   沒有 nvidia-smi：gpu_used_mb=0、gpu_temp=0、render_running 可用")
finally:
    subprocess.run = real_run
print(f"\n{len(cases) - bad}/{len(cases)} integrity cases passed")
sys.exit(1 if bad else 0)
