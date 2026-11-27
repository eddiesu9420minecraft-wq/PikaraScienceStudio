# Pikara Science Studio — 跨平台稽核（P0）

稽核基準：`main` 17bcf41（v0.3.1 + 統一 splash），分支 `feat/cross-platform`。
範圍：`studio/app/src-tauri`（Rust 後端，約 16.5k 行）、`studio/app/src`（純 ES module 前端，無打包器）、`pipeline/`（Remotion 範本與 Python／Node 製作腳本）、CI、資料庫、更新與安裝。

狀態欄位說明：**已改**＝本分支已修改並有測試；**已驗證**＝在該平台真機或 CI 實測通過；**待實測**＝程式已備妥但還沒有在該平台真正跑過；**未支援**＝明確不支援並說明原因。沒有實測的項目一律不標成可用。

## 1. 總結

| 類別 | 結論 |
|---|---|
| 編譯 | v0.3.1 在 macOS／Linux **無法編譯**：`windows`／`windows-sys` 是無條件相依。另外 `encoders.rs` 用錯誤的相對路徑 `include_str!` 編碼器表，GitHub 上的 repo 連 Windows 都無法直接建置（splash 交接紀錄已提到）。兩者本分支皆已修正。 |
| 已有的跨平台設計 | 編碼器層（`hw_encoders.json` + `hwenc.mjs` + `encoders.rs`）原本就以「實際試編碼」判斷，已有 VideoToolbox／VA-API 候選；`render.mjs` 已依 `process.platform` 選 ANGLE 後端；多數 Rust GPU 程式已 `cfg(windows)` 隔離。 |
| 最大風險 | ① macOS 上 CosyVoice 3 的品質與速度（CUDA 專用最佳化、`ttsfrd` 只有 Windows／Linux wheel）；② faster-whisper（CTranslate2）在 macOS 沒有 Metal 後端；③ GitHub macOS runner 是虛擬機，VideoToolbox／Metal 的結果不能代表 Mac mini M2 真機。 |
| 資料安全 | 遷移前備份原本用 `VACUUM INTO`，沒有跨程序遷移鎖、還原不檢查 Studio 是否仍在執行。已改為 SQLite online backup API + 遷移鎖 + `BEGIN IMMEDIATE` 重新檢查版本 + 還原保護。 |

## 2. 逐項稽核

優先級：P0＝阻擋 macOS 執行；P1＝影響主要流程；P2＝體驗／效能；P3＝之後。

### 2.1 建置、相依與入口

| 檔案 | 目前技術 | macOS 相容性 | 替代方案（本分支） | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `src-tauri/Cargo.toml` | `windows 0.62`、`windows-sys 0.59` 為一般相依 | ✗ 無法編譯 | 移到 `[target.'cfg(windows)'.dependencies]`；`rusqlite` 加 `backup` 功能；`rust-version` 1.89（`File::try_lock`） | 低 | CI：macOS arm64／x64、Linux `cargo test` | P0／已改 |
| `hardware/encoders.rs:17` | `include_str!("../../../../../scripts/hw_encoders.json")` | ✗（所有平台都找不到檔案） | 改指向 `pipeline/scripts/hw_encoders.json` | 低 | Windows `cargo test`（124 通過） | P0／已改、已驗證（Win） |
| `main.rs` | `AttachConsole`（cfg windows） | ✓ 已隔離 | — | 低 | CI 建置 | — |
| `picker.rs` | `GetOpenFileNameW`（cfg windows），非 Windows 走 fallback | ✓ 可編譯 | 之後可改用 tauri dialog plugin（原生 NSOpenPanel） | 低 | 待實測（Mac 真機） | P2／待實測 |
| `tauri.conf.json` | bundle 只有 `nsis`、`.ico` | ✗ 無 macOS 套件設定 | 新增 `tauri.macos.conf.json`（app+dmg、icns、最低 macOS 12、未簽章）與 `tauri.linux.conf.json` | 中（splash 透明視窗在 macOS 需要 private API，未開啟 → 不透明背景） | CI macOS bundle job：檢查 Mach-O 架構、bundle 內沒有 .exe/.dll、DMG 大小、bundle 內執行 `--cli hardware` | P0／已改、待 CI |

