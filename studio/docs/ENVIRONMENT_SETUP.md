# 環境設定與 Environment Doctor

Doctor 的每項檢查都有固定的 `id`，結果寫入 `env_checks`。修復分為三級：

- **A 自動**：只影響 Studio 自己的目錄（`%LOCALAPPDATA%\PikaraStudio`、專案的 `node_modules`），而且可以還原。直接執行，事後顯示結果。
- **B 需要同意**：會下載大型檔案、安裝使用者層級的軟體，或寫入專案。必須顯示「檔名／來源／大小／授權」，經使用者按下同意後才執行。
- **C 使用者手動**：需要系統管理員權限、會修改系統設定，或涉及驅動。Studio 只提供說明與指令，**不代為執行**。

## 1. 檢查表

| id | 偵測方式（實際指令） | 通過條件 | 修復 | 級別 |
|---|---|---|---|---|
| `os.version` | `cmd /c ver`；Rust 端用 `RtlGetVersion` | Windows 10 1803（build 17134）以上；建議 Windows 11 | 無 | C |
| `os.longpaths` | `reg query HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled` | 不強制要求，只用來決定是否走短路徑 | 預設改用短路徑（見 `browser.shortpath`）。可提示使用者以系統管理員身分執行 `reg add ... /v LongPathsEnabled /t REG_DWORD /d 1 /f`，但 **Studio 不代為執行** | A／C |
| `webview2` | `reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`；沒有結果時再查 `HKCU\Software\Microsoft\EdgeUpdate\Clients\{同 GUID}` | pv 存在且不等於 `0.0.0.0` | 由 NSIS 安裝程式處理（`webviewInstallMode: downloadBootstrapper`） | 安裝時 B |
| `gpu.driver` | `nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader`；Rust 端用 NVML | 有 NVIDIA GPU、VRAM 至少 6GB、驅動支援 CUDA 12.1（torch cu121 需要 R530 以上） | 開啟 NVIDIA 驅動下載頁。**不自動安裝驅動** | C |
| `gpu.webgl` | `node scripts/gpu-check.mjs` → `out/gpu-check.json` 的 `webgl_angle.backend` | `NVIDIA hardware` | 結果是 Radeon／內顯時：說明如何在「設定 > 系統 > 顯示器 > 圖形」把 `chrome-headless-shell.exe` 設為高效能 | C |
| `gpu.free` | NVML 的可用 VRAM | 渲染前至少 1.5GB；CosyVoice 至少 3GB | 列出佔用 VRAM 的程序（NVML `running_compute_processes`），由使用者決定是否關閉 | C |
| `node` | `where node` 和 `node -v` | v20 以上（本機實測 v26 可用） | 沒有 Node 時：下載官方 Node LTS zip（MIT）到 `runtime/node`，**不寫入系統 PATH** | B |
| `npm.deps` | 專案 `node_modules/remotion/package.json` 的 version 與 lockfile 是否一致；`npm ls remotion --depth=0` | 一致 | 執行 `npm ci`（**先顯示 Remotion 授權提示並取得確認**，見 OPEN_SOURCE_PLAN §3） | B |
| `browser.chs` | 檢查 `node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe` 是否存在，以及 `VERSION` 檔 | 存在，且版本與 Remotion 鎖定的版本相符 | `node node_modules/@remotion/cli/remotion-cli.js browser ensure`（約 100MB+，來源 storage.googleapis.com／remotion.media） | B |
| `browser.shortpath` | 計算 exe 的完整路徑長度 | 小於 240 字元，或 `LongPathsEnabled=1` | 複製到 `%LOCALAPPDATA%\PikaraStudio\chrome-headless-shell\`，並以 `--browser-executable` 傳入（沿用 lib.mjs 的邏輯） | A |
| `ffmpeg.present` | 依序找設定值、`runtime/ffmpeg`、`where ffmpeg` | 找得到 | 提供兩個選項：①偵測到 winget 時提示 `winget install Gyan.FFmpeg`（GPLv3）②下載 BtbN 的 zip 到 `runtime/ffmpeg` | B |
| `ffmpeg.nvenc` | `ffmpeg -hide_banner -encoders` 是否列出 `h264_nvenc`；再實測 `ffmpeg -f lavfi -i testsrc2=s=1920x1080:r=60 -t 2 -c:v h264_nvenc -f null -` | 列出且實測成功 | 沒有列出：換成含 NVENC 的版本（B）。實測失敗：檢查驅動，或改用 CPU 模式 libx264 | B／C |
| `ffmpeg.licence` | 解析 `ffmpeg -version` 的 configuration | 含 `--enable-nonfree` 時發出警告（不得散布，但個人使用沒問題） | 顯示提示 | — |
| `py311` | `py -3.11 -c "import sys;print(sys.version)"` | 3.11.x | 沒有時：用 `uv python install 3.11` 安裝到使用者目錄；沒有 uv 時提示 `winget install Python.Python.3.11` | B |
| `py311.venv` | `venvs/py311/Scripts/python -c "import edge_tts, opencc, numpy"` | 匯入成功 | `uv venv -p 3.11 venvs/py311`，接著 `uv pip install -r studio/workers/requirements.txt`（鎖定版本） | A（小型）／B |
| `py310` | `py -0p` 或 `uv python find 3.10` | 3.10.x | `uv python install 3.10` | B |
| `cosy.repo` | `tools/CosyVoice/cosyvoice/__init__.py` 是否存在，以及 `git -C tools/CosyVoice rev-parse HEAD` | 存在（本機為 commit `074ca6d`） | `git clone --recursive https://github.com/FunAudioLLM/CosyVoice` 並 checkout 鎖定的 commit | B |
| `cosy.venv` | `.venv\Scripts\python -c "import torch;print(torch.__version__, torch.cuda.is_available())"`（**會初始化 CUDA，只在沒有 GPU 租約時執行**） | `2.3.1+cu121 True` | `uv venv -p 3.10`，接著 `uv pip install -r requirements.txt`（使用 cu121 index）。約 5.7GB | B |
| `cosy.model` | `pretrained_models/Fun-CosyVoice3-0.5B/` 是否有必要檔案，並與鎖定的 sha256 清單比對 | 完整 | 執行 `snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', ...)`。約 9.1GB，Apache-2.0 | B |
| `whisper.model` | `pretrained_models/whisper/large-v3-turbo/model.bin` | 存在 | 從 HF `mobiuslabsgmbh/faster-whisper-large-v3-turbo` 下載。約 1.6GB，MIT | B |
| `voice.ref` | `reference/reference.wav`＋`.txt`＋`reference.source.json` | 存在，並記錄同意類型 | 引導使用者錄製自己的聲音（10–20 秒），並勾選同意聲明 | B |
| `disk.free` | Rust 端用 `GetDiskFreeSpaceExW`，檢查工作區與 `%LOCALAPPDATA%` 所在磁碟 | 安裝前：至少 25GB（venv 6 + 模型 11 + node_modules 1 + 餘裕）。渲染前：至少「幀數 × 0.35MB」（1080p JPEG q95 的估計值，25k 幀約 9GB）再加 5GB | 列出可以清理的 `out/frames/*`，由使用者勾選刪除（移到資源回收筒） | B |
| `git` | `git --version`，以及專案中的 `git rev-parse --is-inside-work-tree` | git 2.30 以上；專案是 git repo | 不是 repo 時：詢問後執行 `git init` 並做第一次 commit | B |
| `claude` | `where claude` 和 `claude --version`；設定中是否有 API key | 選用。沒有時停用 AI 修復 | 只提供安裝說明連結，**不代為登入** | C |
| `net.edge` | 只在使用者啟用 Edge 引擎時執行 `generate_voiceover.py --test` | 成功 | 重試；仍失敗時建議改用本機語音 | — |

