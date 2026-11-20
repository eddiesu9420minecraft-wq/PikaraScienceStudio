---
name: pikara-studio
description: 用 Pikara Science Studio 製作科普動畫影片（繁中 YouTube 與簡中 Bilibili 版）。當使用者要做科普影片、建立影片任務、修改影片腳本或旁白、查詢影片製作進度、處理製作錯誤或取得影片成品時使用。需要在「本地電腦」模式執行。
---

# Pikara Science Studio（豆包工作用）

Pikara Science Studio 是本機的科普影片製作程式。配音（CosyVoice）、時間軸、混音、GPU 渲染、品質檢查與封面由 Studio 自動完成；
**研究、劇本、動畫程式、畫面審查、修正與上架文字由你（豆包工作）完成**。你和 Studio 之間只透過 Studio 的命令列溝通。

## 必要條件

- 任務必須在 **本地電腦** 模式執行（需要讀寫本機檔案、執行命令）。權限建議「按需確認」或「全部允許」。
- 使用者的電腦已安裝 Pikara Science Studio，並在 Studio 的「專案」頁加入過影片專案資料夾（git 倉庫）。
- 不要上傳、發布影片；不要修改 Studio 程式本身；不要動 `node_modules`、`tools\CosyVoice`（目錄連結）。

## 找到 Studio

在 PowerShell 依序檢查，取第一個存在的路徑當作 `$S`：

```powershell
$S = @("$env:LOCALAPPDATA\Pikara Science Studio\PikaraScienceStudio.exe", "$env:ProgramFiles\Pikara Science Studio\PikaraScienceStudio.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$S
```

找不到就請使用者告訴你 `PikaraScienceStudio.exe` 的位置。**每次呼叫都要接 `| Out-String`**（Studio 是視窗程式，接管線 PowerShell 才會等它結束並收到輸出）：

```powershell
& $S --cli auto-status | Out-String
```

所有指令都輸出 JSON。結束碼 0 = 成功。**不要把 JSON 直接當命令列參數傳**（Windows PowerShell 5.1 會吃掉引號），一律先寫成檔案再用 `--config-file`／`--file` 傳入。

## 製作一支影片（主要流程）

1. **確認專案資料夾**：問使用者影片專案資料夾（例如 `<PROJECT_DIR>`）；之後叫它 `$P`。
2. **建立製作**（`agent` 一定要是 `external`，代表 AI 工作由你做）：

   ```powershell
   $cfgFile = "$env:TEMP\pikara_config.json"
   @{ topic = "主題"; minutes = 2; style = "generic"; agent = "external"; youtube = $true; bilibili = $true } | ConvertTo-Json | Set-Content -Encoding UTF8 $cfgFile
   & $S --cli auto-start --project $P --config-file $cfgFile | Out-String
   ```

   - `style`：`generic` = 通用旁白樣板（只需要你寫劇本，最快）；`ai` = 你還要為每個場景寫 React 動畫元件。
   - **影片內容控制（Studio v0.2.1）**：
     - `mode`：`auto`（全自主，預設）、`guided`（指導：必須遵循使用者的要求）、`script`（自訂腳本：使用者腳本逐字成為旁白，不得改寫）。
     - `brief`：「影片內容與製作要求」，Markdown 原文照抄使用者的話。
     - `chapters`：章節名稱陣列（依序）；`mustInclude`、`mustAvoid`：每行一項；`opening`、`ending`、`voiceTone`、`animationStyle`、`pacing`：文字。
     - `scriptText`：自訂腳本（`## 章節` 分段）。
     - `language`：`zh-TW`、`zh-CN`（直接用簡中腳本製作 Bilibili 版，不先做繁中）、`both`、`en`。
     - `assets`：素材陣列 `[{"source": "C:\\完整路徑\\截圖.png", "kind": "image", "note": "說明"}]`；`kind` 可省略（依副檔名判斷），可用 `text`、`pdf`、`image`、`video`、`recording`、`music`、`script`、`reference`。
     - `sandbox`：`true` = 測試（TEST 編號，成品在 `sandbox/`，不合併）。
     - 使用者的要求一律寫進這些欄位（Studio 會存進任務資料庫，並在每一個 AI 步驟的任務說明中附上），不要只放在對話裡。
   - 其他選項：`thumbnail`、`publishInfo`、`visualReview`、`pronunciationCheck`（布林）、`maxAttempts`、`maxMinutes`、`twCps`（繁中語速，字／秒）、`minSources`（最少資料來源數）。
   - 回傳的 `id` 記下來（下面叫 `$ID`），`episode` 是 Studio 自動分配的集數，不會覆蓋既有集數。
