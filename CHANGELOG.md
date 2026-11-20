# Changelog

## v0.1.1-alpha — 2026-11-20

修正 QA 腳本錯誤，加入多集與新專案支援。

### 修正

- `qa_video.py`：ffprobe 的 stdout／stderr 分開讀取（原本混在一起導致 `JSONDecodeError`）；由檔名自動判斷集數（`EP02_Final.mp4` → `ep02`）與繁／簡時間軸；自動判斷 1.5× 倍速版；影片不存在、0 位元組、損壞、未寫完（結尾無法解碼）、缺 ffprobe、時間軸沒有該集時，以繁體中文說明結束（結束碼 2），不再顯示 Python Traceback。
- `make_cn.py` 不再覆寫已存在的簡體時間軸。
- 工作失敗訊息只取失敗步驟本身的輸出；程式被外部結束時改為明確說明「意外結束，按重試從這一步繼續」，不再顯示無關的日誌行。
- CI：`claude.rs` 測試在 Windows CRLF 取出時失敗。

### 新增

- 多集：每集是 `narration.json` 的 `sequences.epNN`；「劇本編輯」「製作」有集數選擇器與「新增集數」；所有工作帶 `episode` 參數，輸出檔名由集數推得；沒有手工動畫的集數使用通用旁白樣板。
- 一鍵管線「繁中正式版」（`final_tw`）。
- 建立新專案：從範本複製管線到新資料夾（支援中文與空白路徑）並 git init，可用目錄連結共用 CosyVoice。
- 工作開始前預檢（缺 ffmpeg／ffprobe、找不到影片、沒有這一集、沒有 src_cn）。
- 無視窗命令列 `--cli`（episode-new、episode-list、project-new、doctor、enqueue、run-queue、jobs、job-retry、job-cancel、recover）。

### 實際測試結果

見 `studio/app/TEST_REPORT_v0.1.1.md`。

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