### 2.2 路徑、資料夾、PATH

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `util.rs::data_dir` | `%APPDATA%\PikaraScienceStudio`，缺少時 temp | ✗（macOS 沒有 APPDATA → 落到 temp，重開機遺失資料） | `platform::data_base()`：Windows 不變；macOS `~/Library/Application Support`；Linux `$XDG_DATA_HOME` | 高（資料遺失）→ 已排除 | `platform::tests::data_dirs_are_platform_native` | P0／已改 |
| （新）`util::cache_dir` | — | — | Windows `%LOCALAPPDATA%`、macOS `~/Library/Caches`、Linux `$XDG_CACHE_HOME` | 低 | 單元測試 | 已改 |
| `util.rs::which` | `where.exe` | ✗ | Windows 保留 `where.exe`（行為不變）；其他平台在程序內搜尋 PATH（含執行權限檢查） | 低 | `which_finds_a_shell` | P0／已改 |
| `util.rs::path_with` | `;` 分隔、`.exe` 判斷 | ✗ | `platform::join_path_list`／`split_path_list`；macOS 補 `/opt/homebrew/bin`、`/usr/local/bin`（Finder 啟動的 App 只有 `/usr/bin:/bin:/usr/sbin:/sbin`） | 中 | `path_list_round_trip`；Mac 真機從 Finder 啟動 | P0／已改、待實測 |
| `util.rs::tool` | `where` + WinGet Links/Packages | ✗ | `platform::exe()` + Homebrew/MacPorts 目錄；WinGet 只在 Windows | 低 | CI | P0／已改 |
| `jobs/steps.rs`、`rerender.rs`、`doctor.rs` | `node.exe`、`tools\CosyVoice\.venv\Scripts\python.exe`、`py -3.11`、`npm.cmd` | ✗ | `platform::node_program`、`default_cosy_python`（`bin/python`）、`python311()`（Windows 仍 `py -3.11`；其他 `python3.11`→`python3`） | 中 | Windows 測試；Mac 真機 doctor | P0／已改 |
| `doctor.rs::chs_path` | `node_modules\.remotion\chrome-headless-shell\win64\…\.exe` | ✗ | `platform::remotion_chs()`：`mac-arm64`／`mac-x64`／`linux64` | 低 | CI gpu-check | P0／已改 |
| `claude.rs`、`agents.rs` | `%USERPROFILE%\.local\bin\claude.exe`、`%APPDATA%\npm\*.cmd` | ✗ | Unix：`~/.local/bin`、`~/.claude/local`、Homebrew、npm global | 低 | Mac 真機 | P1／已改、待實測 |
| `pipeline/scripts/lib.mjs` | 長路徑時把 chrome-headless-shell 複製到 `%LOCALAPPDATA%`（只在 win32） | ✓（非 Windows 直接回傳 null） | — | 低 | — | — |
| `envfix.rs` | MSIX AppData 重新導向修復（Windows 專用） | n/a | 只有 venv 直譯器路徑改用 `platform::venv_python` | 低 | 既有測試 | — |

### 2.3 程序管理（啟動／停止／暫停／續跑）

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `util.rs::kill_tree` | `taskkill /T /F` | ✗ | `platform::process::kill_tree`：Windows 不變；Unix 子程序以 `process_group(0)` 啟動，先 SIGSTOP 整棵樹（避免 fork），再 SIGKILL 程序群組＋所有後代（sysinfo 走訪，涵蓋自建群組的 Chromium） | 中 | `pause_resume_and_kill_a_real_tree`、`cancel_kills_process_tree` | P0／已改、已驗證（Win） |
| （新）暫停／繼續 | v0.3.1 沒有 | — | Windows `NtSuspendProcess`/`NtResumeProcess`；Unix SIGSTOP/SIGCONT；暫停標記檔 `<data>/paused/<job>` 讓跨程序（視窗、`--cli`）共享狀態；停滯監控與下一步驟在暫停時等待；不改 DB schema | 中（暫停中的 CUDA／Metal 程序仍占記憶體——刻意的，模型常駐） | `pause_and_resume_a_running_job`（2 秒停滯上限下暫停 3 秒不被誤殺） | P1／已改、已驗證（Win） |
| `queue.rs::run_step` | `creation_flags(CREATE_NO_WINDOW)` | ✓（cfg） | `platform::process::configure` | 低 | 既有測試 | 已改 |
| `queue.rs::set_keep_awake` | `SetThreadExecutionState` | ✗（無效果） | macOS `caffeinate -i -w <pid>`；Linux `systemd-inhibit` | 低 | Mac 真機：`pmset -g assertions` | P2／已改、待實測 |
| `util.rs::scheduler_lock`、`gpulock.rs` | `share_mode(0)` | ✗（非 Windows 沒有鎖 → 兩個 Studio 會重複執行同一個工作） | `platform::open_exclusive`：Unix 用 `flock`（`File::try_lock`） | 高 → 已排除 | `exclusive_lock_is_exclusive` | P0／已改 |
| `gpulock.rs::lock_path` | `%ProgramData%`，缺少時 `C:\ProgramData` | ✗（macOS 會建立相對路徑 `C:\ProgramData`） | `machine_lock_dir()`：macOS／Linux 用使用者快取資料夾 | 中 | 單元測試 | P0／已改 |
| `pipeline/scripts/gpu_lock.py` | `ctypes.WinDLL("kernel32")` 於 import 時載入 | ✗（import 即失敗） | Unix 用 `fcntl.flock`，與 Rust 的 flock 互通；路徑規則相同 | 中 | Windows 實測取得／釋放；Mac 待實測 | P1／已改 |
| `jobs/steps.rs` custom 工作 | `cmd /d /s /c` | ✗ | Unix `/bin/sh -c`；佇列測試改為雙平台指令 | 低 | CI 佇列測試 | 已改 |