3. **推進製作**：重複執行下面的迴圈，直到狀態是 `succeeded`、`failed` 或 `canceled`。

   ```powershell
   & $S --cli auto-status --id $ID | Out-String
   ```

   依 `status` 處理：

   | status | 你要做的事 |
   |---|---|
   | `queued`／`running` | Studio 正在做配音、渲染等。**Studio 視窗開著**時它會自己執行，你每 1–2 分鐘查一次即可；Studio 視窗沒開時，執行 `& $S --cli auto-run \| Out-String`（會一直執行到需要你或完成為止，可能要數十分鐘）。 |
   | `waiting_agent` | 輪到你：執行 `& $S --cli agent-task --id $ID \| Out-String`，照 `prompt` 完成任務（見下節），完成後執行 `& $S --cli agent-done --id $ID --note "做了什麼" \| Out-String`。 |
   | `paused_limit`／`paused` | 讀 `message`，告訴使用者原因；處理後 `& $S --cli auto-resume --id $ID \| Out-String`。 |
   | `failed` | 讀 `message`；需要細節時看工作日誌 `& $S --cli job-log --id <job id> --tail 80 \| Out-String`。說明原因，修正後 `auto-resume`（會重試失敗的階段）。 |
   | `needs_merge` | 成品已交付，但原始碼合併衝突；告訴使用者到 Studio 處理。 |
   | `succeeded` | 回報 `outputs`（影片、字幕、封面、上架資訊、資料來源）的完整路徑，提醒使用者**人工審閱後再自行發布**。 |

## 完成 Agent 任務（status = waiting_agent）

`agent-task` 會給你 `workdir`（隔離的 git 工作樹）、`taskFile`（同內容的說明檔）與 `prompt`。規則：

- **所有檔案操作都在 `workdir` 裡**，不要改專案資料夾本身；不要 git commit（Studio 會建立檢查點）。
- 依任務類型：
  - **劇本**：用網路搜尋做研究，寫 `<EP>_SOURCES.md`（至少 3 個真實可開啟的來源網址；自訂腳本模式不強制），並在 `src/data/narration.json` 的 `sequences.<ep>` 寫入旁白。格式與限制都在 prompt 裡；JSON 保持 2 空格縮排、UTF-8，不要動其他集數。prompt 開頭的【使用者的製作要求】必須遵守；`out/auto/BRIEF.md` 是同一份要求，`out/auto/ASSETS.md` 是素材清單（素材在 `public/user/<ep>/`）。
  - **動畫程式**（style = ai）：在 `src/acts/<ep>/` 寫元件並登錄到 `src/episode/registry.ts`，完成後在 workdir 執行 `node node_modules/typescript/bin/tsc --noEmit --pretty false` 直到沒有錯誤。
  - **畫面審查**：查看列出的 PNG，把結果寫到 `out/auto/review.json`。
  - **修正**：prompt 會附上錯誤與日誌，修正原因即可。
  - **上架資訊**：寫 `<EP>_PUBLISH_METADATA.md`。
- **不要執行渲染、配音或任何 GPU 指令**，Studio 會排程。
- 內容正確性優先：不得虛構數據、規格或引文。
- 做不到時：`& $S --cli agent-done --id $ID --failed --note "原因" | Out-String`。

Studio 收到 `agent-done` 後會自動檢查你的成果（旁白驗證、字數、資料來源、TypeScript、發音、QA 等）。沒通過時會再出現 `waiting_agent`，這次是「修正」任務，附上錯誤原因。

## 其他常用指令

| 用途 | 指令 |
|---|---|
| 所有製作的狀態 | `& $S --cli auto-status \| Out-String` |
| 即時監控（目前工作、渲染 FPS／幀數／剩餘時間、AI 輸出、來源、檔案變更、錯誤與修復紀錄） | `& $S --cli auto-monitor --id $ID --brief \| Out-String` |
| Python／CosyVoice 環境診斷與安全修復 | `env-venv --project $P`；`env-venv --project $P --repair`（只複製解譯器、不下載、不動套件） |
| 暫停／繼續／停止 | `auto-pause`／`auto-resume`／`auto-stop --id $ID` |
| 捨棄失敗的製作（刪除工作樹，專案不受影響） | `auto-discard --id $ID` |
| 讀取或修改專案中某一集的旁白（不在製作中時） | `narration-get --project $P --episode ep02`；`narration-set --project $P --episode ep02 --file seq.json`（會先驗證，再存檔並 git commit） |
| 列出集數 | `episode-list --project $P` |
| 檢查環境 | `doctor --project $P` |
