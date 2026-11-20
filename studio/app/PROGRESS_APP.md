# Pikara Science Studio — backend / app progress

Owner of this log: Rust core (`src-tauri/`) + project skeleton. UI progress: `PROGRESS_UI.md`. API contract: `API.md` (v1.2 — multi-episode, additive).

## v0.1.1 — multi-episode (2026-11-20)
- `episodes.rs` (list / create skeleton, validated + committed), `scaffold.rs` (new project from a pipeline template, Chinese/space paths, CosyVoice junction, git init), `cli.rs` (`--cli`), `jobs::preflight` (friendly zh-TW failures before spawning), `episode` param on every job kind + `final_tw` pipeline.
- Real test run (EP02/EP03 voice → timeline → mix → render → QA through the queue, new project, corrupt/truncated/missing video, ffprobe hidden, kill/recover): `TEST_REPORT_v0.1.1.md`.

## What works (all against the real machine and <PROJECT_DIR> — no mock data)

| Feature | Module | How it was tested |
|---|---|---|
| SQLite (WAL, `user_version` migrations) at `%APPDATA%\PikaraScienceStudio\studio.db` | `db.rs` | unit tests (migrate once, reopen, roundtrip, settings merge), selftest `db.roundtrip` |
| Projects: register/open, episodes from narration.json, outputs (*.mp4/*.srt/*.png), git status | `project.rs`, `gitops.rs` | selftest `project.register` on <PROJECT_DIR> (ep01 = 7 scenes / 75 lines) |
| Narration read / validate (same `norm()` + anchor rules as build_timeline.py) / atomic save + `git commit -- <file>` "Studio: edit narration"; zh-TW and zh-CN | `narration.rs` | real files validate with 0 errors and **round-trip byte-exact (CRLF preserved)**; temp-repo test: bad anchor refused, external-edit (sha) refused, save commits only that file |
| Prompt generator (6 task templates + live project data, QA report, job log) | `prompt.rs` | unit test on real project ("7 幕、75 句"), selftest `prompt.build` |
| Claude Code: detect (`where claude`, fallbacks), project Skill `.claude/skills/pikara-video/SKILL.md`, `claude -p` (stdin prompt, `--output-format stream-json --verbose --permission-mode dontAsk --allowedTools … --max-turns`) in a new worktree `.studio/worktrees/<id>` on branch `studio/claude/<id>`, worktree changes committed on that branch, diff / merge (`--no-ff`, user-triggered) / discard | `claude.rs`, `jobs.rs` | temp-repo worktree lifecycle test (diff, merge, discard, `.studio/` excluded via `.git/info/exclude`); stream-json parser test; real headless run: selftest `--claude-job` (see below) |
| Environment doctor (17 checks) + fixes | `doctor.rs` | real run on this PC (output below). Auto fixes: `create_folders` (tested), `npm_install`, `remotion_browser_ensure`, `pip_install:<small pkg>` (queued jobs). LongPaths / driver / Python / ffmpeg / claude → instructions only |
| Job queue: voiceover_tw, voiceover_cn, timeline, mix, render, qa, make_cn, youtube_15x, bilibili (7 steps), custom, claude, doctor_fix; GPU lock (1 GPU job) + external GPU detection (process list: chrome-headless-shell / generate_voiceover_cosy / render.mjs …, excluding Studio's own process tree, + nvidia-smi VRAM threshold); parallel CPU jobs; stdout/stderr → job_events + `logs/<job>.log`; progress parsing (render `區段 a–z`, `Rendered n/m`, voiceover `✓`/`≡`); cancel = `taskkill /T /F` | `queue.rs`, `jobs.rs`, `gpu.rs` | unit tests: real process exit codes + output, GPU lock with simulated external busy, one-GPU-job-at-a-time, cancel kills cmd + ping child (verified gone from process list), command mapping incl. injection guards; **real GPU render through the queue** (selftest `--gpu-job`: ArtTest frames 0–59 → 1920×1080 60 fps h264+aac, progress 0 → 0.9 → 1.0) |
| Heartbeat (5 s) + recovery: stale `running` → `interrupted` → auto re-queued keeping the step index (multi-step jobs resume at the failed step), orphan process tree killed | `queue.rs` | unit test + selftest `queue.recovery` |
| Unattended scheduler: queue enable flag, GPU time window (wraps midnight), `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` while any job runs | `queue.rs` | window unit test; keep-awake flag visible in `queue_status` |
| Monitoring every 2 s (`monitor://sample`): CPU %, RAM, GPU util, VRAM, temp, power, SM clock, NVENC util, HW/SW thermal slowdown; metrics stored every 10 s (7 days) | `monitor.rs`, `gpu.rs` | real nvidia-smi output saved as fixture `tests/fixtures/nvidia_smi_query.csv` (parsing tests), selftest `monitor.sample` |
| Auto-fix & rollback: `job_analyse_with_claude` (log tail + QA report → claude job), `git_log`, `git_revert`, `git_branch_from`, `git_reset_hard` (requires typed `RESET <hash7>` + backup branch) | `lib.rs`, `gitops.rs` | temp-repo revert test, reset confirmation test |
| Preview & publish: outputs with ffprobe (duration/res/fps/codecs/bitrate), PUBLISH_METADATA.md sections, open/reveal in Explorer (project-scoped), asset protocol scope for `<video>`. **No upload code.** | `project.rs` | selftest `outputs.ffprobe` (asserts duration > 0), md section test |
| `--selftest [--project D:\…] [--out f.json] [--gpu-job] [--claude-job]` | `selftest.rs` | runs in an isolated temp data dir, prints JSON, exit code 0/1 |

## Test output excerpts (2026-11-20)

`cargo test` → `test result: ok. 31 passed; 0 failed`

Doctor on this PC:
```
os.version       ok      Windows 11（build 26200）
os.longpaths     warn    LongPathsEnabled=0（chrome-headless-shell 路徑 125 字元，目前不受影響）
webview2         ok      WebView2 157.0.4341.60
gpu.driver       ok      NVIDIA GeForce RTX 4050 Laptop GPU，驅動 621.01，VRAM 6141 MiB
node             ok      Node v26.13.1（C:\Program Files\nodejs\node.exe），npm 11.20.0
npm.deps         ok      remotion 4.0.545（與 package-lock 一致）
browser.chs      ok      …\chrome-headless-shell.exe（125 字元）
ffmpeg.present   ok      ffmpeg version 9.0.2-full_build-www.gyan.dev …
ffmpeg.nvenc     ok      已列出 h264_nvenc（未執行實測編碼；勾選「GPU 實測」可測試）
py311            warn    Python 3.11.9，缺少套件：numpy（make_cn.py 需要 opencc；numpy 為選用）
cosy.venv        ok      Python 3.10.22；torch、torchaudio、faster_whisper、onnxruntime 等套件齊全（未初始化 CUDA）
cosy.model       ok      …\Fun-CosyVoice3-0.5B（8.8 GB）
whisper.model    ok      model.bin 1.62 GB
disk.free        ok      D:\ 可用 753 GB／共 2000 GB
git              ok      git version 2.56.0.windows.1；分支 master
claude           ok      2.1.325 (Claude Code)
project.folders  warn    缺少：.studio\worktrees
```

Selftest with real GPU job (`--selftest --gpu-job`): `14 / 14` passed. GPU job log:
```
▶ 步驟 1/1：渲染　$ C:\Program Files\nodejs\node.exe scripts/render.mjs gpu --comp ArtTest --out STUDIO_GPU_SELFTEST.mp4 --frames 0-59
GPU：ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU …, D3D11)
區段 0–59：6s，10.4 fps，並行 4，GPU 平均 36%，VRAM 峰值 1803 MiB，最高 41.88°C
完成：STUDIO_GPU_SELFTEST.mp4（2.7 MB）   → ffprobe 1920×1080, 60 fps, h264/aac, 1.0 s  (file deleted after the test)
```
outputs.ffprobe: EP01_Bilibili_zh-CN.mp4 618.07 s 1080p30 h264/aac; EP01_YouTube_zh-TW.mp4 558.29 s 1080p30.

## Fixed during integration
- ffprobe/ffmpeg returned `program not found` from `std::process::Command` even though `where.exe` finds the WinGet build → `util::tool()` resolves absolute paths (where.exe → WinGet Links → WinGet Packages) and the resolved ffmpeg dir is prepended to PATH for pipeline jobs (render.mjs spawns `ffmpeg` by name).
- `編碼期間 NVENC…` summary line was parsed as "encoding" progress text; now only `開始編碼` / `編碼中`.

- Worktrees: diff/merge resolve the branch, or the worktree HEAD if the branch is gone; orphans (no branch, no worktree) are flagged `orphan: true` and discard removes leftover folders (unit-tested).
- zh-CN labels for job kinds / doctor checks (`labelCn`, API v1.1, additive).
- Single-instance: a second launch used to panic on the locked WebView2 profile (`0x8007139F`); now `tauri-plugin-single-instance` focuses the running window (verified: second launch exits 0 while the first keeps running).

## Real headless Claude run (`--selftest --claude-job`, release exe)
worktree `.studio\worktrees\st71ea76` on `studio/claude/st71ea76` → `claude -p --output-format stream-json --verbose --permission-mode dontAsk --allowedTools "Read,Glob,Grep,Bash(git diff *),Bash(git status *),Bash(git log *)" --max-turns 4`.
Claude tried PowerShell → **denied by dontAsk** (tool restriction works), then used Read and answered "Sequence ep01 has 7 scenes … no files were edited." (3 turns, $0.27). Commit step: nothing to commit; worktree + branch discarded afterwards.

## Packaging
`npm run tauri build` → NSIS download worked. Outputs:
- `src-tauri/target/release/PikaraScienceStudio.exe` (≈15 MB) → copied to `studio/dist/PikaraScienceStudio.exe`
- `src-tauri/target/release/bundle/nsis/Pikara Science Studio_0.1.0_x64-setup.exe` (≈3.6 MB, currentUser) → copied to `studio/dist/`
Release GUI launched (WebView2 child processes up, studio.db created in `%APPDATA%\PikaraScienceStudio`), then closed.

## Known gaps
- Job Object based process control not implemented (taskkill /T /F is used, as the plan allows for v0.1).
- No retry/backoff for failed jobs (manual `job_retry`); interrupted jobs are auto re-queued up to 5 times.
- Doctor `npm.deps` uses node_modules vs package-lock version only (no `npm ls`).
- Remotion licence acknowledgement dialog is not implemented in the backend (UI shows text; `npm_install` runs only on click).