### 2.4 硬體偵測

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `hardware/native.rs` | DXGI 1.6、D3D12、`nvcuda.dll` | ✗（cfg 隔離，回傳錯誤） | 保留給 Windows | — | — | — |
| `hardware/manager.rs` | DXGI + CIM（PowerShell） | ✗ | macOS 走 `hardware/apple.rs`：`sysctl`（arm64、Rosetta `sysctl.proc_translated`、P/E 核心、`hw.memsize`）、`system_profiler SPDisplaysDataType -json`（GPU 型號、核心數、Metal 家族、Intel Mac 的 AMD 獨顯 VRAM）。Apple Silicon 的統一記憶體列為「共用記憶體」，**獨顯 VRAM 固定為 0**，不套用 VRAM 公式 | 中 | `apple::tests`（M2 16 GB、Intel+AMD 5500M、Rosetta 樣本）；CI `--cli hardware`；Mac mini M2 待實測 | P0／已改 |
| `hardware/selector.rs` | CUDA → AI；最多 VRAM 的獨顯 → 渲染 | ✗（Mac 只有「內顯」，會顯示「較慢」） | Apple GPU：AI target `apple`（MLX／MPS 由語音後端實測決定），渲染說明 ANGLE→Metal；`PIKARA_RENDER_GPU_LUID` 只在 Windows 設定 | 低 | 單元測試 | 已改 |
| `hardware/telemetry.rs`、`monitor.rs` | `nvidia-smi` | 部分（無資料即「未知」） | macOS GPU 使用率需 `powermetrics`（需 root）或 IOKit `IOAccelerator` 統計 → 列為 P2 | 低 | — | P2／未做 |
| `hardware/usage.rs` | Windows GPU Engine 效能計數器 | n/a | macOS 待做（IOKit） | 低 | — | P2／未做 |
| （新）`hardware/profile.rs` | — | — | `MachineProfile` + 省電／平衡／高效能／自訂預算（保留核心與記憶體給系統、統一記憶體單一預算、自訂值有下限保護）；`budget_env` 傳給腳本；Windows 的渲染上限與 render.mjs 原規則一致 | 中（常數需要實測校正） | `profile::tests`；BENCHMARK 待校正 | P1／已改 |
| （新）`pipeline/scripts/accel_probe.py` | — | — | CUDA／MPS／MLX／CPU 各做一次 fp32 矩陣乘並比對 CPU 結果與計時，沒有實際算出結果就不算可用 | 低 | Windows RTX 4050 實測：CUDA 5.0 TFLOPS、MPS/MLX 正確回報不可用；CI macOS 待結果 | 已改 |

### 2.5 影片：Remotion／Chromium／Three.js／編碼

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `pipeline/scripts/render.mjs` | Remotion 4、分段續傳、動態並行、`--gl=angle`（macOS 為 ANGLE→Metal） | ✓ 理論上 | 新增 `PIKARA_RENDER_MAX_CONC`（只能降低上限）；macOS 沒有 VRAM 遙測 → 依 RAM 與 CPU 限制 | 中：Apple Silicon 上 headless Chromium 的 WebGL 是否真的走 Metal 需實測（不可與 VideoToolbox 混淆） | CI：`gpu-check.mjs --force` 讀 WebGL renderer 字串；90 幀實際渲染；Mac 真機 FPS | P1／待 CI、待真機 |
| `hw_encoders.json` + `hwenc.mjs` + `encoders.rs` | NVENC／AMF／QSV／MF／VideoToolbox／VA-API／libx264 實際試編碼 1 秒 720p60 + ffprobe 驗證幀數 | ✓ 設計正確 | VideoToolbox 參數 `-allow_sw 0`（不接受軟體冒充）；結果只以實測為準 | 中：GitHub macOS VM 可能沒有 VideoToolbox 硬體編碼，CI 失敗不代表真機 | CI 實際編碼 h264/hevc；Mac mini M2 真機 | P1／待 CI、待真機 |
| `pipeline/scripts/mix_audio.py`、`qa_video.py` | ffmpeg／ffprobe、numpy | ✓ | — | 低 | Mac 真機整片 | P1／待實測 |
| `gpu-check.mjs` | nvidia-smi（選用）+ WebGL probe + hwenc | ✓ | — | 低 | CI | — |

