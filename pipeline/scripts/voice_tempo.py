# 旁白語速（保留音高的時間伸縮）。原始配音檔永遠不修改：加速後的檔案另存在同資料夾的 _tempo/ 底下，
# 檔名含倍率，旁邊的 .json 記錄來源檔的 SHA 與濾鏡；來源改變才重做（快取），而且只會從「原始檔」產生，不會對已加速的檔案再加速一次。
#   from voice_tempo import ensure_tempo, stretch_file
import hashlib
import json
import subprocess
from pathlib import Path

DERIVED = "_tempo"
TEMPO_MIN, TEMPO_MAX = 0.85, 1.6
# Rubber Band：保留音高與共振峰（formant），高品質音高模式。window=short、phase=independent 對語音的子音較清楚（A/B 見 out/voice_speed）。
VARIANTS = {
    "speech": "transients=crisp:detector=compound:phase=independent:window=short:formant=preserved:pitchq=quality",
    "default": "formant=preserved:pitchq=quality",
}
VARIANT = "speech"
VERSION = 1  # 濾鏡設定改變時加一，快取自動失效


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def filter_for(tempo: float, variant: str = VARIANT) -> str:
    return f"rubberband=tempo={tempo:.4f}:{VARIANTS[variant]}"


def is_derived(p: Path) -> bool:
    return DERIVED in Path(p).parts


def stretch_file(src: Path, dst: Path, tempo: float, variant: str = VARIANT) -> None:
    """src → dst，時間 ÷ tempo，音高不變。dst 與 src 不能是同一個檔案。"""
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("不可覆寫原始配音檔")
    if not (TEMPO_MIN - 1e-6 <= tempo <= TEMPO_MAX + 1e-6):
        raise ValueError(f"語速倍率 {tempo} 超出 {TEMPO_MIN}–{TEMPO_MAX}")
    sr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "json", str(src)],
                                   capture_output=True, text=True, check=True, timeout=60).stdout)["streams"][0]["sample_rate"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".part" + dst.suffix)
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src), "-af", filter_for(tempo, variant), "-ar", str(sr), "-ac", "1",
                    "-c:a", "libmp3lame", "-q:a", "2", str(tmp)], check=True, timeout=300)
    tmp.replace(dst)


def tempo_path(mp3: Path, tempo: float) -> Path:
    mp3 = Path(mp3)
    return mp3.parent / DERIVED / f"{mp3.stem}.x{tempo:.3f}{mp3.suffix}"


def ensure_tempo(mp3: Path, tempo: float) -> Path:
    """回傳要放進時間軸的音檔：tempo≈1 就是原始檔；否則是 _tempo/ 下的加速版（必要時產生）。"""
    mp3 = Path(mp3)
    if is_derived(mp3):
        raise ValueError(f"{mp3} 已經是調速後的檔案，不可再套用一次語速")
    if abs(tempo - 1.0) < 1e-3:
        return mp3
    dst = tempo_path(mp3, tempo)
    meta = dst.with_suffix(".json")
    want = {"source": mp3.name, "sourceSha": _sha(mp3), "tempo": round(tempo, 4), "filter": filter_for(tempo), "version": VERSION}
    if dst.exists() and meta.exists():
        try:
            if json.loads(meta.read_text(encoding="utf-8")) == want:
                return dst
        except Exception:  # noqa: BLE001
            pass
    stretch_file(mp3, dst, tempo)
    meta.write_text(json.dumps(want, ensure_ascii=False, indent=1), encoding="utf-8")
    return dst
