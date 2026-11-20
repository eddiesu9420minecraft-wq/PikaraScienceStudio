# Third-party notices — Pikara Science Studio

Pikara Science Studio ("Studio") is MIT-licensed (see `LICENSE`). The MIT licence covers only code written for Studio
(Rust core, UI, Skills, docs). This file lists third-party components, whether they are **bundled** in the Studio
executable/installer, and how users obtain the ones that are not. Engineering summary, not legal advice
(see `docs/OPEN_SOURCE_PLAN.md`).

## Bundled (compiled into PikaraScienceStudio.exe)

| Component | Licence | Notes |
|---|---|---|
| Tauri 2 and its runtime crates (tauri, wry, tao, tauri-build …) | Apache-2.0 OR MIT | https://tauri.app |
| rusqlite | MIT | SQLite itself is compiled in via the `bundled` feature |
| SQLite | Public Domain | https://sqlite.org/copyright.html |
| sysinfo | MIT | CPU / RAM / process / disk information |
| serde, serde_json | MIT OR Apache-2.0 | |
| regex, once_cell, uuid, sha2, chrono | MIT OR Apache-2.0 | |
| windows-sys | MIT OR Apache-2.0 | `SetThreadExecutionState`, `AttachConsole` |
| tauri-plugin-notification | Apache-2.0 OR MIT | Windows notification when an autonomous production finishes / needs attention |
| pinyin | MIT | toneless pinyin for the pronunciation check (compares intended text with Whisper output) |
| tokio and other transitive Rust crates | MIT and/or Apache-2.0 (per crate) | full list: `cargo tree` in `app/src-tauri` |

Studio does **not** link libgit2 (git is invoked through the user's `git` CLI) and does not link NVML
(GPU data comes from the user's `nvidia-smi`).

## NOT bundled — used from the user's machine

| Component | Licence | How it is obtained |
|---|---|---|
| **Remotion 4.x** (`remotion`, `@remotion/cli`, `@remotion/three`) | **Remotion License** (source-available, not open source; free for individuals, for-profit orgs with ≤ 3 people and non-profits; others need a Company License — automated rendering counts as "Automator" use). https://remotion.dev/license | Installed into the user's project by `npm install` (the Doctor's `npm_install` fix runs it only when the user clicks it). Never shipped with Studio. |
| Claude Code CLI / 豆包 CLI (`@bytedance/doubao-cli`) | Their vendors' terms (Anthropic / ByteDance) | Optional AI providers installed and signed in by the user; Studio only runs the user's own CLI and never stores credentials. |
| Chrome Headless Shell | BSD-3-Clause (Chromium) + third-party licences | Downloaded by `remotion browser ensure` into the project's `node_modules`. |
| React, Three.js, @react-three/fiber, TypeScript | MIT / Apache-2.0 | Project dependencies installed by npm. |
| Node.js | MIT (+ bundled third-party) | User installs it; Studio only detects it. |
| **ffmpeg / ffprobe** | **GPL-3.0** for the gyan.dev "full" builds (LGPL for other builds; `--enable-nonfree` builds are not redistributable) | User installs it (e.g. `winget install Gyan.FFmpeg`). Studio never bundles ffmpeg; it calls the `ffmpeg`/`ffprobe` on PATH. The Doctor warns if the build contains `--enable-nonfree`. |
| NVIDIA driver, `nvidia-smi`, NVENC, CUDA runtime | NVIDIA EULA | Part of the user's driver install. Studio never installs or updates drivers. |
| Python 3.10 / 3.11 | PSF License | User installs it. |
| CosyVoice (code) and Matcha-TTS | Apache-2.0 / MIT | Cloned by the user into `tools/CosyVoice`. |
| **Fun-CosyVoice3-0.5B model weights** | Apache-2.0 | **Downloaded by the user** (≈ 9 GB, Hugging Face / ModelScope). Not redistributed by Studio. |
| faster-whisper and **Whisper large-v3-turbo weights** | MIT | **Downloaded by the user** / by the pipeline script on first use (≈ 1.6 GB). |
| PyTorch (cu121 wheels) | BSD-3-Clause (+ NVIDIA CUDA EULA for the CUDA libraries) | pip, in the user's CosyVoice venv. |
| OpenCC | Apache-2.0 | pip. |
| edge-tts | LGPL-3.0; talks to an unofficial Microsoft endpoint | Optional, disabled by default in the pipeline. |
| Noto Sans TC / SC | SIL OFL 1.1 | Provided by the video project, not by Studio. |
| Claude Code CLI | Anthropic terms | User installs and logs in; Studio only invokes `claude -p`. AI features are labelled "AI assistant (Powered by Claude)". |
| Reference voices | Must be the user's own voice or used with written consent | Not provided by Studio. |

## Publishing

Studio contains no upload code. Publishing to YouTube / Bilibili is always done manually by the user.
