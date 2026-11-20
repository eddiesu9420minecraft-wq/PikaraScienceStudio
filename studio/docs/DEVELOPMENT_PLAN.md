# 開發計畫

最後更新：2026-11-20。v0.1 的原始一日計畫已完成，內容見 git 歷史；本文件記錄目前狀態與 v0.2「自動製作」的計畫與驗收方式。

## 0. 已完成

| 版本 | 內容 | 驗收 |
|---|---|---|
| v0.1.0-alpha | Tauri 2 桌面程式：專案、劇本編輯、提示詞與 Claude worktree、製作與佇列（GPU 鎖、心跳、中斷恢復）、監控、環境醫生、預覽與發布、回滾；GitHub 開源 | selftest 13/13、CI 綠燈 |
| v0.1.1-alpha | qa_video.py 錯誤修正；多集（集數選擇器、通用旁白樣板、每集輸出檔名）；建立新專案；`--cli`；逐步失敗訊息與從失敗步驟重試 | `studio/app/TEST_REPORT_v0.1.1.md`（13 項實測）、selftest 16/16、CI 綠燈 |

## 1. v0.2.0「自動製作」（Autonomous Production Mode）

### 目標

使用者只輸入主題、長度、風格、語系與平台並按「開始製作」，Studio 自動完成研究、劇本、分鏡／動畫程式、配音、字幕、渲染、品質檢查、封面與上架資訊，期間不需要人操作；完成後通知使用者，**發布一律由人手動完成**。單一步驟工具移到「進階模式」。

### 架構（已實作：`src-tauri/src/autopilot.rs`）

- **製作（production）**是 SQLite 中的持久化狀態機（`productions`、`production_events`），每 2 秒推進一次；重活全部是一般佇列工作，因此 GPU 鎖、心跳、中斷自動重排、日誌都沿用既有機制。
- **隔離**：每次製作建立 git worktree `.studio/worktrees/auto-<ep>-<id>`（分支 `studio/auto/<ep>-<id>`），`node_modules` 與 `tools\CosyVoice` 用目錄連結共用，忽略的字型檔以硬連結複製。工作的 `workdir` 參數讓 job 在 worktree 中執行。
- **集數分配**：取繁／簡旁白、專案根目錄的 `EPnn_*` 檔、所有製作紀錄與 `studio/auto/*` 分支中最大的編號 +1，永不覆蓋。
- **階段**：準備 → 研究與劇本（Claude，WebSearch/WebFetch，寫 `<EP>_SOURCES.md`）→ 動畫程式（Claude，`src/acts/<ep>/`，可選）→ 配音（CosyVoice）＋ Whisper 發音檢查 → 時間軸 → 關鍵幀＋AI 畫面審查 → 繁中 30fps＋QA → YouTube 1.5×＋QA → Bilibili 簡中＋QA → 封面（`<EP>-Thumbnail`）→ 上架資訊（`<EP>_PUBLISH_METADATA.md`）→ 交付。
- **檢查與修正**：每個階段完成都在 worktree 建立 git checkpoint。檢查失敗 → 把錯誤與日誌交給 Claude 修正 → 重跑該階段，最多 `maxAttempts` 次。發音、畫面審查、QA、封面、上架資訊在次數用完時以「警告」繼續；渲染或 TTS 本身失敗則停止製作。動畫程式失敗時退回通用樣板。
- **交付**：成品移到專案根目錄（不覆寫）、worktree 分支 `--no-ff` 合併、清除 worktree（先拆目錄連結）。合併衝突時成品照樣交付，狀態為「需要手動合併」。失敗或停止時專案本身完全不變；「捨棄」刪除 worktree 與分支＝回復。
- **限制**：每階段嘗試次數、總時間上限（暫停時間不計）、Claude 每次最多回合數；隨時可暫停／停止。同一時間只執行一個製作（共用 GPU）。

### Claude Code 計費（使用者 2026-11-20 的要求）

