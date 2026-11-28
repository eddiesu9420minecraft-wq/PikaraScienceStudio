# Pikara Science Studio on Linux (command line)

On Linux, Studio is a command-line tool only: no GUI, and it doesn't use a WebView, X11, Wayland or a desktop environment. It works in a plain terminal, over SSH and on headless servers. The engine is the same as the Windows and macOS apps (`crates/studio-core`); only the window is missing.

| | Status |
|---|---|
| x86_64 | Main target. Every CI run builds and tests it, and the headless video test runs on it (`linux-headless-e2e.yml`) |
| arm64 (aarch64) | Every CI run builds it and runs the unit tests and CLI tests on it (GitHub `ubuntu-24.04-arm`). The full video pipeline hasn't been run on it |

## Installing

1. Download `PikaraScienceStudio_<version>_linux-x86_64.tar.gz` (or `linux-aarch64`) and check it against `SHA256SUMS`.
2. `tar -xzf PikaraScienceStudio_*_linux-*.tar.gz`. The launcher is `PikaraScienceStudio/PikaraScienceStudio`.
3. Tools needed to make videos: `git`, `ffmpeg` (with `ffprobe`), Node.js 22, and Python 3.10 or 3.11 (for CosyVoice).
   - Ubuntu / Debian: `sudo apt install git ffmpeg python3.10-venv`, then Node.js 22 from nodesource or nvm.
   - Headless Chromium (Remotion's `chrome-headless-shell`) is downloaded on first render. On a minimal server it needs these libraries: `sudo apt install libnss3 libatk-bridge2.0-0 libgbm1 libxkbcommon0 libasound2t64` (or `libasound2` on older releases). These are rendering libraries, not a display server, so no X11 or Wayland session is started.
4. Check the setup: `./PikaraScienceStudio doctor`.

CYW (Create Your World) installs it the same way: `cyw /run PikaraScienceStudio` starts the CLI directly on Linux.

## First video

```
./PikaraScienceStudio project new --dest ~/videos/pikara --title "Pikara Science"
cd ~/videos/pikara && npm ci && cd -
./install-cosyvoice.sh ~/videos/pikara                    # CosyVoice 3 (CPU, or CUDA when an NVIDIA GPU is present)
./PikaraScienceStudio create --project ~/videos/pikara --topic "為什麼天空是藍色的" --minutes 3 --wait
```

`--wait` runs the work in this process and prints progress until the video is done (exit code 0) or fails (7). On a server you can instead keep a worker running and control it from other shells:

```
nohup ./PikaraScienceStudio run --stay > studio.log 2>&1 &
./PikaraScienceStudio status <id> --follow
```

### systemd user service

```ini
# ~/.config/systemd/user/pikara-studio.service
[Unit]
Description=Pikara Science Studio worker

[Service]
ExecStart=%h/PikaraScienceStudio/PikaraScienceStudio run --stay
Restart=on-failure
KillSignal=SIGINT

[Install]
WantedBy=default.target
```

`systemctl --user enable --now pikara-studio`. With `KillSignal=SIGINT`, a stop or restart leaves jobs resumable: voice and render skip the lines and chunks that are already done.

## GPUs and acceleration (detected and measured, never assumed)

| Part | NVIDIA | AMD | Intel | No GPU |
|---|---|---|---|---|
| Detection | sysfs + `nvidia-smi` | sysfs (+ ROCm runtime presence) | sysfs | `hardware` reports no adapter; CPU paths are used |
| Voice (CosyVoice 3) | CUDA (`install-cosyvoice.sh` picks cu121) | **CPU**. ROCm hasn't been tested with CosyVoice, so Studio doesn't use it | CPU | CPU fp32: same model, slower |
| ASR check (faster-whisper) | CUDA float16 → int8 | CPU int8 | CPU int8 | CPU int8 |
| Video encode | NVENC, after a real test encode | VA-API, after a real test encode | VA-API, after a real test encode | libx264 |
| Remotion / Three.js | headless Chromium ANGLE-EGL, used only if `gpu-check.mjs` renders a real frame | same | same | SwiftShader (CPU) |

`PikaraScienceStudio hardware` prints what was found and what each role (render, AI, encoder) will use, with the reason. The VA-API test uses `/dev/dri/renderD128`. On a machine with several GPUs, where that node may not be the VA-API-capable one, the real test encode fails and libx264 is used instead (see KNOWN_ISSUES).

## Data and settings

- Database and queue: `$XDG_DATA_HOME/PikaraScienceStudio` (default `~/.local/share/PikaraScienceStudio`). `config path` shows it, and `--data <dir>` uses a different folder.
- Caches (measured probes): `$XDG_CACHE_HOME/PikaraScienceStudio`.
- Only one worker can run per data folder. A second `run` exits with code 5.
