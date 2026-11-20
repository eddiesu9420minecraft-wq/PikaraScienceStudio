# Changelog

## v0.1.0-alpha — 2026-11-20

第一個公開測試版。

### 內容

- Pikara Science Studio 桌面程式（Tauri 2）：專案、劇本編輯（繁／簡）、提示詞與 Claude Code worktree、製作與工作佇列（GPU 鎖、心跳、中斷自動重排）、即時資源監控、環境醫生（17 項檢查）、預覽與發布中心（無上傳）、git 回滾。
- 影片製作範本專案 `pipeline/`：Remotion 七幕動畫、旁白驅動時間軸、CosyVoice 3／Edge-TTS 配音腳本、Whisper 對齊、側鏈 ducking 混音與原創合成配樂、分段可續傳 GPU 渲染與 NVENC 編碼、自動 QA、zh-TW → zh-CN 本地化。

### 實際測試結果（發布前）

- `cargo test --release`：全部通過。
- 正式版 `PikaraScienceStudio.exe --selftest`：13/13 通過（資料庫、專案、旁白驗證、提示詞、CPU 工作、GPU 鎖、中斷恢復、監控、環境醫生、ffprobe、Claude CLI 偵測、git、系統設定只給說明）。
- 以 Studio 佇列實際執行 GPU 渲染（60 幀 1080p）與 Claude Code（唯讀工具，於隔離 worktree）。
- 9 個介面畫面以 `tauri dev` 對真實後端操作驗證。

### 已知問題

見 README「已知問題」。
