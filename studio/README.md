# Pikara Science Studio

Windows 桌面工具（Tauri 2），把 Pikara Science 的科普影片製作流程（Remotion 動畫、CosyVoice 3 本地配音、Whisper 對齊、混音、GPU 渲染、NVENC 編碼、品質檢查）包裝成可視化、可排程、可中斷恢復的工作台。授權：MIT（僅涵蓋本資料夾的 Studio 程式碼，第三方元件見 `THIRD_PARTY_NOTICES.md`）。

## 下載與執行

- 安裝程式：`dist/Pikara Science Studio_0.2.0_x64-setup.exe`
- 免安裝：`dist/PikaraScienceStudio.exe`
- 自我檢查（不開視窗，輸出 JSON）：`PikaraScienceStudio.exe --selftest`

## 功能（v0.1）

| 畫面 | 功能 |
|---|---|
| 專案 | 註冊專案資料夾，列出劇本版本、輸出影片、git 狀態 |
| 劇本編輯 | 編輯 `narration.json`（繁）與 `src_cn/data/narration.json`（簡）：字幕、朗讀文字、錨點、停頓；即時驗證；存檔自動 git commit；試聽現有旁白 |
| 提示詞 | 依實際專案內容產生 Claude 提示詞；偵測 Claude Code CLI，於隔離 git worktree 執行，檢視 diff 後手動合併／捨棄 |
| 製作 | 一鍵 YouTube（繁中 1.5×）、Bilibili（簡中）及單一步驟（配音、時間軸、混音、渲染、QA） |
| 佇列 | SQLite 持久化工作佇列、一次一個 GPU 工作（偵測外部 GPU 程序）、心跳、中斷自動重排、取消整個程序樹、無人值守設定 |
| 監控 | 即時 CPU、RAM、GPU 使用率、VRAM、溫度、功耗、時脈、NVENC |
| 環境醫生 | 17 項實測檢查；安全項目一鍵修復，系統層級設定只給操作說明 |
| 預覽與發布 | 影片播放、ffprobe 資訊、封面、`PUBLISH_METADATA.md` 一鍵複製。**沒有上傳程式碼，發布一律由人手動完成** |
| 回滾 | 最近的 git checkpoint，revert 或（需輸入確認字樣、先建備份分支的）reset |

## v0.1.1：多集與新專案

- **集數**：每一集是 `narration.json` 的 `sequences.epNN`。「劇本編輯」與「製作」都有集數選擇器；「新增集數」會建立一段一句的骨架（驗證後存檔並 git commit），之後在劇本編輯寫完整旁白。
- 所有工作都帶 `episode` 參數，指令與輸出檔名由集數推得（`EP02_Final.mp4`、`EP02_YouTube_zh-TW.mp4`、`EP02_Bilibili_zh-CN.mp4`、`EP02.srt`）。新的一鍵管線「繁中正式版」（`final_tw`）。
- 沒有手工動畫的集數使用通用旁白樣板（章節標題＋由錨點驅動的關鍵詞卡片）。
- 繁體與簡體旁白各自管理：make_cn 不再覆寫已存在的簡體集數。
- **建立新專案**（「專案」頁）：從目前專案的管線範本複製 scripts／src／字型／package.json 到新資料夾（可含中文與空白），重設為只有 ep01 骨架並 git init；可用目錄連結共用 CosyVoice。
- 工作開始前的預檢：缺 ffmpeg／ffprobe、找不到影片、沒有這一集、沒有 src_cn 時，工作直接標記失敗並顯示繁體中文說明。
- 無視窗命令列：`PikaraScienceStudio.exe --cli <episode-new|episode-list|project-new|doctor|enqueue|run-queue|jobs|job-retry|job-cancel|recover>`。
- 測試紀錄：`app/TEST_REPORT_v0.1.1.md`。

## v0.2.0：自動製作

- **自動製作**（預設首頁）：輸入主題、長度、風格、輸出平台 → 開始製作；研究、劇本、動畫程式、配音、字幕、渲染、QA、封面、上架資訊全部自動完成，失敗自動修正重試，全部通過才合併。設計與規則見 `app/API.md` §11、`docs/DEVELOPMENT_PLAN.md`。
- **AI 提供者**：Claude Code（訂閱，預設）、豆包 CLI、外部 Agent（豆包工作＋`integrations/doubao-work/pikara-studio` 技能，說明 `docs/DOUBAO_WORK.md`）。
- 一般／進階模式、使用教學頁與第一次啟動導覽。
- 測試紀錄：`app/TEST_REPORT_v0.2.0.md`。

## 啟動畫面（Pikara 統一啟動畫面）

啟動時先顯示與 Create Your World 共用的 Pikara 啟動畫面，列出真實的初始化步驟（資料庫、工作佇列恢復、背景服務、專案、環境檢查）；失敗時提供重試／開啟資料夾／結束等選項，不會卡住。共用套件是 vendored 副本：`app/vendor/pikara-splash`（Rust）與 `app/src/vendor/pikara-splash`（前端），來源與雜湊記錄在 `app/pikara-splash.vendor.json`。**不要直接修改副本**：請在 CreateYourWorld 的 `crates/pikara-splash` 修改後執行 `node <CYW>/crates/pikara-splash/sync.mjs --to studio/app`；`node app/vendor/pikara-splash/sync.mjs --check app` 可檢查副本。實測結果：`app/TEST_REPORT_splash.md`。

## 從原始碼建置

需求（本機已驗證）：Rust 1.99（MSVC）、VS Build Tools 2022、WebView2、Node 26。

```powershell
cd studio\app
npm install
npm run tauri build
```

## 不隨附、需使用者自行安裝的元件

Remotion（自有授權：個人與 ≤3 人公司免費，其餘需購買；自動化渲染另有條款）、ffmpeg（gyan 版為 GPL）、Chrome Headless Shell、CosyVoice 3 模型權重、Whisper 模型。詳見 `THIRD_PARTY_NOTICES.md` 與 `docs/OPEN_SOURCE_PLAN.md`。

## 開發紀錄

`app/PROGRESS_APP.md`（後端，含測試輸出）、`app/PROGRESS_UI.md`（介面）、`app/API.md`（命令與事件規格，v1.2）、`docs/`（架構、介面、環境、路線圖）。
