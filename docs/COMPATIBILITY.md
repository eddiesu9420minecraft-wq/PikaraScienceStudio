# Cross-platform compatibility report (feat/cross-platform)

> Updated 2026-11-28. Branch `feat/cross-platform`, based on main v0.3.4. **Not merged to main and not released** (the user's instruction: wait for their confirmation of the test results).
>
> CI status: commit 1f90035 (latest; ca79667 before it) passed all 13 `cross-platform.yml` jobs (engine + CLI on Windows x64 / macOS arm64 / macOS x64 / Linux x64 / Linux arm64; GUI + CLI on Windows / macOS arm64 / macOS x64; media probes on macOS × 2 and Linux × 2; security). `linux-headless-e2e.yml` passed.
>
> Four categories, never mixed:
> - **Real hardware**: run on a physical machine: this Windows PC, and the Mac mini M2 (from 2026-11-28 15:30, over SSH; everything under `/Volumes/agars data/pikara-test` on the external drive).
> - **CI**: run on GitHub Actions VMs. They have no display, no NVIDIA GPU, and no MPS on macOS. **This is not a real-hardware result.**
> - **Compile only**: builds, but no test ran it.
> - **Not supported / not done**: no implementation yet, or not tested, so not offered.

## 1. Platform overview

| Target | Build | Unit + CLI integration tests | GUI | Packaging | Full production (script → MP4) |
|---|---|---|---|---|---|
| Windows x64 | Real hardware + CI | Real hardware (137 + 4) + CI | Real hardware (build, `check-ui --exe`, CLI mode); this branch hasn't run a full GUI production | NSIS + portable exe (unchanged) | Earlier releases were tested on real hardware; **not re-run on this branch** |
| macOS ARM64 | **Real hardware (M2)** + CI | **Real hardware: all 145 pass** (case-sensitive APFS) + CI | CI: `.app`, frontend fingerprint, CLI mode. The window hasn't been opened on the real machine | CI: `.dmg`, `.app.tar.gz` (**not signed, not notarized**) | **Real hardware: passed (CLI, CPU voice, Metal render)** |
| macOS x64 | CI | CI | CI (same as above) | CI (same as above) | **Not done** |
| Linux x86_64 | CI | CI | Not offered (CLI by design) | CI: `.tar.gz` (unpacking and creating a project tested) | CI: see §4 |
| Linux ARM64 | CI (`ubuntu-24.04-arm`) | CI | Not offered | CI: `.tar.gz` | **Not done** (media probes only) |

## 2. Architecture and CLI

| Item | Status | How it was verified |
|---|---|---|
| Engine shared by GUI and CLI (`crates/studio-core`) | Done | The GUI exe and `pikara-studio` run the same database, queue and autopilot code. The real DB copy reports the same 11 steps as the GUI |
| Linux build pulls in no Tauri, WebKitGTK, GTK, X11 or Wayland | Done | CI: `cargo tree` + `ldd` (links only libc, libm, libgcc_s) |
| Runs with no display | Done | CI: `env -u DISPLAY -u WAYLAND_DISPLAY` |
| `--help --version doctor create status list pause resume cancel retry logs render revoice config run agent project hardware` | Done | Real hardware (Windows) + CI: integration tests run the real binary |
| JSON / NDJSON output, fixed exit codes (0/1/2/3/4/5/6/7/10/130) | Done | Integration tests check 0, 1, 2 and 3; CI smoke test checks 2 and 3 |
| Resume after an interruption (`run`, Ctrl-C/SIGINT → 130, restart continues) | Done | CI E2E (§4); not tested on real hardware |
| Re-voice / re-render alone | Done (enqueues the same jobs the episode editor uses) | Command and parameters are unit-tested; no full revoice / rerender run on any platform |
| AI agent automation (`--agent external`, `agent task/done`) | Done | CI E2E uses this path |
| `nogui` on Windows / macOS GUI exe | Done | Real hardware (Windows) + CI (macOS) |
| Old `--cli` commands | Unchanged | Real hardware: `check-ui --exe` calls `--cli build-info` |

## 3. Voice, recognition, rendering and encoding (detected and measured, never assumed)

| Component | Windows x64 | macOS ARM64 | macOS x64 | Linux x86_64 | Linux ARM64 |
|---|---|---|---|---|---|
| GPU detection | Real hardware (DXGI / D3D12 / CUDA) | CI (sysctl + system_profiler; VM shows no GPU) | CI | CI (sysfs + nvidia-smi; the VM has no GPU). Unit tests use a fake sysfs tree | CI |
| CosyVoice 3 | Real hardware, CUDA (earlier releases) | **Not done** (plan: CPU fp32 / MPS A/B, MACOS.md §3) | **Not done** | CI, CPU fp32 (§4) | **Not done** |
| PyTorch MPS / MLX | — | CI: MLX Metal works (809 GFLOPS); MPS unavailable in the VM. Voice uses CPU until a real-hardware A/B | — | — | — |
| CUDA / NVENC | Real hardware | — | — | **Not tested** (no NVIDIA GPU available) | — |
| AMD AMF / ROCm | AMF: code exists, never tested on AMD hardware | — | — | ROCm: presence detected only; voice always uses CPU (**not supported**) | — |
| VA-API | — | — | — | CI: the VM has no `/dev/dri`, so the test encode correctly fails and falls back to libx264. Multi-GPU node selection not tested | CI (same) |
| VideoToolbox | — | CI: h264/hevc real encodes pass | CI: the VM can't use it; falls back to libx264 correctly | — | — |
| faster-whisper | Real hardware (CUDA → CPU) | **Not done** | **Not done** | CI, CPU int8 (§4) | **Not done** |
| FFmpeg | Real hardware | CI | CI | CI | CI |
| Remotion / Three.js | Real hardware (ANGLE D3D11) | CI: 90 real frames rendered | CI: WebGL not available in the VM, falls back to SwiftShader | CI: headless Chromium, SwiftShader (no GPU) | CI |
| Node.js / Python | Real hardware | CI | CI | CI | CI |
| Traditional / Simplified Chinese voice quality | Real hardware (existing quality) | **Not verified** | **Not verified** | CI checks recognition error rate only, with a test voice (not the narrator); no listening test | — |

## 4. Linux headless end-to-end (CI)

`.github/workflows/linux-headless-e2e.yml` runs on GitHub `ubuntu-24.04`: 4 vCPU, no GPU, no display, CPU voice. The test voice is CosyVoice's own Apache-2.0 sample prompt, not the narrator.

**Result: complete video produced.** First full run: 46119361218 (2753764). Rerun with the test's own report step fixed: **46120511788 (ca79667) passed**: 503 s total, peak 8,351 MiB, `resume: {finishedBeforeInterrupt: 2, revoicedAfterRestart: 0}`; MP4 1920×1080 30 fps H.264 + AAC, 28.1 s. The CLI was the only interface; no window, DISPLAY, X11 or Wayland was involved.

| Stage | Result (CI VM) |
|---|---|
| Project | `project new` from the template, `npm ci` |
| Script | Custom script imported verbatim (2 chapters, 5 lines). The "external agent" step went through `agent task` / `agent done` |
| Voice | CosyVoice 3, CPU fp32 (no CUDA, so it fell back automatically). 5 lines; the worker was **interrupted with SIGINT at line 2/5** (exit 130). After restart it reported "5 lines in total, 3 to generate": **the 2 finished lines were not voiced again** |
| Recognition check | faster-whisper large-v3-turbo, CPU int8, aligned all 5 lines. Pronunciation check passed |
| Subtitles / timeline | 9 subtitle segments, total 28.10 s |
| Mix | −16.1 LUFS, peak −1.5 dBFS; narration vs. background music 21.1 dB apart |
| Render | Headless Chromium + SwiftShader (no GPU, correctly decided by Studio). 1,686 frames, libx264 |
| QA | Automatic QA found 0 issues |
| Output | `EP02_Final.mp4`: 1920×1080, 30 fps, H.264 + AAC, 28.1 s; `EP02.srt`. Sampled frames show correct titles, chapters and Traditional Chinese subtitles |
| Time | About 7 minutes in total (voice 4.6 min including the interruption; render + QA 1.7 min) |
| Memory | Peak total RSS (all processes) 7.7 GiB |

Problems this test found and fixed (all of them affect real servers too):
1. A boot framebuffer (`simple-framebuffer`) was treated as a GPU, so the render step tried the GPU path and failed.
2. On a server without a desktop session, keep-awake was denied and retried endlessly, filling stderr.
3. On CPU rendering, the first frame could exceed Remotion's 30 s per-frame limit (seen on the Intel Mac VM); CPU rendering now allows 180 s.
4. `doctor` ran Windows checks on Linux and macOS.

Limits: this is a VM result. Voice quality is only checked by the recognition error rate (with a test voice, no listening test), and no GPU path (CUDA, NVENC, VA-API, ROCm) was exercised.


## 4b. Mac mini M2 real hardware (2026-11-28)

macOS 27.0.1, M2 (4P + 4E, 10-core GPU, Metal 4), 16 GB. User-level install only (rustup, micromamba conda-forge: Python 3.10.22, Node 22, FFmpeg 9.1); no sudo, no Homebrew.

| Item | Result |
|---|---|
| Hardware detection | Real `sysctl` and `system_profiler` output parses correctly: Apple Silicon, no Rosetta, 4P/4E, unified memory treated as 16 GiB (not as VRAM), Metal 4. Now a unit-test fixture |
| Unit + CLI integration tests | 135 + 6 + 4 all pass; the repo sits on a case-sensitive APFS external drive |
| `doctor` | Passes |
| VideoToolbox | `h264_videotoolbox` real test encode works (347 ms) |
| WebGL / Three.js | Chromium ANGLE → **Metal** (`ANGLE Metal Renderer: Apple M2`), hardware acceleration |
| Rendering (1080p30) | 90 frames 10.1 fps; 300 frames **14.2 fps** (2–3 tabs, half the user's memory in use); VideoToolbox encodes 300 frames in 2 s |
| PyTorch / MLX | CPU 496 GFLOPS; **MPS 864 GFLOPS** (works on real hardware, unlike the CI VM); **MLX 1308 GFLOPS** |
| Full production (CLI only, eco mode, while the user was using the Mac) | **Passed**: script → external agent → **CosyVoice 3 (CPU fp32, 4 threads)** → Whisper alignment → subtitles → mix → **render on Metal + VideoToolbox** (843 frames) → QA 0 issues → MP4 1920×1080 30 fps H.264, 28.1 s. **Interrupted during voice and resumed**: after the restart it generated only 3 of 5 lines. 472 s total (voice 6 min), peak 6.4 GiB |

Problems this test found and fixed:
1. `gpu-check` could misjudge "no GPU". `remotion still` doesn't forward the console, and a hand-launched browser crashes on the Mac. Now the probe page POSTs its result to a one-shot listener on 127.0.0.1, which read the Metal renderer correctly on the real machine.
2. render.mjs read macOS's "completely free pages" (66 MiB) and would always have limited rendering concurrency. It now uses vm_stat's available memory (2.4 GiB on the real machine).
3. CosyVoice on macOS 27: pip's scipy wheel can't be loaded by dyld (`__thread_bss`), so it now comes from conda-forge. That brought in conda's OpenBLAS/OpenMP, which together with the pip torch's own libomp crashed the model load (SIGSEGV, exit 139). The CosyVoice environment now uses conda-forge's Accelerate BLAS (libblas=*accelerate), and only one OpenMP runtime is loaded.
4. A path with a space ("agars data", and on macOS "Application Support") breaks C-extension builds (pyworld), so pyworld now comes prebuilt from conda-forge.
5. A limit found but not fixed: started from inside a live SSH session, Chromium's GPU process fails to start; detached with `nohup … &` it worked 6 out of 6 times. On a Mac, use the window or a detached `run` (KNOWN_ISSUES #21).

## 5. Not supported / not done

- Linux GUI: by design, not provided.
- macOS: code signing and notarization (needs an Apple Developer account, which is paid). Studio auto-update on macOS and Linux (P9).
- Pikara minisign signatures for Studio releases: the key isn't in the Studio repo; adding it needs the user's OK. CYW verifies SHA-256, the GitHub digest and SHA256SUMS for now.
- Voice on ROCm, voice on MPS or MLX (needs real-hardware A/B first), CUDA on Linux (no hardware).
- Any full production on the Mac mini, a physical Linux machine or Linux ARM64.
- See KNOWN_ISSUES.md for the details.

## 6. Data compatibility

- The database schema is unchanged (v3). SQLite moved from libsqlite3-sys 0.30 to 0.40, the version that fixes RUSTSEC-2026-0459. A **copy** of the real database opened normally (9 productions; status identical to the GUI), and the real database was byte-identical afterwards.
- Every test uses its own data folder (`--data` / `PIKARA_STUDIO_DATA`). The user's running Studio and real database were not touched.
