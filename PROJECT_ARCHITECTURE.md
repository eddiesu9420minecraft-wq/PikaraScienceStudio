# Pikara Science Studio v0.3 — 專案架構

## 0. 盤點（開始前）

- 開發工作樹 `<PROJECT_DIR>-v021`，分支 `dev/v0.2.1`（e201e19）沒有未提交的修改；未追蹤的只有 `studio/dist-v0.2.1/`（使用者正在用的發布版，沒有碰）。
- 建立 `dev/v0.3`（從 e201e19），包含 v0.2.2、夜間 Watchdog 修復（d312957…62294dd）、旁白語速修復（e201e19）。
- 正式環境 `<PROJECT_DIR>`（master）、使用者的 Studio 與資料庫：**沒有修改**。所有測試在獨立複本 `<PROJECT_DIR>-v03-e2e`（`git clone` ＋ node_modules／CosyVoice 連結）與獨立資料夾 `out/v03/*-data` 進行。
- 既有測試：Rust 73（v0.2.2）→ v0.3 為 80；Python：watchdog 9、發音 18、語速 19、GPU 故障 10、Studio 配音工作 3。

## 1. 分層

```text
Studio（Tauri 2 應用）                          專案（製片引擎，Remotion＋腳本；每個專案一份）
├─ 前端 src/js（無打包器）                      ├─ src/ src_cn/   動畫、narration.json、timeline.generated.json
│   main.js 8 個區塊；v03/common.js 共用元件     ├─ scripts/       generate_voiceover_cosy.py  build_timeline.py
│   screens/editor.js voice.js …（v0.2 畫面以分頁嵌入）│              mix_audio.py  render.mjs  qa_video.py
├─ Rust 後端 src-tauri/src                      ├─ public/assets/audio/voiceover_cosy[_cn]/<ep>/   配音（目前版本）
│   pipeline.rs   階段、輸入指紋、版本            ├─ projects/EPxx/  BRIEF、docs、scenes、voice/versions、output(+versions)
│   rerender.rs   計畫、逐句修改                 ├─ out/frames/<tag>/  已渲染的幀（場景指紋 v3）
│   jobs/         工作種類 → 腳本步驟             └─ .studio/revoice|rerender|plan/  候選音檔、新影片、試算（git 忽略）
│   queue.rs      佇列狀態機（未改）＋完成後記錄指紋
│   db.rs         SQLite v3（遷移前自動備份）
└─ CLI（同一個 EXE --cli …；佇列步驟也用它做「驗證並切換」）
```

前端**不猜任何路徑**：每一集的階段、檔案位置、時間、狀態、版本都來自 `workspace_get`（`pipeline::workspace`）。

## 2. 階段與依賴（P5）

| 階段 | 輸入（指紋包含的內容） | 改了什麼會失效 |
|---|---|---|
| 腳本 | 這一集的 narration 序列 | — |
| 配音（逐句） | 該句朗讀文字 ↔ 音檔 .json 記錄的 `speak` | 只有文字改過的那一句 |
| 字幕與時間軸 | 每句的字幕、朗讀文字、錨點、停頓、**音檔內容 SHA**；narration 預設值；旁白語速設定；時間格點；build_timeline.py | 任何一句的文字或聲音、語速設定、停頓 |
| 動畫 | `src/` 下所有 .ts/.tsx/.json/.css（同 render.mjs） | 程式碼 |
| 音訊混合 | 時間軸指紋＋使用者配樂＋mix_audio.py | 時間軸、配樂、混音程式（音量常數） |
| 渲染輸出 | 時間軸＋混音＋動畫指紋＋編碼設定（FPS、解析度、編碼器、品質） | 以上任一；**只改編碼設定時畫面全部沿用**（render.mjs 幀快取） |
| QA | 報告時間 vs 成品時間 | 成品更新後 |

- 不相關的設定（例如渲染效能模式）不進任何指紋（`pipeline::tests::text_change_marks_only_that_line_and_downstream`）。
- 上游「需要更新／尚未產生」時，下游最新的階段顯示「上游已變更」。
- 舊專案（沒有紀錄）：第一次開啟時，若輸出比所有輸入檔新，就記錄目前指紋為基準（`adopted`）；之後依指紋判斷。
- 工作成功後（`queue.rs`，最佳努力、不影響工作狀態）記錄該工作消耗的指紋：timeline／mix／final_tw／bilibili／rerender。

### 畫面快取（render.mjs 場景指紋 v3）
- 每個場景的指紋只包含「這個場景看得到的東西」，全部換算成場景內相對時間：共用程式碼、該場景元件、長度、相對錨點、相對句子與字幕（前後 2 秒內跨界的字幕也算）。
- 時間軸對齊 0.1 秒格點（60fps 的 6 幀＝30fps 的 3 幀＝YT15 的 2 幀）；場景切點＝本幕旁白開始 − 腳本停頓的一半，與上一幕的音檔長度無關。
- 因此某一句重新配音、長度改變時：該場景重新渲染；後面的場景整段平移、內容相同，**已渲染的幀搬到新位置沿用**（移動過的場景前後各 0.5 秒邊界幀重算，保險）。位移不是整數幀或內容不同就重算，不會沿用錯誤的畫面。
- `render.mjs --plan [--timeline 試算檔]`：不 bundle、不渲染、不編碼，只輸出 `PLAN_JSON`（每個場景沿用／重算與原因、沿用幀數）。

## 3. 重新配音（P3）

