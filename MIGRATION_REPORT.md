# v0.3 遷移報告

## 1. 資料庫（SQLite，`%APPDATA%\PikaraScienceStudio\studio.db`）

| 版本 | 內容 |
|---|---|
| v1 | 設定、專案、工作、工作事件、環境檢查、監控取樣 |
| v2 | 自動製作（productions、production_events） |
| **v3（新）** | `stage_records`（每集每語言每階段的輸入指紋、輸出、完成時間、是否為舊專案基準）、`asset_versions`（配音／影片的保留版本與候選版本） |

- **只新增資料表**，不修改、不刪除任何既有欄位或資料。
- **遷移前自動備份**：開啟資料庫時，若結構版本低於 v3，先用 `VACUUM INTO` 做一致的快照（包含 WAL 內容）到
  `<資料夾>\backups\studio.db.v2-before-migration-<時間>.bak`，再以唯讀開啟備份做 `integrity_check`，並確認結構版本正確；
  **驗證失敗就不遷移**（Studio 會顯示錯誤，資料庫保持原狀）。每次備份記錄在 `backups\MIGRATIONS.log`。
- **還原**（Studio 必須關閉）：
  ```
  PikaraScienceStudio.exe --cli db-restore --from <備份檔>
  ```
  先驗證備份檔完整，再把目前的資料庫保留為 `studio.db.before-restore-<時間>`，移除 -wal/-shm，最後複製備份。
  「診斷 › 系統狀態」列出所有備份，並可複製每一份的還原指令；也可以按「立即備份資料庫」。
- **與 v0.2.x 相容**：v0.2.1 的程式只執行版本號大於目前版本的遷移，遇到 v3 的資料庫什麼都不做，照常運作（多出來的兩張表不會被讀取）。
  注意：v0.2.1 不認得 `revoice`／`rerender` 工作；如果佇列裡還有這兩種工作時改用 v0.2.1 開啟，它會把這些工作標示失敗（不會執行任何東西）。
  **兩個版本不要同時開啟同一個資料庫。**

### 實測（你的真實資料庫的**複本**；原檔沒有開啟、沒有修改）
經 `\\localhost\C$\…\PikaraScienceStudio` 複製 studio.db／-wal／-shm 到 `out/v03/migration-test/data/`：

| | 結構版本 | integrity | jobs | job_events | metrics | productions | production_events | env_checks | projects |
|---|---|---|---|---|---|---|---|---|---|
| 遷移前 | 2 | ok | 170 | 16190 | 26138 | 8 | 361 | 102 | 1 |
| v0.3 開啟後 | **3** | ok | 170 | 16190 | 26138 | 8 | 361 | 102 | 1 |
| 自動備份檔 | 2 | ok | 170 | 16190 | 26138 | 8 | 361 | 102 | 1 |
| `db-restore` 之後 | **2** | ok | 170 | 16190 | 26138 | 8 | 361 | 102 | 1 |

新增的 `stage_records`、`asset_versions` 初始為空。Rust 測試 `db::tests::v02_database_migrates_with_verified_backup_and_restores` 以相同流程檢查（v2 資料庫 → 備份 → v3 → 再次開啟不重複備份 → 還原回 v2）。

## 2. 舊專案（v0.2 製作的影片）

- **不需要轉換任何檔案。** 第一次在 v0.3 開啟某一集時，若某階段的輸出比它所有輸入檔新，就記錄目前的輸入指紋作為基準（`adopted`）；否則顯示「可能需要更新」。之後的修改都以指紋判斷。
- 配音判斷依每句音檔 `.json` 裡記錄的朗讀文字，v0.2 產生的音檔就有這個欄位，所以舊專案逐句的狀態立刻正確。
- **時間軸格點（一次性）**：v0.3 的 `build_timeline.py` 把句子開始時間與場景切點對齊 0.1 秒（停頓最多長 0.1 秒，聽不出來），場景切點改為「本幕旁白開始 − 停頓的一半」。
  舊的一集**第一次**在 v0.3 重新建立時間軸時，時間會有小幅變動，畫面快取（`out/frames`）因此第一次會完整重新渲染；之後每次只渲染改變的場景。
  不重建時間軸就不受影響。需要完全舊的行為：`PIKARA_TIMELINE_GRID=0`。
- 畫面快取指紋由 v2 改為 v3：v2 的快取在第一次 v0.3 渲染時會被完整重算一次（安全的做法，不會混用新舊畫面）。
- 版本資料夾是新增的：`projects/EPxx/voice/versions/<語言>/<句子>/vNNN.mp3`、`projects/EPxx/output/versions/<名稱>.vNNN.mp4`，以及暫存的 `.studio/revoice|rerender|plan/`（git 已忽略 `.studio/`；`projects/*/voice/`、`projects/*/output/` 本來就被忽略）。

## 3. 設定

`Settings` 沒有新增欄位（v0.2.2 已加入 `voiceTempo`）。介面偏好（外觀、介面語言、開發者設定開關、目前選的集數）存在 WebView 的 localStorage。v0.2 的「進階模式」開關不再使用。

## 4. 正式環境

- `<PROJECT_DIR>`（master）、使用者正在用的 Studio 與它的資料庫：**v0.3 開發與測試期間沒有修改**。
- 要在正式環境使用 v0.3：合併 `dev/v0.3` 到 master（腳本 build_timeline／render.mjs／generate_voiceover_cosy 也要一起更新，Studio 呼叫的是專案裡的腳本），
  以 v0.3 開啟時資料庫會自動備份並遷移。建議先關閉 v0.2.1，並確認佇列裡沒有執行中的工作。