## 2. 「自動修復」的界線

- 永遠不做：安裝或更新驅動、修改登錄檔中的系統設定（LongPaths、GPU 偏好）、修改電源計畫或 GPU 時脈、以系統管理員權限執行任何東西、刪除使用者檔案（清理一律移到資源回收筒）、登入第三方帳號。
- 偵測時不使用 GPU 的檢查：除 `gpu.webgl`、`cosy.venv`、`ffmpeg.nvenc` 實測以外都不使用。這三項標記為 `needs_gpu`，只在 scheduler 沒有發出 GPU 租約時執行，否則顯示「略過（GPU 使用中）」。
- 每次修復前，記錄修改前狀態到 `env_checks.detail_json`，修復後重新檢查。

## 3. 本機實測（2026-11-19，只執行 read-only 指令，不使用 GPU）

| 項目 | 結果 |
|---|---|
| OS | Windows 11 Home，`10.0.26200.9974` |
| Rust | **已安裝**：`rustc 1.99.1`、`cargo 1.99.1`、`rustup 1.29.1`；預設工具鏈 `stable-x86_64-pc-windows-msvc`，符合 Tauri 2.12 要求的 rust-version 1.90 以上 |
| MSVC | Visual Studio Build Tools 2022 `17.14.37710.0`，包含 `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`；Windows SDK `10.0.26100.0` |
| WebView2 | `157.0.4341.60`（HKLM） |
| Node／npm | `v26.13.1`／`11.20.0`（`C:\Program Files\nodejs`） |
| Python | 3.11（系統）、3.15（系統，預設 `py`）、3.12.16 與 3.10.22（uv）。**注意：`py` 預設是 3.15**，腳本一律指定 `-3.11` |
| CosyVoice venv | Python 3.10.22、torch 2.3.1+cu121、faster-whisper 1.2.1、onnxruntime 1.18.0（CPU）；venv 5.7GB、CosyVoice3 模型 9.1GB、whisper 1.6GB |
| OpenCC（py311） | 可以匯入 |
| ffmpeg | 9.0.2 gyan full_build（GPLv3，含 `--enable-nvenc`，不含 nonfree），透過 WinGet 安裝 |
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU，driver 621.01，VRAM 6141 MiB（只用 `--query` 讀取） |
| Git／gh／claude | git 2.56.0、GitHub CLI 已安裝、Claude Code 2.1.325 |
| <PROJECT_DIR> | 是 git repo，只有 1 個 commit（`59cc5dc Checkpoint: EP01 ...`），`scripts/qa_video.py` 有未提交的修改 |
| LongPathsEnabled | `0`（關閉）；chrome-headless-shell 的 exe 路徑長度為 121 字元，目前不會觸發短路徑複製 |
| NSIS／WiX | PATH 上找不到 `makensis`／`candle`（Tauri bundler 可能會自動下載，未查證） |
| 磁碟 | C: 剩 82G（使用率 82%）；D: 剩 722G |
| Remotion | 4.0.545；chrome-headless-shell 已經在 node_modules；node_modules 912M |

**結論**：建置 Tauri 2 所需的系統軟體（Rust MSVC、Build Tools、Windows SDK、WebView2、Node）都已經就緒。**明天不需要安裝任何系統軟體**，只要在 `studio/` 內安裝專案相依套件（npm 套件、cargo crates）。

## 4. 明天會用到的指令（只在 studio/ 內執行，不碰專案根目錄的 node_modules）

```bash
export PATH="/c/Program Files/nodejs:$HOME/.cargo/bin:$PATH"
cd <PROJECT_DIR>/studio
rustc --print host-tuple                       # 預期 x86_64-pc-windows-msvc
npm create tauri-app@latest app -- --template vanilla-ts --manager npm --yes   # 互動選項以實際 CLI 為準
cd app && npm install                          # 只安裝 studio/app/node_modules
npm run tauri dev
npm run tauri build -- --bundles nsis          # 輸出 src-tauri/target/release/bundle/nsis/*-setup.exe
```

不需要但可以記錄的系統層指令（**需要使用者同意，今晚不執行**）：

```powershell
winget install --id Rustlang.Rustup            # 本機已安裝，不需要
rustup default stable-msvc
# MSI 才需要：設定 > 應用程式 > 選用功能 > 更多 Windows 功能 > VBSCRIPT
```