- 預設使用已登入的官方 Claude Code CLI（訂閱）；**不要求、不保存** API Key 或帳號憑證。訂閱模式會從子程序移除 `ANTHROPIC_API_KEY`／`ANTHROPIC_AUTH_TOKEN`，確保不會改走付費 API；**不設美元上限**。
- API 付費模式需使用者自行在系統環境變數設定金鑰，且必須設定每次執行的美元上限（`--max-budget-usd`）。
- 顯示的金額是 Claude Code 回報的 `total_cost_usd` 加總，標示為「模型等價估算」；訂閱模式下不代表實際扣款。
- 遇到用量／額度上限或未登入：製作狀態變成「額度暫停」並保存進度，**不重試、不切換付費 API、不啟用額外用量**；使用者按「繼續」後從同一步接著做。服務暫時忙碌（overloaded）時等 5 分鐘重試，最多 6 次，不計入嘗試次數。

### 驗收

| # | 項目 | 方法 | 狀態 |
|---|---|---|---|
| 1 | 單元測試：設定與計費規則、額度／登入偵測、發音與 QA 解析、階段規劃、集數不重複、劇本檢查 | `cargo test` | ✅ 43 通過 |
| 2 | 端對端：以 CLI `--cli auto-start` / `auto-run` 從主題產生完整一集（AI 動畫、繁中、YouTube 1.5×、Bilibili、封面、上架資訊），所有檢查實際執行 | 實際執行，記錄於 `TEST_REPORT_v0.2.0.md` | 進行中 |
| 3 | 介面：自動製作頁（表單、進階選項、計費說明、製作清單、階段、即時紀錄、成品）、一般／進階模式切換 | tauri dev + WebView2 CDP 截圖 | ✅ 初步完成 |
| 4 | 暫停／繼續、停止、捨棄（回復）、Studio 中斷後恢復 | 實際操作 | 待做 |
| 5 | 正式版 EXE／安裝程式、selftest、CI | `tauri build`、`--selftest`、GitHub Actions | 待做 |

### AI 提供者與豆包工作（2026-11-20 新增）

- `AutoConfig.agent`：`claude`（預設，已登入的 Claude Code）、`doubao`（豆包工作官方的豆包 CLI：`doubao -C <工作樹> --permission-mode always_allow -p`，使用者自己的豆包帳號，不需 API Key）、`external`（外部 Agent，例如豆包工作桌面版＋技能）。
- 外部 Agent 模式：AI 步驟停在 `waiting_agent`，任務說明寫入工作樹 `out/auto/AGENT_TASK.md`；Agent 以 `--cli agent-task`／`agent-done` 溝通，Studio 照常做檢查、修正迴圈、配音、渲染、QA 與交付。
- 依據：豆包工作官方說明（本地電腦模式可讀寫本機檔案與執行程式、可上傳 SKILL.md 技能、可加 STDIO/HTTP MCP 插件、豆包 CLI 的 `-p`／`-C`／`--permission-mode`）。不逆向客戶端、不讀取憑證。
- 交付：`studio/integrations/doubao-work/pikara-studio/SKILL.md`、`studio/docs/DOUBAO_WORK.md`、`--cli agent-check --deep`（實際寫檔＋執行命令的能力測試）。
- 待驗證：豆包 CLI 實際執行需要安裝 `@bytedance/doubao-cli` 並由帳號持有人掃碼登入。

## 2. 接下來：教學（v0.2.0 發布前）

README 快速開始、`docs/TUTORIAL.md`（實際截圖）、`docs/FAQ.md`、程式內教學頁與第一次啟動導覽、3–5 分鐘實際操作影片；全部以最新 EXE 實際操作，以「自動製作」為主線。

## 3. 風險

| 風險 | 對策 |
|---|---|
| Claude 產生的動畫程式品質不穩 | tsc 檢查＋關鍵幀 AI 審查＋重試；仍失敗時退回通用樣板並提出警告 |
| 長時間無人值守時電腦睡眠 | 佇列執行時以 `SetThreadExecutionState` 保持喚醒；建議 Windows 睡眠設為「永不」 |
| 訂閱用量上限 | 自動暫停並保存進度；不繞過、不切換付費 |
| worktree 內的目錄連結被誤刪 | 刪除 worktree 前一律先拆連結；「提示詞」頁不列出、也不以一般方式刪除 `auto-*` 工作樹 |
| 製作期間使用者修改了專案 | worktree 從最後一次提交建立（啟動時提醒有未提交修改）；合併衝突時改為「需要手動合併」 |
