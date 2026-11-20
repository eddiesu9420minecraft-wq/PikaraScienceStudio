# Pikara Science Studio

English ｜ [繁體中文](README.md)

A Windows desktop workbench that turns a topic into a finished AI science-animation video: research, script, animation code, local voice-over (CosyVoice 3), Whisper pronunciation check, subtitles, GPU rendering, NVENC encoding, automatic quality checks with AI fixes, thumbnails and upload text — in a Traditional-Chinese YouTube version and a Simplified-Chinese Bilibili version.

> **v0.2.1-alpha** — adds content control (autonomous / guided / custom-script modes), output language (zh-TW, zh-CN, both, English), material import, a live job monitor, per-video folders with a Sandbox, and automatic environment repair (see [CHANGELOG](CHANGELOG.md)). **This release was published without full testing** — read `studio/app/TEST_REPORT_v0.2.1.md` and the known limitations below, and review every video yourself before publishing.

## What's inside

| Folder | Contents |
|---|---|
| `studio/` | Desktop app source (Tauri 2 + Rust core + HTML UI), design docs, `integrations/doubao-work/` (Doubao Work skill) |
| `pipeline/` | The video project template: Remotion (React + Three.js) animation, narration data, voice/alignment/mix/render/QA scripts. This is the "project folder" you open in Studio |

## Quick start

1. **Install Studio** — download `Pikara.Science.Studio_0.2.1_x64-setup.exe` (or the portable `PikaraScienceStudio.exe`) from [Releases](../../releases); verify with `SHA256SUMS.txt`. Windows 10/11 x64; the installer fetches Microsoft WebView2 if needed.
2. **Get the template** — `git clone https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio.git`; the template project is `PikaraScienceStudio\pipeline` (must be a git repository — productions run in isolated git worktrees).
3. **First launch** — a short walkthrough opens. **Environment** → **Re-check** and fix what's red; **Projects** → add the `pipeline` folder.
4. **Sign in to an AI provider** (one of): Claude Code (`claude`, default), the official Doubao CLI (`npm install -g @bytedance/doubao-cli`, `doubao login`), or Doubao Work desktop with the Pikara Studio skill (`pikara-studio-skill.zip`, see `studio/docs/DOUBAO_WORK.md`).
5. **Autonomous production** — enter a topic, length, style and platforms → **Start**. You get a Windows notification when it's done; outputs land in the project folder.

Single-step tools (script editor, prompts, voice, render, queue, rollback) are under **Advanced mode** at the bottom of the sidebar.

### Requirements

| Component | Purpose | How |
|---|---|---|
| Node.js 20+ | Remotion rendering, scripts | install manually |
| Python 3.11 | timeline, mixing, QA scripts | install manually |
| ffmpeg with h264_nvenc | encode, mix, probe | install manually (e.g. `winget install Gyan.FFmpeg`) — GPL builds, not bundled |
| NVIDIA GPU + driver | GPU render (ANGLE), NVENC, CosyVoice CUDA | optional; CPU compatibility mode exists |
| CosyVoice 3 (Python 3.10 venv + weights) | local voice-over | manual, see `studio/docs/ENVIRONMENT_SETUP.md`; weights downloaded by you |
| Claude Code CLI or Doubao CLI | research, script, animation code and fixes | signed in with your own account; Studio never asks for or stores API keys or credentials |

## Features (v0.2.0)

- **Autonomous Production Mode** — one click from topic to finished episode. Allocates a new episode number (never overwrites), then in an isolated git worktree runs: research & script → animation code → voice + pronunciation check → timeline → key-frame AI review → zh-TW master → YouTube 1.5× → Bilibili zh-CN → thumbnails → upload text → delivery. A git checkpoint per stage; failed checks go to the AI for a fix and the stage re-runs (attempt and time limits); merged only when everything passed, otherwise the project is untouched and one click discards the worktree. Pause, resume, stop; resumes after a crash or restart.
- **AI providers** — Claude Code subscription mode (default: no USD cap; usage limit → paused with progress saved, never switches to paid API), Claude API mode (per-run USD cap required), the **official Doubao CLI**, and an **external agent** (e.g. Doubao Work desktop + Pikara Studio skill, working through `--cli agent-task` / `agent-done`). Provider logins are isolated from each other.
- **Automatic QA and debugging** — narration validation and length, source count, TypeScript, Whisper pinyin-based pronunciation check, key-frame review, black frames / silence / loudness / subtitle QA; failures and logs are handed to the AI to fix.
- **Bilibili zh-CN** — OpenCC plus a Mainland tech-term table (显存, 内存, 英伟达 …), Mainland voice, Simplified thumbnail and upload text.
- **CLI** — `PikaraScienceStudio.exe --cli auto-start|auto-run|auto-status|agent-task|agent-done|agent-check|job-log|…`.
- Existing: script editor (zh-TW / zh-CN), prompt studio with Claude worktrees, persistent SQLite queue (GPU lock, heartbeats, recovery), live monitor, Environment Doctor, Preview & Publish centre (**no upload code; publishing is always manual**), git rollback.

## Known limitations (v0.2.1-alpha)

- **Most v0.2.1 features have not been tested end to end** (the script stage and requirement checks of content control ran for real; English, Simplified-only rendering, material use on screen, incremental rendering and automatic environment repair are unverified).
- **Alpha release.** Review the video and its sources before publishing.
- **The Doubao CLI provider has not been tested with a real account** (implemented; the connection/capability test needs the account owner to scan the login QR code).
- **The Doubao Work desktop client has not been verified on a real install**; the skill + CLI flow was run end to end in a simulated test (a tester acting as the agent, following the skill step by step).
- **The full tutorial is not finished** (in-app guide page and `studio/docs/DOUBAO_WORK.md` exist).
- "Generic template" episodes only get chapter titles and keyword cards; "AI animation" quality depends on the provider (gated by tsc and key-frame review, may still need manual tweaks).
- Only one Studio process (window or `--cli auto-run`) may run the queue for a data folder.
- No folder picker; CosyVoice install and model download are manual; binaries are not code-signed (SmartScreen may warn).

## Licensing

- Code and docs written for this repository: **MIT** (`LICENSE`).
- Third-party components keep their own licences and are **not** relicensed as MIT — see `THIRD_PARTY_NOTICES.md`. Notably **Remotion** uses the Remotion License (not open source; free for individuals, for-profit companies of up to 3 people and non-profits; others need a Company License; automated rendering has its own terms). Remotion is not included in this repo or the installer — read <https://www.remotion.dev/license> first. Fonts are SIL OFL 1.1. ffmpeg, model weights, Chrome Headless Shell, Claude Code and the Doubao CLI are not bundled. Use voice references recorded by you or with the speaker's explicit consent.