### 2.6 語音（CosyVoice 3）與 ASR（Whisper）

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `pipeline/scripts/generate_voiceover_cosy.py` | CosyVoice 3（Fun-CosyVoice3-0.5B）PyTorch CUDA fp16、模型常駐、`empty_cache` 停用、OOM 重試、Whisper CER 驗證 | 部分：沒有 CUDA 時已自動 CPU fp32；MPS 未支援 | 候選：PyTorch MPS（`PYTORCH_ENABLE_MPS_FALLBACK=1`）、CPU fp32、MLX 移植（社群）、其他 TTS（見 MACOS.md §3）。**必須同一批測試句 A/B 實測**才能選擇 | 高：`ttsfrd`（文字正規化）沒有 macOS wheel → 退回 `wetext`，數字／單位念法可能改變；需用發音字典＋CER 驗證 | 需 Mac mini M2 真機（GitHub VM 沒有可用的 Metal 效能代表性、記憶體 7 GB） | P1／待真機 |
| 同上（ASR 段） | faster-whisper（CTranslate2）CUDA float16，無 CUDA → CPU int8 | 部分：CTranslate2 在 macOS 只有 CPU | 候選：mlx-whisper、whisper.cpp（Metal）、faster-whisper CPU int8；比較 CER、時間戳一致性、速度 | 中：換 ASR 會改變字級時間戳 → 必須維持現有字幕格式與時間軸對齊規則，繁簡比對不可誤判 | 同一批音檔比對 CER 與字級時間差 | P1／待真機 |
| `tts_watchdog.py` | nvidia-smi 執行緒 | ✓（沒有 nvidia-smi 時不做事） | — | 低 | — | — |

### 2.7 執行環境（Python／uv／Node／FFmpeg／模型）

| 項目 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| Python | Windows `py -3.11`（系統安裝）、CosyVoice venv 在專案 `tools/CosyVoice/.venv` | ✗（沒有 py launcher） | 短期：`python3.11`／`python3`；長期：與 CYW 共用的 uv 管理 runtime（見 ROADMAP P6） | 中 | doctor | P1／部分 |
| FFmpeg | 使用者自行安裝（WinGet Gyan full build, GPLv3） | 需 Homebrew `ffmpeg`（含 VideoToolbox） | P6：共用 runtime 下載官方 macOS arm64 build 並驗證 SHA-256；不可把 Windows binary 放進 macOS 套件 | 中（授權：GPL build 不可與 MIT 主程式一起再散布，維持「不內含、引導安裝」） | — | P1／未做 |
| 模型 | `tools/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B`、Whisper 本地 | ✓ 檔案本身跨平台 | P6：與 CYW 共用模型快取、斷點續傳、SHA-256、不重複下載 | 中 | — | P2／未做 |
| Node | 使用者安裝或 `nodeDir` | ✓ | `platform::node_in` 支援 `bin/node` | 低 | — | 已改 |

### 2.8 資料庫

| 檔案 | 目前技術 | macOS 相容性 | 替代方案 | 風險 | 測試方法 | 優先級／狀態 |
|---|---|---|---|---|---|---|
| `db.rs::open` | WAL、`user_version`、遷移前 `VACUUM INTO` 備份 + integrity_check | ✓ | online backup API（分段，不阻擋其他連線）、備份檔改 `journal_mode=DELETE`（不留 -wal）、跨程序 `studio.db.migrate.lock`、`BEGIN IMMEDIATE` + 交易內再檢查版本 | 中 → 已降低 | `concurrent_openers_migrate_once_with_one_backup`（6 個連線同時開啟舊版 DB：只遷移一次、只有一份備份、200 筆資料完整） | P0／已改、已驗證（Win） |
| `db.rs::restore` | 覆蓋檔案並刪除 -wal/-shm | 風險：Studio 執行中還原會毀損 | 偵測 `scheduler.lock` 被持有就拒絕 | 高 → 已排除 | `restore_refused_while_studio_runs` | P0／已改 |
| 封裝容器 | — | n/a | `platform::packaged_container()`（GetCurrentPackageFullName）。**實測：從 Claude 桌面 App 啟動的子程序回傳 null，但 AppData 寫入仍被虛擬化** → 不能只靠這個 API 判斷，測試一律使用 `PIKARA_STUDIO_DATA` 隔離資料夾（TESTING.md） | 高（曾造成 studio.db 與 WAL 分家） | 見 TESTING.md §2 | P0／文件 |

