# 已知問題（feat/cross-platform）

| # | 平台 | 問題 | 影響 | 處理 |
|---|---|---|---|---|
| 1 | macOS | 沒有在 Mac mini M2 真機跑過完整製作流程 | 語音品質、渲染 FPS、VideoToolbox 都未經真機驗證 | 需要使用者提供 Mac 存取（SSH） |
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
| 12 | 發佈 | Tauri 的 `.app.tar.gz` 檔名不含架構，CYW `products.json` 期待 `_aarch64.app.tar.gz` | CYW 找不到 macOS 更新包 | 發佈流程改名（ROADMAP P11） |
| 13 | 全部 | Studio 沒有自我更新（P9 未實作） | — | ROADMAP |
| 14 | Linux | 只有核心測試，沒有完整流程測試 | — | Linux-ready 架構，非本階段目標 |
