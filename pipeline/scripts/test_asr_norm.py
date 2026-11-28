"""py -3.11 scripts/test_asr_norm.py — 繁簡字形與數字寫法正規化（不需要 GPU）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from asr_norm import cn_number, norm_cer, normalize_hyp  # noqa: E402


def test() -> None:
    assert cn_number(16) == "十六" and cn_number(105) == "一百零五" and cn_number(18000) == "一万八千".replace("万", "萬")
    assert cn_number(1946) == "一千九百四十六"
    # 年份逐位念、數量完整念：依旁白用的念法
    assert normalize_hyp("1946年重约30吨", "一九四六年重约三十吨") == "一九四六年重约三十吨"
    assert norm_cer("fp六十四的速度只有fp三十二的六十四分之一", "fp64的速度只有fp32的六十四分之一") == 0.0
    # 繁簡字形不同不算錯
    assert norm_cer("为了这个目标cpu把很多晶体管花在缓存上", "為了這個目標cpu把很多晶體管花在緩存上") == 0.0
    # 真的念錯仍然是錯
    assert norm_cer("那为什么不干脆让gpu接管一切", "那为什么要不干脆让鸡皮油接管一切") > 0.25
    assert norm_cer("cpu惨叫哈啊啊啊", "cpu残教") > 0.5
    print("test_asr_norm: OK")


if __name__ == "__main__":
    test()
