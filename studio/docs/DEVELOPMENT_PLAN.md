# 明天的開發計畫：EXE v0.1

目標：一天內做出能安裝、能偵測環境、能排隊執行現有管線指令並顯示進度的 Windows EXE。全部在 `<PROJECT_DIR>\studio\` 內進行，**不修改專案根目錄的任何檔案**（腳本、src、package.json、node_modules）。

## 0. 前提（本機實測已確認）

Rust 1.99.1 MSVC、VS Build Tools 2022、Windows SDK 10.0.26100、WebView2 157、Node 26、git、ffmpeg NVENC 都已就緒，**不需要安裝系統軟體**。GPU 可能仍在執行渲染或 TTS，所以開發期間的測試一律不使用 GPU（見 §3）。

## 1. 範圍取捨

| 做 | 不做（延到 v0.2+） |
|---|---|
| Tauri 2 殼層＋NSIS 安裝包 | MSI、程式碼簽章、updater |
| 側欄版面＋6 個頁面（專案、佇列、資源、環境、預覽、設定），腳本頁只做唯讀 | 腳本寫回、AI、發佈 |
| Doctor 只做偵測（不修復） | 自動修復、下載 |
| SQLite（rusqlite）：projects、jobs、job_events、settings、env_checks | 其他資料表只建立 schema，暫不使用 |
| 佇列：依序執行、GPU 租約（同一時間 1 個）、取消、stdout 進度解析 | 排程時段、重試、DAG |
| 包裝的 job：`qa`、`voiceover:check`、`srt`、`typecheck`、`preview`（GPU） | `render` 全片、`tts.cosy` |
| nvidia-smi 輪詢圖表 | NVML、歷史資料 |

## 2. 任務（依序進行，每項都附驗收方式）

1. **建立 Tauri 專案**（30 分）：在 `studio/app` 用 `npm create tauri-app@latest`，選 vanilla-ts。設定 identifier `com.pikara.studio`、productName `Pikara Studio`、`bundle.targets: ["nsis"]`、`bundle.windows.nsis.installMode: "currentUser"`、`webviewInstallMode: downloadBootstrapper`。
   - 驗收：`npm run tauri dev` 開出視窗；`rustc --print host-tuple` 輸出 `x86_64-pc-windows-msvc`。
2. **UI 骨架**（1.5 時）：依 UI_DESIGN.md 的格線、token 與側欄做成 CSS 變數；頁面用 hash 路由。
   - 驗收：側欄 232px，可切換 6 個頁面；色碼與 palette.ts 一致（逐一核對 9 個 token）。
3. **SQLite**（1 時）：在 `src-tauri/src/db.rs` 加入 rusqlite（feature `bundled`），將 ARCHITECTURE §8 的 DDL 放進 `migrations/001_init.sql`，以 `user_version` 管理遷移；資料庫放在 `%APPDATA%\com.pikara.studio\studio.db`。
   - 驗收：第一次啟動時建立資料庫，`PRAGMA user_version`=1，第二次啟動不會重跑遷移；`sqlite3 studio.db ".tables"` 列出全部資料表。
4. **Doctor（偵測）**（2 時）：實作 ENVIRONMENT_SETUP §1 的非 GPU 檢查項目，用 Rust 執行 `std::process::Command`（加上 `CREATE_NO_WINDOW`），結果寫入 `env_checks`。
   - 驗收：在本機的結果與 ENVIRONMENT_SETUP §3 一致（WebView2 157.0.4341.60、Node v26.13.1、ffmpeg 列出 h264_nvenc、LongPaths=0 顯示 ⚠ 並說明會改用短路徑）。把 PATH 中的 ffmpeg 暫時隱藏（設定中改填錯誤路徑）時，必須顯示失敗而不是當機。
5. **Job runner 與佇列**（2.5 時）：Rust 端的 `scheduler.rs` 每 500ms tick 一次，從 `queued` 取出 job；`resource=gpu_exclusive` 時檢查租約，並用 nvidia-smi 檢查 VRAM。若 VRAM 已用大於 1.5GB 且不是 Studio 自己的程序，就標記 `waiting_resource`。執行方式：`cmd /c npm run <script>`，cwd 設為專案目錄，PATH 前置 `C:\Program Files\nodejs`，逐行讀取 stdout/stderr 寫入 `job_events`，並透過 Tauri Channel 推送給 UI。取消：`taskkill /T /F /PID`。
   - 驗收：①依序加入 `typecheck` 與 `qa`，兩者會依序執行，log 即時顯示，exit code 正確記錄 ②`qa` 執行中按取消，job 狀態變成 canceled，`tasklist` 中沒有殘留的 python ③**GPU 正在使用時**加入 `preview`，job 停在 waiting_resource 並顯示原因（**這項測試必須在今晚的 GPU 工作仍在執行時進行，或用設定中「模擬外部 VRAM 佔用」的開發旗標**），不得真的開始渲染。
6. **進度解析**（1 時）：用 regex 比對 render.mjs 輸出的「區段 a–z：…fps」與「渲染 …：N 幀」，算出 progress。
   - 驗收：用錄好的 render log 文字檔（來自既有的 `out/reports/*.json` 或過去的輸出）做單元測試，解析結果正確。不需要實際渲染。
7. **資源頁**（1 時）：每 2 秒執行一次 `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,utilization.encoder,temperature.gpu,power.draw --format=csv,noheader,nounits`，用 Canvas 畫出 5 分鐘折線。
   - 驗收：顯示數值和在終端機手動執行 nvidia-smi 的結果相差在 ±5% 內；沒有 nvidia-smi 時顯示「未偵測到 NVIDIA」。
8. **專案頁＋預覽**（1 時）：開啟資料夾對話框選擇 `<PROJECT_DIR>`，讀取 narration.json 統計幕數與句數，列出根目錄的 `*.mp4` 和 `out/*.mp4`；用 asset protocol 播放（在 `tauri.conf.json` 設定 `assetProtocol.scope`，只允許專案目錄）。
   - 驗收：顯示 75 句（PROGRESS.md 記載為 75 句）；`EP01_Final.mp4` 可以播放與拖曳時間軸。
9. **打包**（45 分）：`npm run tauri build -- --bundles nsis`。
   - 驗收：產生 `*-setup.exe`；在本機安裝到 `%LOCALAPPDATA%`，開始選單出現捷徑，可以啟動並重新偵測環境；解除安裝後不留下程式目錄（資料庫保留在 AppData，這是刻意設計）。
10. **文件**（30 分）：更新 PROGRESS（studio 自己的），記錄實際版本與已知問題。

預估總時數約 12 小時。時間不夠時依序砍掉：7 → 6 → 8 的預覽播放。

## 3. 測試期間的 GPU 安全規則

- 開發期間不執行 `npm run render*`、`gpu:check`、`stills`、`preview`、CosyVoice 或 Whisper。
- 任務 5③ 只驗證「不會啟動」；真正的 GPU job 等使用者確認今晚的工作都結束後，再手動驗收一次 `preview`。
- `typecheck` 與 `qa` 只用 CPU，可以安全執行。`qa` 會讀取 `EP01_Final.mp4`，渲染還在進行時應改用 `preview.mp4`，避免讀到正在寫入的檔案。

## 4. 風險

| 風險 | 機率 | 影響 | 對策 |
|---|---|---|---|
| 今晚的 GPU 工作持續佔用 GPU，導致 GPU 相關驗收無法完成 | 高 | 中 | GPU 驗收改用模擬旗標；實際驗收延後 |
| 第一次 `tauri build` 下載 NSIS 失敗（公司網路、防毒） | 中 | 高 | 預留 1 小時；失敗時手動下載 NSIS 放入 Tauri 快取，或先交付 `tauri build --no-bundle` 產生的 exe |
| Windows 子程序樹殘留（chrome-headless-shell、python） | 中 | 中 | v0.1 用 `taskkill /T`；v0.2 改用 Job Object |
| 中文 stdout 編碼（cp950 與 UTF-8 混雜） | 高 | 低 | 設定 `PYTHONIOENCODING=utf-8`（腳本本身已經 reconfigure），Rust 端用 lossy UTF-8 解碼；npm 透過 cmd 時加上 `chcp 65001` |
| 專案 `qa_video.py` 有未提交的修改，Studio 讀到的狀態和 commit 不一致 | 已發生 | 低 | v0.1 只讀不寫；Doctor 顯示「工作目錄有修改」 |
| Node 26 不是 LTS，使用者機器上的環境會不同 | 中 | 中 | Doctor 只要求 Node 20 以上；CI 用 Node 22 LTS 建置 |
