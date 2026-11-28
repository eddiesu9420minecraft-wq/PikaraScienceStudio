# 發布檢查清單（Studio）

v0.3.2 曾經只更新版本號就發布，新版「新影片／製作狀態」頁面卻只存在於開發分支，沒有進入公開倉庫。以下步驟每次發布都要做，任何一步失敗就不發布。

1. **來源完整**：開發分支上所有要發布的 commit 都已進入公開倉庫（用匯出腳本，或逐一比對 `studio/app/src` 與開發分支的差異）。不要從過期的公開倉庫直接改版本號。
2. **路由檢查**：`node studio/app/scripts/check-ui.mjs` — 新影片（`screens/create.js`）與製作狀態（`screens/status.js`）是正式側邊欄區塊、`#/auto` 轉到新頁面、舊的 `screens/auto.js` 不存在。
3. **建置物檢查**：`node studio/app/scripts/check-ui.mjs --exe <PikaraScienceStudio.exe>` — exe 內嵌的前端（`--cli build-info` 的 `frontendSha256`）必須與原始碼 `src/` 完全相同，版本號與 `package.json` 一致。CI 在建置後自動執行。
4. **實際畫面**：正式 exe 在隱藏桌面以介面導覽模式（`PIKARA_UI_TOUR=1`，不執行佇列）、獨立資料夾與獨立 WebView2 設定檔執行，逐頁截圖並與上一版比較；導覽報告的版面問題必須為 0。
5. **資料相容**：以使用者資料庫的**複本**開啟，確認不需要遷移或遷移後資料完整。
6. **雜湊**：發布後 GitHub 資產的 digest、`SHA256SUMS.txt`、重新下載的檔案三者一致。