```text
revoice 工作（GPU 鎖）
 1. generate_voiceover_cosy.py --only <句子> --out-root .studio/revoice/<job>   ← 目前的音檔完全不碰
      （同一工作中斷後重跑會沿用已完成的候選；部分失敗仍交給下一步）
 2. PikaraScienceStudio --cli voice-promote --batch <job>
      逐句驗證：文字與腳本一致、長度 ≥ 0.3 秒、Whisper 字元錯誤率 ≤ 0.25（與產生器相同門檻）
      通過 → 先把目前版本複製到 projects/EPxx/voice/versions/<語言>/<句子>/vNNN.mp3(+json)，再換上新版
      不通過 → 保留為候選版本（語音工作室試聽，可「採用」或「不採用」），目前音檔不變，工作標示失敗並說明
```
- 範圍：單句、多句、整個語言版本（空白＝全部）、整集（兩個語言各一個工作）。
- 設定：TTS 引擎（v0.3 只支援 CosyVoice，介面標示）、參考音訊＋逐字稿、語速（倍率 0.85–1.15 或目標字/秒）、語言、「不自動切換」（全部先留給試聽）。
- 還原：`voice_restore`（任何版本或候選；目前版本會先保留成新版本）。
- 不會重新研究、不會改寫腳本、不會動其他句子。

## 4. 重新渲染（P4）

| 模式 | 步驟 | 沿用 |
|---|---|---|
| 僅重新混音和封裝 | 混音 → 編碼（全部幀沿用）→ QA → 切換 | 所有畫面。時間軸會改變時禁止（計畫顯示原因） |
| 重新渲染受影響片段 | 時間軸 → 混音 → 只渲染改變的場景 → 編碼 → QA → 切換 | 未改變與平移的場景 |
| 完整重新渲染 | 同上，`--fresh` | 只沿用配音、腳本 |

- 參數：解析度 1080p／720p、FPS 30／60、編碼器 自動／NVENC／AMF／QSV／CPU、品質 高／標準／草稿、語言版本。輸出位置是該語言的成品檔；舊成品先以硬連結保留到 `output\versions\<名稱>.vNNN.mp4`，新影片渲染並通過 QA 後才取代。
- 開始前的計畫（`rerender_plan`）：用 `build_timeline.py --out` 試算新的時間軸、`render.mjs --plan` 算可沿用的幀；顯示會重跑的階段、沿用的快取、預估時間與 VRAM（來自上一次同一輸出的渲染報告）、會產生的檔案、阻擋原因與警告（例如還有句子沒重新配音）。
- 不會重新配音、研究或寫腳本。

## 5. 穩定性（P6）

- 佇列狀態機、Watchdog、panic 保護、無輸出上限、取消／恢復、重試上限、GPU 監控、程序樹清理：**沒有改動**。新工作只是新的步驟清單；「驗證並切換」是佇列裡的一般步驟（有紀錄、可續跑）。
- 指紋記錄在 `catch_unwind` 內、錯誤只寫事件，不會讓工作失敗或卡住。
- GPU 工作一次一個（同一個 GPU 鎖）。重新配音與重新渲染都宣告 `gpu` 資源。
- 測試（`scripts/test_v03_resilience.py`）：渲染中取消、渲染中整個 Studio 被強制結束後 recover 續跑、配音程序崩潰、整集重新配音。

## 6. 後端 API（v0.3 新增）

Tauri：`workspace_get`、`line_set`、`revoice_start`、`voice_versions`、`voice_restore`、`voice_reject`、`rerender_plan`、`rerender_start`、`db_info`、`db_backup`、`ui_tour_report`。
CLI：`workspace`、`line-set`、`voice-promote`、`voice-versions`、`voice-restore`、`output-promote`、`rerender-plan`、`db-backups`、`db-backup`、`db-restore`。
工作種類：`revoice`、`rerender`。

## 7. 修改的檔案

- Rust：`pipeline.rs`（新）、`rerender.rs`（新）、`db.rs`（遷移 3、備份／還原）、`jobs/steps.rs`、`jobs/kinds.rs`、`queue.rs`（完成後記錄指紋）、`cli.rs`、`lib.rs`、`Cargo.toml`／`tauri.conf.json`（0.3.0、最小寬度 720）。
- 腳本：`build_timeline.py`（格點、場景切點、`--out`）、`render.mjs`（場景指紋 v3、`--plan`、`--timeline`、`--quality`）、`generate_voiceover_cosy.py`（候選資料夾、部分成功）。
- 前端：`index.html`、`css/tokens.css`、`css/app.css`（顏色改 Token）、`css/v03.css`（新）、`js/main.js`、`js/v03/*`（新）、`js/screens/{dashboard,projectsx,editor,queuex,voice,assetsx,settings,diagnostics}.js`（新）、`queue.js`、`icons.js`、`i18n/zh-CN.js`（重新產生）。
- 測試：`scripts/test_v03_e2e.py`、`scripts/test_v03_resilience.py`、`scripts/ui_tour_capture.ps1`、`studio/app/tests/check_imports.mjs`，Rust 測試 7 個。

## 8. 硬體層（v0.3 後半新增）

HardwareManager（`hardware/native.rs`、`manager.rs`）、DeviceSelector（`hardware/selector.rs`）、ResourceScheduler（`gpulock.rs`＋`scripts/gpu_lock.py`）、
驗證（`hardware/usage.rs`）、介面 GPU（`hardware/launch.rs`）。佇列依 DeviceSelector 的分配取得各 GPU 租約（不同 GPU 上的工作可同時執行），
每個工作步驟的環境變數帶入渲染 GPU、編碼器、VRAM 上限與 CUDA 裝置。詳見 `HARDWARE.md`，實測見 `TEST_REPORT.md` §6–7。