### 2.9 前端與 splash

| 檔案 | 目前技術 | 結論 |
|---|---|---|
| `studio/app/src/index.html`、`js/**` | 純 ES module、無打包器（JS 合計 359 KB）；`js/` 沒有任何 three／remotion／WebGL 匯入 | Studio 介面本身不載入 Three.js／WebGL／Remotion／AI 模型；這些只在製作工作（Node／Python 子程序）中使用。P7 的「最終 bundle 相依鏈」在 Studio 不適用 Vite；以 `grep` 驗證（見 TESTING.md §5）。 |
| `vendor/pikara-splash` | 由 CYW `crates/pikara-splash/sync.mjs` 同步 | 共用，不在本分支修改；macOS 透明視窗需 `macOSPrivateApi`（未開啟），見 KNOWN_ISSUES。 |

### 2.10 更新、安裝、移除

| 項目 | 目前 | 結論／計畫 |
|---|---|---|
| Studio 自我更新 | 沒有 | P9：整合 CYW `crates/pikara-secure`（DoH、TLS、主機白名單、SHA-256、minisign、防降級／重放）；製作中不更新、不關閉；由 CYW 安裝時交給 CYW 更新。未做（ROADMAP）。 |
| CYW 目錄 | `products.json` 期待 macOS 資產 `_aarch64.app.tar.gz`／`_aarch64.dmg`／`_x64.*` | Tauri 預設的 updater 壓縮檔名 `Pikara Science Studio.app.tar.gz` **不含架構**；發佈流程必須改名，否則 CYW 找不到 macOS 套件。 |
| 安裝／移除 | NSIS currentUser | macOS：DMG 拖曳安裝；移除不刪 `~/Library/Application Support/PikaraScienceStudio`（使用者資料）。 |

### 2.11 CI／發佈

| 檔案 | 目前 | 結論 |
|---|---|---|
| `.github/workflows/ci.yml` | 只有 Windows test + build、TS 檢查 | 保留 |
| （新）`.github/workflows/cross-platform.yml` | — | Windows／macOS arm64／macOS x64／Linux 單元測試＋硬體 CLI；macOS／Linux 實際編碼、WebGL probe、90 幀渲染、加速器 probe；macOS arm64／x64 未簽章 .app/.dmg（檢查架構、沒有 Windows binary、bundle 內可執行）。fail-fast false、不使用任何 secret、不傳空的 APPLE_* 變數。 |
| 發佈（簽章） | 沒有 | 需要使用者同意把 Pikara release key 加為 Studio repo secret；Apple 公證需要 Apple Developer 憑證（目前沒有）→ macOS 套件標示「未公證」。 |

## 3. 技術選型（第一輪結論）

| 能力 | Windows（保留） | macOS 首選（待真機 A/B） | 備援 |
|---|---|---|---|
| UI 殼 | Tauri 2 + WebView2 | Tauri 2 + WKWebView | — |
| 影片畫面 | Remotion + Chromium ANGLE/D3D11 | Remotion + Chromium ANGLE/Metal | SwiftShader（CPU） |
| 編碼 | NVENC → AMF → QSV → MF → libx264（實測鏈） | h264/hevc_videotoolbox（`-allow_sw 0`，實測） | libx264/libx265 |
| 語音 | CosyVoice 3 CUDA fp16 | 依 MACOS.md A/B：CosyVoice 3（MPS 或 CPU fp32）優先維持音色與克隆一致性 | CPU fp32 |
| ASR | faster-whisper CUDA | mlx-whisper 或 whisper.cpp Metal（實測 CER／時間戳後決定） | faster-whisper CPU int8 |
| 程序控制 | taskkill／NtSuspendProcess | process group + SIGKILL／SIGSTOP/SIGCONT | — |
| 資料 | `%APPDATA%` | `~/Library/Application Support`、`~/Library/Caches` | — |
