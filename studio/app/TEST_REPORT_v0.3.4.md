# v0.3.4 測試紀錄（2026-11-28）

發布：https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/releases/tag/v0.3.4（commit `2f71d6a`）

## 問題與根本原因
- 使用者回報（v0.3.3）：EP16 的 `not found: projects/EP16/output/EP16_Bilibili_zh-CN.mp4` 與 `not found: projects/EP16/docs/EP16_PUBLISH_METADATA.md`。
- 實際檢查：兩個檔案都存在於 `D:\PikaraScience\projects\EP16\`。資料庫（以複本讀取）中 EP16 製作的 `outputs` 是相對於專案根目錄的路徑，專案根目錄 `D:\PikaraScience` 正確；EP16 的製作狀態為 `succeeded`，交付步驟的日誌也正確。
- 原因：`open_path` 用 `Path::new(相對路徑).exists()` 判斷檔案是否存在，等於相對於程序的工作目錄解析。從 CYW 啟動時，工作目錄是 CYW 的 apps 資料夾，不是專案資料夾。
- 另外發現：
  - `ui.js openPath()` 從來沒有帶 `projectId`，單集編輯與素材庫的「開啟資料夾」每次都失敗；
  - 「預覽與發佈」只掃描專案根目錄，看不到 `projects/<EP>/` 的成品；
  - 通知沒有去重。

## 自動測試
- Rust 單元測試 120 項通過（新增 `relative_output_paths_resolve_against_the_project_root_not_the_cwd`）。
- GitHub CI（push main，run 46085871880）：Windows 測試＋建置＋exe 內嵌前端比對、Pipeline TypeScript 檢查都通過。
- `check-ui.mjs --exe`（CI 建置的 exe）：通過，`frontendSha256` 與原始碼一致。

## GUI 回歸（CI 建置的正式 exe）
環境：
- 隱藏桌面執行，不在使用者畫面上開視窗；
- 資料夾是使用者資料庫的**複本**，專案路徑改成實際專案的 git 複本（EP16 成品以硬連結放入）；
- 使用獨立的 WebView2 設定檔；
- `PIKARA_OPEN_DRYRUN`：開啟動作只寫入紀錄，不開 Explorer。

結果：**16/16 通過**。

| 檢查項目 | 結果 |
|---|---|
| `app_info` | 版本 0.3.4、gitCommit `2f71d6a…`、pipelineBundle `79a0ec6fbbb95ad6`（26 個檔案） |
| 回報中的兩個相對路徑 | 皆可開啟，解析到專案資料夾 |
| `..` 路徑 | 被拒絕 |
| 製作狀態 EP16 的 5 個成品按鈕、「開啟輸出資料夾」 | 皆成功，無錯誤通知 |
| 預覽與發佈：影片 | 列出 3 部 EP16 影片 |
| 預覽與發佈：發布資訊 | 讀到 `projects\EP16\docs\EP16_PUBLISH_METADATA.md` |
| 預覽與發佈：開啟與顯示 | 影片、發布資訊與 8 張封面全部成功 |
| 同一錯誤連續 4 次 | 只顯示 1 則通知（×4） |
| 診斷頁 | 顯示 Git Commit、內建與專案的製作腳本版本 |
| JavaScript | 無例外 |

另外確認：`openPath`（單集編輯／素材庫使用）可以開啟存在的資料夾，不存在的資料夾會回報「找不到檔案」。

## 製作腳本同步
- 實際專案，`--check`（唯讀）：22 個待更新，0 個使用者修改過。
- 專案 git 複本，套用：22 個更新，產生 1 個 commit，再檢查為 0；`.studio/pipeline-backup/` 已建立；`make_cn.py` 含 BROKEN 防護。
- 新版 GUI 啟動時，自動對另一個複本完成同步（commit「Studio v0.3.4：更新管線腳本（22 個檔案）」）。

## CYW 安裝與更新（CYW 隔離資料夾）
- 隔離資料夾內先安裝 Studio v0.3.3。
- CYW 偵測到更新 v0.3.4，下載並安裝：GitHub digest 與 SHA256SUMS 都通過；v0.3.3 保留，可回滾。
- 注意：目前已安裝的 CYW v0.1.2-alpha 不支援 `PIKARA_CYW_DATA_DIR`（這個開關在 v0.1.2 之後才加入）。第一次嘗試時，它讀到的是使用者實際的 CYW 狀態。因為使用者的 Studio 正在執行，安裝被延後，沒有下載也沒有寫入（`installed.json`、`downloads.json` 未變更；`update-state.json` 以相同內容重寫）。我在確認後立即停止那個測試程序，改用支援隔離的 CYW 原始碼建置重測。

## 實際製作流程（CYW 安裝的 v0.3.4，獨立資料夾，專案複本）
- `make_cn --seq ep16 --reconvert`：成功。EP16 簡體旁白「什幺」0 處、「什么」7 處。其他集數未重新轉換（依使用者指示，舊集數暫不處理）。
- `qa`（`EP16_Bilibili_zh-CN.mp4`）：成功執行，51 秒。報告列出 10 項提醒：
  - 9 處章節轉場的 0.3 秒黑幀；
  - 長度與時間軸不一致：複本的 `src_cn` 時間軸不是夜間版本的時間軸，屬於測試環境差異，不是成品問題。
- 未測試：需要 GPU 的完整配音與渲染（另一部 EP16 重製工作會實際使用）。

## 未變更
- 使用者正在執行的 Studio（CYW v0.3.3）、實際資料庫與實際專案：測試全程未關閉、未寫入。
