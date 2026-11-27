"""tools\CosyVoice\.venv\Scripts\python.exe scripts/test_speaker_ref.py — 角色人聲的查找（不需要 GPU）。

簡體版的旁白參考音在 reference_cn，角色人聲（ref_S1…）在 reference：角色台詞必須找到 reference 裡的人聲，
不能默默改用旁白的聲音；繁體版（同一個資料夾）的快取鍵不變。"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import generate_voiceover_cosy as g  # noqa: E402


def test() -> None:
    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        tw, cn = t / "reference", t / "reference_cn"
        tw.mkdir()
        cn.mkdir()
        for n in ("ref_S3.wav", "ref_S3.txt"):
            (tw / n).write_text("x", encoding="utf-8")
        g.SPEAKER_REF_DIR = tw
        chars = {"gpu": {"name": "小G", "voice": "ref_S3", "pitch": 3}, "x": {"name": "X", "voice": "ref_S9"}}
        ln = {"speaker": "gpu"}
        # 繁體：參考音與角色人聲同一個資料夾 → 沒有 refDir（快取鍵與舊版相同）
        sv = g.speaker_voice(ln, chars, tw)
        assert sv == {"id": "gpu", "ref": "ref_S3", "pitch": 3.0}, sv
        # 簡體：reference_cn 沒有 → 借用 reference
        sv = g.speaker_voice(ln, chars, cn)
        assert sv["ref"] == "ref_S3" and Path(sv["refDir"]) == tw, sv
        assert g.spk_dir(sv, cn / "reference.wav") == tw
        # 兩邊都沒有 → 旁白人聲（只保留音高）
        sv = g.speaker_voice({"speaker": "x"}, chars, cn)
        assert sv["ref"] is None, sv
    print("test_speaker_ref: OK")


if __name__ == "__main__":
    test()
