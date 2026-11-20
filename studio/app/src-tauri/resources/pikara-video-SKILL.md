---
name: pikara-video
description: How the Pikara Science Remotion video pipeline works (narration.json → CosyVoice TTS → timeline → mix → render.mjs → QA, zh-TW and zh-CN/Bilibili variants). Use when editing narration, act code, or diagnosing a failed voiceover/render/QA job in this project.
---

# Pikara Science video pipeline

Narration-driven explainer videos built with Remotion (React + TypeScript + SVG + Three.js), rendered deterministically frame by frame.
This Skill was installed by Pikara Science Studio. Studio runs the commands below as queued jobs; when you work inside a Studio worktree,
**do not run GPU commands** (render, stills, gpu:check, CosyVoice) — Studio's scheduler owns the GPU. Edit files and explain; the user re-runs jobs.

## Source of truth

- `src/data/narration.json` (zh-TW) — `sequences.<seq>.scenes[].lines[]`, each line:
  - `id` (unique per sequence, e.g. `a3-05`), `subtitle` (on-screen text), optional `speak` (what TTS reads, e.g. subtitle `llama.cpp`, speak `llama C P P`),
  - optional `anchors` `{ name: word }` — the word **must appear in `speak` (or `subtitle` if no `speak`)** after removing punctuation/spaces, case-insensitive; `scripts/build_timeline.py` aborts with `找不到錨點詞` otherwise. Anchor names must be unique within a scene.
  - optional `pauseAfter` (seconds), optional `cosySpeed`.
  - `sequences.ep01.voiceEngine` = `"cosyvoice"` selects `public/assets/audio/voiceover_cosy/`.
- `src_cn/` is **generated** from `src/` by `scripts/make_cn.py` (OpenCC tw2sp + mainland tech-term table). Don't hand-edit `src_cn/` code; it is overwritten. `src_cn/data/narration.json` only contains `ep01`.
- Animation code: `src/acts/Act01..07`, `src/Root.tsx` (compositions `EP01` 60 fps, `EP01-30fps`, `EP01-YT15` 1.5× at 30 fps, `ArtTest`), timing via `src/lib/timewarp.ts` (template anchors → narration anchors).
- Generated (don't edit by hand): `src/data/timeline.generated.json`, `out/subtitles/*.srt`, `public/assets/audio/mix/*.wav`.

## Commands (run from the project root; Windows, Node in `C:\Program Files\nodejs`, Python via `py -3.11`)

| Step | Command |
|---|---|
| Typecheck (safe, CPU) | `node node_modules/typescript/bin/tsc --noEmit` |
| TTS zh-TW (GPU) | `tools\CosyVoice\.venv\Scripts\python.exe -u scripts/generate_voiceover_cosy.py --seq ep01 [--only a1-00 a4-15] [--force] [--target-cps N]` — per-line cache, skips finished lines |
| TTS zh-CN (GPU) | same + `--narration src_cn/data/narration.json --out-root public/assets/audio/voiceover_cosy_cn --ref tools/CosyVoice/reference_cn/reference.wav --ref-text-file tools/CosyVoice/reference_cn/reference.txt --target-cps 5.4` with env `PIKARA_ASR_CC=t2s` |
| Timeline + SRT (CPU) | `py -3.11 scripts/build_timeline.py --seq ep01` (zh-CN: `--src src_cn --voice-dir public/assets/audio/voiceover_cosy_cn --srt-name ep01_cn`; `--estimate` when audio is missing) |
| Mix (CPU) | `py -3.11 scripts/mix_audio.py --seq ep01` (zh-CN: `--src src_cn --mix-name ep01_cn`) — -16 LUFS, -1.5 dBTP, sidechain ducking |
| Render (GPU) | `node scripts/render.mjs gpu --comp EP01-30fps --out EP01_Final.mp4` (`--src src_cn --mix ep01_cn`, `--frames a-b`, `--concurrency N`, `--codec hevc`, `cpu`/`preview` modes). Renders 1800-frame chunks into `out/frames/<tag>/`, resumable; prints `區段 a–z：…` per chunk and `完成：<file>` at the end; report in `out/reports/<tag>.json` |
| YouTube 1.5× | `py -3.11 scripts/scale_srt.py EP01.srt EP01_YouTube_zh-TW.srt 1.5` then `node scripts/render.mjs gpu --comp EP01-YT15 --out EP01_YouTube_zh-TW.mp4` |
| zh-CN source | `py -3.11 scripts/make_cn.py` (rmtree + regenerate `src_cn/`) |
| QA (CPU) | `py -3.11 scripts/qa_video.py EP01_Final.mp4 --seq ep01 [--src src_cn] [--speed 1.5]` → `out/qa/<name>.md` (black frames, long stills, true peak, silence inside narration, subtitle overlap) |
| Stills (GPU) | `node scripts/stills.mjs` → `out/stills/` |

Bilibili chain: make_cn → TTS zh-CN → timeline (src_cn) → copy `out/subtitles/ep01_cn.srt` → mix (src_cn) → render `EP01-30fps --src src_cn --mix ep01_cn --out EP01_Bilibili_zh-CN.mp4` → QA.

## Known behaviour and pitfalls

- Video length follows the narration (CosyVoice ≈ 3.6 chars/s zh-TW). After any narration change: TTS → timeline → mix → render.
- The 8 "black frames" in QA are by design (act transitions, act 6 cursor, end card). 4–5 s near-static shots are informational.
- `pauseAfter` defaults to 0.38 s, scene gap 0.8 s (see `defaults` in narration.json).
- Subtitles are cut at punctuation, ≤ 18 chars per cue — long subtitles are fine but get split.
- Chrome headless shell lives in `node_modules/.remotion/chrome-headless-shell/`; `scripts/lib.mjs` copies it to a short path if the path is ≥ 240 chars.
- Never change GPU clocks/power/thermal settings; render.mjs adapts concurrency to VRAM and temperature itself.
- Publishing is manual: `PUBLISH_METADATA.md` holds titles/descriptions/tags. Never add upload code.

## When fixing a failed job

1. Read the job log excerpt given in the prompt; find the first real error (Python traceback, `[錯誤]`, `區段 … 失敗`, tsc error).
2. Content errors (missing anchor word, duplicate id, TypeScript error) → fix in `src/` / `narration.json`, keep JSON 2-space indented and key order unchanged.
3. Environment errors (ffmpeg/chrome/CUDA missing, VRAM OOM) → don't edit code; explain the fix (Studio's Environment Doctor handles these).
4. Keep diffs minimal. Studio shows your diff to the user, who decides to merge or discard.
