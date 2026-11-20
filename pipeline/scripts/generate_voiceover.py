"""
Pikara Science — Edge-TTS 旁白產生器

  python scripts/generate_voiceover.py --seq arttest        # 產生某段落
  python scripts/generate_voiceover.py --seq all            # 全部
  python scripts/generate_voiceover.py --test               # 只測試台灣男聲
  python scripts/generate_voiceover.py --check --seq all    # 只驗證，不產生

設計：
- 逐句產生（不一次送整篇），用 Python API 的 stream() 同時收音訊與 WordBoundary 時間邊界。
- 快取：以 (朗讀文字 + 語音設定) 的 SHA-256 判斷；內容沒變就不重新產生。
- 失敗重試最多 5 次，指數退避 + 抖動；以 Semaphore 限制同時請求數。
- 先寫入 .part 暫存檔，經 ffprobe 驗證長度與編碼後才改名；失敗一律刪除不完整檔案。
- 只使用 narration.json 指定的語音（zh-TW-YunJheNeural），全部失敗時直接報錯，不換配音員，也不假裝成功。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NARRATION = ROOT / "src" / "data" / "narration.json"
OUT_DIR = ROOT / "public" / "assets" / "audio" / "voiceover"
MANUAL_DIR = OUT_DIR / "manual"
MAX_ATTEMPTS = 5  # 單一請求的上限（整句 3 次 + 拆分後每段 2 次，皆不超過 5）
FULL_ATTEMPTS = 3
SPLIT_ATTEMPTS = 2
BREAKER = 6  # 連續失敗句數上限，達到就停止本輪
BASE_DELAY = 3.0
PACE = 2.5  # 兩個請求之間的最短間隔（秒），避免觸發服務端節流
GENERATOR_VERSION = "pikara-tts-v1"  # 改變產生邏輯時遞增，以讓快取失效

sys.stdout.reconfigure(encoding="utf-8")


def ffprobe(path: Path) -> dict | None:
    """回傳 {duration, codec, sample_rate}；檔案無效回傳 None。"""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return None
        info = json.loads(r.stdout)
        streams = info.get("streams") or []
        dur = float(info.get("format", {}).get("duration", 0) or 0)
        if not streams or dur <= 0:
            return None
        return {"duration": dur, "codec": streams[0].get("codec_name"), "sample_rate": int(streams[0].get("sample_rate", 0))}
    except Exception:
        return None


@dataclass
class Job:
    seq: str
    scene: str
    line: dict
    voice: dict

    @property
    def speak(self) -> str:
        return self.line.get("speak") or self.line["subtitle"]

    @property
    def key(self) -> str:
        payload = json.dumps({"t": self.speak, "v": self.voice, "g": GENERATOR_VERSION}, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @property
    def mp3(self) -> Path:
        return OUT_DIR / self.seq / f"{self.line['id']}.mp3"

    @property
    def meta(self) -> Path:
        return OUT_DIR / self.seq / f"{self.line['id']}.json"


def load_jobs(seq_filter: str) -> list[Job]:
    data = json.loads(NARRATION.read_text(encoding="utf-8"))
    base_voice = data["voice"]
    jobs: list[Job] = []
    for seq_id, seq in data["sequences"].items():
        if seq_filter != "all" and seq_id != seq_filter:
            continue
        for scene in seq["scenes"]:
            for line in scene["lines"]:
                voice = {**base_voice, **line.get("voice", {})}
                if voice["name"] != base_voice["name"]:
                    raise SystemExit(f"[錯誤] {line['id']} 指定了不同的配音員 {voice['name']}；本專案固定使用 {base_voice['name']}。")
                jobs.append(Job(seq_id, scene["id"], line, voice))
    if not jobs:
        raise SystemExit(f"[錯誤] 找不到段落：{seq_filter}")
    return jobs


def cached_ok(job: Job) -> bool:
    if not job.mp3.exists() or not job.meta.exists():
        return False
    try:
        meta = json.loads(job.meta.read_text(encoding="utf-8"))
    except Exception:
        return False
    if meta.get("key") != job.key:
        return False
    probe = ffprobe(job.mp3)
    return probe is not None and abs(probe["duration"] - meta.get("duration", -1)) < 0.05


def sanitize(text: str) -> str:
    """移除控制字元、零寬字元與 BOM；統一空白。Edge-TTS 會自行做 XML 跳脫，這裡不需要手動處理 < & >。"""
    text = re.sub(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏  ﻿]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def split_sentences(text: str, min_len: int = 6) -> list[str]:
    """在句號、問號、驚嘆號、分號、冒號、逗號處切開；太短的片段併回前一段。"""
    parts = [p for p in re.findall(r"[^。？！；：，]+[。？！；：，]?", text) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and len(p) < min_len:
            out[-1] += p
        else:
            out.append(p)
    return out


async def synth_once(text: str, voice: dict, part: Path) -> list[dict]:
    import edge_tts  # 延遲載入，--check 不需要網路

    comm = edge_tts.Communicate(sanitize(text), voice["name"], rate=voice["rate"], pitch=voice["pitch"], volume=voice["volume"], boundary="WordBoundary")
    boundaries: list[dict] = []
    got_audio = False
    with open(part, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
                got_audio = True
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                boundaries.append({
                    "type": chunk["type"],
                    "text": chunk["text"],
                    "start": chunk["offset"] / 1e7,  # 100ns → 秒
                    "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                })
    if not got_audio:
        raise RuntimeError("沒有收到音訊（NoAudioReceived）")
    return boundaries


async def synth_retry(text: str, voice: dict, part: Path, label: str, attempts: int) -> list[dict] | None:
    for attempt in range(1, attempts + 1):
        try:
            b = await synth_once(text, voice, part)
            probe = ffprobe(part)
            if probe is None or probe["duration"] < 0.25:
                raise RuntimeError("ffprobe 驗證失敗（檔案無效或過短）")
            return b
        except Exception as e:  # noqa: BLE001
            part.unlink(missing_ok=True)
            if attempt == attempts:
                print(f"  … {label} 第 {attempt} 次失敗（{type(e).__name__}），放棄這個請求", flush=True)
                return None
            delay = BASE_DELAY * (2 ** (attempt - 1)) + random.uniform(0, 1.5)
            print(f"  … {label} 第 {attempt} 次失敗（{type(e).__name__}），{delay:.1f}s 後重試", flush=True)
            await asyncio.sleep(delay)
    return None


def concat_mp3(parts: list[Path], out: Path, gap: float = 0.12) -> list[float]:
    """把分段音檔接起來（段間 gap 秒靜音），回傳每段的起始秒數。"""
    offsets, t = [], 0.0
    for p in parts:
        offsets.append(t)
        t += ffprobe(p)["duration"] + gap
    args: list[str] = []
    for p in parts:
        args += ["-i", str(p)]
    filt = "".join(f"[{i}:a]aresample=24000,apad=pad_dur={gap}[a{i}];" for i in range(len(parts)))
    filt += "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
    r = subprocess.run(["ffmpeg", "-hide_banner", "-y", *args, "-filter_complex", filt, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "96k", "-ar", "24000", "-ac", "1", str(out)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 合併分段失敗：" + r.stderr[-300:])
    return offsets


def write_meta(job: Job, probe: dict, boundaries: list[dict], extra: dict) -> None:
    meta = {
        "id": job.line["id"], "scene": job.scene, "seq": job.seq, "key": job.key,
        "voice": job.voice, "subtitle": job.line["subtitle"], "speak": job.speak,
        "file": job.mp3.relative_to(ROOT / "public").as_posix(),
        "duration": round(probe["duration"], 4), "codec": probe["codec"], "sample_rate": probe["sample_rate"],
        "boundaries": boundaries, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **extra,
    }
    job.meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def manual_source(job: Job) -> Path | None:
    for ext in (".wav", ".mp3", ".m4a", ".flac"):
        p = MANUAL_DIR / job.seq / f"{job.line['id']}{ext}"
        if p.exists():
            return p
    return None


def use_manual(job: Job, src: Path) -> bool:
    """手動補充配音：轉成標準 MP3，時間邊界留空（字幕與錨點改用字數比例）。"""
    job.mp3.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse",
                        "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "48000", str(job.mp3)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    probe = ffprobe(job.mp3) if r.returncode == 0 else None
    if probe is None:
        print(f"  ✗ {job.line['id']} 手動音檔無法讀取：{src.name}")
        return False
    write_meta(job, probe, [], {"manual": True, "manual_source": src.relative_to(ROOT).as_posix(), "key": job.key})
    print(f"  ✓ {job.line['id']}  {probe['duration']:.2f}s（手動配音 {src.name}）", flush=True)
    return True


async def generate(job: Job, sem: asyncio.Semaphore, log: list[str]) -> bool:
    job.mp3.parent.mkdir(parents=True, exist_ok=True)
    part = job.mp3.with_suffix(".mp3.part")
    async with sem:
        t0 = time.time()
        # 1) 整句：最多 FULL_ATTEMPTS 次
        b = await synth_retry(job.speak, job.voice, part, job.line["id"], FULL_ATTEMPTS)
        extra: dict = {}
        if b is not None:
            part.replace(job.mp3)
        else:
            # 2) 整句失敗 → 依標點拆成短句分別產生（每段最多 SPLIT_ATTEMPTS 次），再接起來
            pieces = split_sentences(job.speak)
            if len(pieces) < 2:
                log.append(f"  ✗ {job.line['id']}  整句失敗且無法再拆分")
                return False
            print(f"  … {job.line['id']} 改為分段產生（{len(pieces)} 段）", flush=True)
            files, bnds = [], []
            for i, txt in enumerate(pieces):
                pf = job.mp3.with_name(f"{job.line['id']}.seg{i}.mp3")
                bb = await synth_retry(txt, job.voice, pf, f"{job.line['id']}#{i}", SPLIT_ATTEMPTS)
                if bb is None:
                    for f in files:
                        f.unlink(missing_ok=True)
                    pf.unlink(missing_ok=True)
                    log.append(f"  ✗ {job.line['id']}  分段 {i + 1}/{len(pieces)} 也失敗")
                    return False
                files.append(pf)
                bnds.append(bb)
                await asyncio.sleep(PACE)
            offsets = concat_mp3(files, part)
            b = [{**x, "start": x["start"] + off, "end": x["end"] + off} for bb, off in zip(bnds, offsets) for x in bb]
            for f in files:
                f.unlink(missing_ok=True)
            part.replace(job.mp3)
            extra = {"split": pieces}
        probe = ffprobe(job.mp3)
        write_meta(job, probe, b, extra)
        print(f"  ✓ {job.line['id']}  {probe['duration']:.2f}s" + ("（分段合成）" if extra else ""), flush=True)
        log.append(f"  ✓ {job.line['id']}  {probe['duration']:.2f}s  {len(b)} 個邊界  ({time.time() - t0:.1f}s)" + ("  分段合成" if extra else ""))
        await asyncio.sleep(PACE)
        return True


async def run(jobs: list[Job], concurrency: int) -> int:
    # 手動補充配音優先（放在 public/assets/audio/voiceover/manual/<seq>/<id>.wav|mp3）
    for j in jobs:
        src = manual_source(j)
        if src is not None:
            meta = json.loads(j.meta.read_text(encoding="utf-8")) if j.meta.exists() else {}
            if not (meta.get("manual") and meta.get("manual_source") == src.relative_to(ROOT).as_posix() and j.mp3.exists()):
                use_manual(j, src)
    todo = [j for j in jobs if not cached_ok(j) and manual_source(j) is None]
    print(f"共 {len(jobs)} 句，已完成 {len(jobs) - len(todo)} 句，需要產生 {len(todo)} 句（同時 {concurrency} 個請求，間隔 {PACE}s）")
    for p in OUT_DIR.rglob("*.part"):
        p.unlink(missing_ok=True)
    sem = asyncio.Semaphore(concurrency)
    log: list[str] = []
    failed = 0
    streak = 0
    for j in todo:  # 依序處理，便於「連續失敗就停止」
        ok = await generate(j, sem, log)
        if ok:
            streak = 0
        else:
            failed += 1
            streak += 1
            if streak >= BREAKER:
                print(f"\n[停止] 連續 {BREAKER} 句失敗，服務可能正在限流；為避免大量請求，本次先停在這裡。")
                break
    print("\n".join(log))
    remaining = len([j for j in jobs if not cached_ok(j) and manual_source(j) is None])
    if remaining:
        print(f"\n[未完成] 還有 {remaining} 句沒有音檔。成功的句子已保存；配音員未更換。"
              f"\n  稍後重新執行即可續傳，或把真人錄音放到 public/assets/audio/voiceover/manual/<seq>/<句子ID>.wav")
        return 1
    print("\n全部完成。")
    return 0


def check(jobs: list[Job]) -> int:
    bad = 0
    total = 0.0
    for j in jobs:
        if not j.mp3.exists():
            print(f"  ✗ {j.line['id']}  缺少音檔")
            bad += 1
            continue
        probe = ffprobe(j.mp3)
        meta = json.loads(j.meta.read_text(encoding="utf-8")) if j.meta.exists() else {}
        stale = meta.get("key") != j.key
        if probe is None:
            print(f"  ✗ {j.line['id']}  ffprobe 無法讀取")
            bad += 1
        elif stale:
            print(f"  ! {j.line['id']}  文字或語音設定已變更，需要重新產生")
            bad += 1
        elif meta.get("manual"):
            total += probe["duration"]
            print(f"  ✓ {j.line['id']}  {probe['duration']:.2f}s  手動配音（字幕依字數比例對齊）")
        elif not meta.get("boundaries"):
            print(f"  ! {j.line['id']}  缺少時間邊界資料")
            bad += 1
        else:
            total += probe["duration"]
            print(f"  ✓ {j.line['id']}  {probe['duration']:.2f}s  {probe['codec']} {probe['sample_rate']}Hz  {len(meta['boundaries'])} 個邊界")
    print(f"\n有效 {len(jobs) - bad}/{len(jobs)} 句，總長 {total:.1f}s")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seq", default="arttest", help="arttest | ep01 | all")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--test", action="store_true", help="只產生一句測試語音")
    a = ap.parse_args()

    if a.test:
        data = json.loads(NARRATION.read_text(encoding="utf-8"))
        line = {"id": "voice-test", "subtitle": "歡迎來到 Pikara Science。今天我們來聊聊 GPU、VRAM，還有 llama.cpp。",
                "speak": "歡迎來到 Pikara Science。今天我們來聊聊 GPU、VRAM，還有 llama C P P。"}
        job = Job("_test", "_test", line, data["voice"])
        if job.mp3.exists():
            job.mp3.unlink()
        print(f"語音：{data['voice']['name']}  rate={data['voice']['rate']} pitch={data['voice']['pitch']}")
        code = asyncio.run(run([job], 1))
        if code == 0:
            print(f"測試音檔：{job.mp3.relative_to(ROOT)}")
        return code

    jobs = load_jobs(a.seq)
    if a.check:
        return check(jobs)
    return asyncio.run(run(jobs, max(1, min(a.concurrency, 4))))


if __name__ == "__main__":
    sys.exit(main())
