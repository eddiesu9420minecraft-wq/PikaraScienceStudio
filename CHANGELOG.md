# Changelog

## v0.2.0-alpha — 2026-11-20

主要功能改為「自動製作」：輸入主題，一鍵完成整支影片。

### 新增

- **Autonomous Production Mode（自動製作）**：一鍵式 AI 影片製作。自動分配集數（不覆蓋既有作品）；在隔離 git 工作樹依序執行研究與劇本、動畫程式、配音與發音檢查、時間軸、關鍵幀 AI 畫面審查、繁中正式版、YouTube 1.5×、Bilibili 簡中、封面、上架資訊、交付。
- **Git Checkpoint 與自動合併**：每個階段一個 checkpoint；全部通過才 `--no-ff` 合併；集數感知的自動解衝突（narration／timeline JSON 只加入本集、registry.ts 聯集合併）；失敗或停止時專案不變，「捨棄」刪除工作樹與分支＝回復。
- **自動品質檢查與除錯**：旁白驗證與字數、資料來源（≥3 個網址）、TypeScript、Whisper 拼音比對發音（數字寫法與同音字不誤報）、關鍵幀畫面審查（修正後重審）、QA；失敗原因與日誌交給 AI 修正並重試；發音／畫面／QA／封面／上架資訊在次數用完時以警告繼續，渲染或配音失敗則停止。
- **任務暫停、中斷恢復及重試**：暫停（執行中的工作做完）、繼續、停止；Studio 關閉或當機後自動接續；失敗階段可重試；時間與回合上限；Windows 通知。
- **Claude Code 訂閱模式**（預設）：使用已登入的官方 Claude Code CLI，不要求 API Key；子程序移除 `ANTHROPIC_API_KEY`／`ANTHROPIC_AUTH_TOKEN`；不設美元上限；顯示的金額標示為模型等價估算；達到用量上限時暫停並保存進度，不切換付費 API。API 付費模式必須設定每次上限。
- **External Agent 支援**：AI 步驟可交給外部 Agent——製作停在「等待 Agent」並寫出 `out/auto/AGENT_TASK.md`，Agent 完成後以 `--cli agent-done` 回報，Studio 照常檢查與續做。
- **Doubao Work Skill**：`studio/integrations/doubao-work/pikara-studio/SKILL.md`（Release 附 `pikara-studio-skill.zip`），讓豆包工作桌面版（本地電腦模式）透過 Studio 命令列建立任務、完成 AI 步驟、查詢進度、分析錯誤、取得成品。接入說明：`studio/docs/DOUBAO_WORK.md`。
- **豆包官方 CLI 接入**：AI 提供者可選豆包 CLI（`doubao -C <工作樹> --permission-mode always_allow -p`，使用者自己的豆包帳號，不需 API Key）；連線與能力測試 `--cli agent-check --deep` 會實際寫檔並執行命令。不逆向任何客戶端、不讀取憑證，與 Claude 登入互不影響。
- **Bilibili 簡體中文及中國大陸術語**：術語表新增「輝達→英偉達」；封面文字一併轉換；通用封面 `<EP>-Thumbnail`。
- 介面：「自動製作」為首頁、一般／進階模式、「使用教學」頁與第一次啟動導覽、AI 提供者選擇與測試、語速設定。
- 命令列：`auto-start`（`--config-file`）、`auto-run`、`auto-status`、`auto-pause/resume/stop/discard`、`agent-task`、`agent-done`、`agent-check`、`job-log`、`narration-get/set`；製作 id 可用前綴。
- 排程鎖：同一資料夾只能有一個程式執行佇列（避免重複執行）。
- API 規格 v1.3（`studio/app/API.md`）。

### 修正

- QA：場景交界的轉場不再被算成黑幀問題。
- 工作執行目錄可指定為 Studio 工作樹；渲染前先做型別檢查；中斷後重試交付不會遺漏成品。

### 實際測試結果

見 `studio/app/TEST_REPORT_v0.2.0.md`。摘要：

- Claude Code（訂閱）端到端製作 EP04（約 58 分鐘）：研究 4 個官方來源、6 幕 AI 動畫、發音修正 2 輪、畫面審查修正 1 次、QA 修正 1 次；繁中正式版（182.9 s）、YouTube 1.5×（121.9 s）、Bilibili 簡中（118.5 s）QA 皆 0 項，已自動合併。
- External Agent 模擬端到端製作 EP05（測試者依技能逐步操作）：劇本、配音、QA 修正任務、以警告繼續、上架資訊、交付與自動解衝突合併。
- 暫停／繼續／中斷恢復／停止／捨棄、排程鎖：通過。
- `cargo test` 44 通過；正式版 `--selftest` 17/17；正式版 exe 不含本機使用者名稱與路徑。

### 已知限制

- 豆包 CLI 尚未使用真實帳號測試。
- 豆包工作桌面客戶端尚未實機驗證；External Agent 已完成模擬端到端測試。
- 完整使用教程尚未完成。
- 目前仍為 Alpha 測試版本。

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
