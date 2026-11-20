# Pikara Science Studio

English ｜ [繁體中文](README.md)

A Windows desktop workbench that wraps a complete AI science-animation video pipeline: script & narration editing, Claude Code collaboration, local voice-over (CosyVoice 3), Whisper word alignment, narration-driven animation and subtitle sync, GPU rendering, NVENC encoding, quality checks, and a resumable unattended job queue.

> **v0.1.1-alpha** — public test release (multi-episode support, QA fixes; see [CHANGELOG](CHANGELOG.md)). It works, but has known limitations (below). Don't rely on it for work that can't tolerate errors.

## What's inside

| Folder | Contents |
|---|---|
| `studio/` | Pikara Science Studio desktop app source (Tauri 2 + Rust core + HTML UI) and design docs |
| `pipeline/` | The video project template: Remotion (React + Three.js) animation, narration data, and voice/alignment/mix/render/QA scripts. This is the "project folder" you open in Studio |

## Quick start

1. **Install Studio** — download `Pikara Science Studio_0.1.1_x64-setup.exe` (or the portable `PikaraScienceStudio.exe`) from [Releases](../../releases). Windows 10/11 x64; the installer fetches Microsoft WebView2 if needed.
2. **Get the template** — `git clone https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio.git`; the template project is `PikaraScienceStudio\pipeline`.
3. **First launch** — open Studio → **Projects** → enter the full path of the `pipeline` folder → **Add project**. Go to **Environment Doctor** → **Re-check**; press **Fix** on auto-fixable items (e.g. installing Remotion dependencies, downloading Chrome Headless Shell); the rest show the commands to run manually. Then use **Production** to enqueue a job and watch it in **Queue** and **Monitor**.

### Requirements

| Component | Purpose | How |
|---|---|---|
| Node.js 20+ | Remotion rendering, scripts | install manually |
| Python 3.11 | timeline, mixing, QA scripts | install manually |
| ffmpeg with h264_nvenc | encode, mix, probe | install manually (e.g. `winget install Gyan.FFmpeg`) — GPL builds, not bundled |
| NVIDIA GPU + driver | GPU render (ANGLE), NVENC, CosyVoice CUDA | optional; CPU compatibility mode exists |
| CosyVoice 3 (Python 3.10 venv + weights) | local voice-over | manual, see `studio/docs/ENVIRONMENT_SETUP.md`; weights downloaded by you |
| Claude Code CLI | run prompts / collaborative edits | optional; uses your own account or API key |

## Features (v0.1.1)

Projects (incl. creating a new project from the template, Chinese/space paths OK) · Episodes (picker, "new episode", per-episode output names, generic narration template for episodes without hand-made animation) · Headless `--cli` · Script editor (zh-TW and zh-CN narration, validation, git-committed saves, audio preview) · Prompt studio (prompts from real project data; Claude Code in an isolated git worktree, manual merge/discard) · Production & persistent SQLite queue (YouTube zh-TW 1.5×, Bilibili zh-CN, single steps; one GPU job at a time with external GPU-process detection; heartbeats; auto-requeue after interruption) · Live CPU/RAM/GPU/VRAM/temperature/power/NVENC monitor · Environment Doctor (17 real checks, safe auto-fixes) · Preview & Publish centre (playback, ffprobe info, copyable metadata — **no upload code; publishing is always manual**) · Git rollback (revert, or confirmed reset with automatic backup branch).

## Known issues (v0.1.1-alpha)

- New episodes get only the generic narration template (chapter titles + keyword cards); polished animation still needs hand-written React components (or Claude Code via the Prompt page).
- No folder-picker dialog; type the project path.
- Cancel uses `taskkill /T /F`; failed jobs are not retried automatically; **Retry** resumes from the failed step.
- CosyVoice installation and model download are not automated.
- Binaries are not code-signed; Windows SmartScreen may warn.

## Licensing

- Code and docs written for this repository: **MIT** (`LICENSE`).
- Third-party components keep their own licences and are **not** relicensed as MIT — see `THIRD_PARTY_NOTICES.md`. Notably **Remotion** uses the Remotion License (not open source; free for individuals, for-profit companies of up to 3 people and non-profits; others need a Company License; automated rendering has its own terms). Remotion is not included in this repo or the installer — read <https://www.remotion.dev/license> first. Fonts are SIL OFL 1.1. ffmpeg, model weights and Chrome Headless Shell are not bundled. Use voice references recorded by you or with the speaker's explicit consent.
