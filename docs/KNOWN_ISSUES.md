# 已知問題（feat/cross-platform）

| # | 平台 | 問題 | 影響 | 處理 |
|---|---|---|---|---|
| 1 | macOS | Mac mini M2 真機（2026-11-28）：完整 CLI 製作已通過（CPU 配音、Metal 渲染、VideoToolbox、中斷續作）；**配音只用測試參考聲音，沒有人耳試聽**；MPS／MLX 配音未啟用 | 正式旁白音質與速度未驗證 | 用使用者自己的 reference.wav 做 A/B（MACOS.md §3） |
| 2 | macOS | CosyVoice 3 在 macOS 沒有 CUDA；MPS 是否完整可用未知；`ttsfrd` 沒有 macOS wheel | 速度、數字／單位念法可能與 Windows 不同 | MACOS.md §3 A/B 測試；發音字典 + CER 檢查 |
| 3 | macOS | faster-whisper（CTranslate2）只有 CPU | ASR 慢 | 評估 mlx-whisper／whisper.cpp |
| 4 | macOS | splash 視窗 `transparent: true` 在未開 `macOSPrivateApi` 時不透明 | 外觀（有底色），功能不受影響 | 共用 pikara-splash，需與 CYW 協調是否開啟 |
| 5 | macOS | 套件未簽章、未公證 | Gatekeeper 阻擋，需右鍵打開 | 需要 Apple Developer 憑證（付費） |
| 6 | macOS | GPU 使用率／溫度遙測沒有實作（只有 NVIDIA 的 nvidia-smi） | 監控頁顯示「未知」；render.mjs 依 CPU／RAM 調整並行 | P2：IOKit／powermetrics |
| 7 | macOS | 檔案選擇器（picker.rs）非 Windows 走 fallback | 匯入素材可能需改用拖放 | 改用 tauri dialog plugin |
| 8 | 全部 | `PIKARA_TTS_BATCH_MAX`、`PIKARA_CPU_THREADS`、`PIKARA_MEM_BUDGET_MIB` 已由 Studio 傳出，但配音腳本還沒讀取 | 功率模式目前只影響渲染並行（render.mjs 讀 `PIKARA_RENDER_MAX_CONC`） | 下一步接到 VoiceBackend |
| 9 | 全部 | 功率模式「自訂」的數值還不能從設定頁存入（`budget()` 支援，Settings 沒有欄位） | 自訂模式等同平衡 | P8 設定頁 |
| 10 | 全部 | 預算常數（每分頁 700 MiB、模型 5 GiB、每句 600 MiB）是保守估計 | 可能過度保守 | BENCHMARK 真機校正 |
| 11 | Windows | `GetCurrentPackageFullName` 偵測不到「由封裝程式啟動的子程序」仍被虛擬化 AppData 的情況 | 測試若用預設資料夾可能寫到容器 | 測試一律用 `PIKARA_STUDIO_DATA`（TESTING.md §2） |
| 12 | 發佈 | ~~Tauri 的 `.app.tar.gz` 檔名不含架構~~ | 已處理 | `scripts/package-macos.sh` 產生 `Pikara.Science.Studio_<ver>_<aarch64\|x64>.app.tar.gz`／`.dmg`（CI 實際產出驗證）；名稱已交給 CYW |
| 13 | 全部 | Studio 沒有自我更新（P9 未實作） | — | ROADMAP |
| 14 | Linux | The full production ran end to end on a GitHub VM (x86_64, no GPU, CPU voice; see COMPATIBILITY §4), but not on a physical Linux machine | Voice, rendering and VA-API on NVIDIA / AMD / Intel GPUs haven't been tested | Needs a physical Linux machine, or the user's OK to use the local WSL2 |
| 15 | Linux | VA-API 試編碼原本固定用 `/dev/dri/renderD128` | 多 GPU 主機會開錯 GPU，實測失敗並退回 libx264 | 已改：Studio 傳 `PIKARA_VAAPI_DEVICE`（渲染 GPU 或第一個 Intel／AMD 的 render node），hwenc.mjs 使用它；**未在真機驗證** |
| 16 | Linux | 混合顯卡筆電無法指定 Chromium 用哪張 GPU 渲染（Windows 有 LUID） | 由驅動決定；gpu-check 實測決定是否用 GPU | PRIME offload 環境變數待真機驗證 |
| 17 | Linux | AMD ROCm：只偵測是否存在，CosyVoice／Whisper 一律用 CPU | 有 AMD 獨顯也不加速配音 | 真機 ROCm A/B 後才開放 |
| 18 | Linux arm64 | CI 只跑單元／CLI 測試與媒體探測，沒有跑完整製作 | — | 同 #14 |
| 19 | Windows | 用 Windows PowerShell／Python 讀 `--json` 輸出時要以 UTF-8 解碼（預設 cp950 會把中文弄壞） | 只影響呼叫端腳本 | docs/CLI.md 說明；輸出本身是正確的 UTF-8 |
| 20 | 安全 | `chrono` 被 RustSec 標為 unmaintained（RUSTSEC-2026-0543，非漏洞、無修正版本） | 無已知漏洞 | 追蹤替代方案；CI audit 只對漏洞／unsound／yanked 失敗 |
| 21 | macOS | Chromium（Remotion）在「仍連線中的 SSH 工作階段」裡啟動時，GPU 程序起不來（icudtl.dat not found → Target closed）；同一指令以 `nohup … &` 脫離後 6／6 成功 | 從 SSH 前景執行渲染會失敗 | 在 Mac 上用視窗版，或 `nohup PikaraScienceStudio run --stay &`／tmux 後中斷 SSH 連線；docs/MACOS.md |
| 22 | macOS | ~~render.mjs 用 os.freemem()，macOS 只算完全空閒的頁面（M2 實測 66 MiB，實際可用 4 GiB），會讓記憶體保護無故降低並行~~ | 已修正 | vm_stat：free + file-backed + purgeable（與 Remotion 相同規則）；真機實測讀到 2.4 GiB |
| 23 | 全部 | ~~gpu-check 讀不到 WebGL renderer 時誤判「GPU 不可用」~~（Remotion still 不轉送 console；手動啟動瀏覽器在 Mac 會當掉） | 已修正 | 探測頁把結果 POST 到 gpu-check 在 127.0.0.1 的一次性接收端；M2 真機讀到「ANGLE Metal Renderer: Apple M2」 |
| 24 | macOS | CosyVoice 環境：pip 的 scipy 在 macOS 27 無法載入；conda 的 OpenBLAS/OpenMP 與 pip torch 的 libomp 衝突（模型載入 SIGSEGV） | 已修正（install-cosyvoice.sh：macOS 用 conda env + conda-forge scipy + Accelerate BLAS） | Mac 上需要 micromamba；沒有 micromamba 的 Mac 未測試 |
| 25 | 全部 | CosyVoice 的文字正規化（wetext）從 ModelScope 下載時回 403（需要登入權杖），CosyVoice 改用「無前端」模式 | 數字、單位的念法可能與 Windows（已快取 wetext）不同；Studio 的發音字典與 CER 檢查仍會檢查 | 預先下載 wetext 或改由安裝腳本提供（未做） |
