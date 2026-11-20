# Pikara Science Studio 路線圖

原則：每個里程碑都要有能安裝的 EXE 和可重複執行的驗收測試。功能的事實依據見 RESEARCH_LOG.md，技術設計見 ARCHITECTURE.md。

## v0.1「能開、能看、能排隊」：明天（詳見 DEVELOPMENT_PLAN.md）

- Tauri 2.12 殼層，提供 NSIS `currentUser` 安裝包，Apple 風格的側欄版面。
- 開啟既有專案 `<PROJECT_DIR>`（唯讀解析 narration.json 與輸出檔）。
- Environment Doctor：只做偵測，不修復（以下各項通過或失敗都正確顯示：OS、WebView2、NVIDIA、Node、Remotion、chrome-headless-shell、ffmpeg NVENC 編碼器清單、Python 3.11／3.10、CosyVoice venv、模型、磁碟、git）。
- 工作佇列：SQLite＋單一 GPU 租約，把現有 npm script 包裝成 job（`qa`、`voiceover:check`、`srt`、預覽渲染），擷取 stdout 並解析進度，提供取消（`taskkill /T`）。
- 資源監控：每 2 秒執行一次 `nvidia-smi --query-gpu`（v0.2 改用 NVML）。
- 預覽：播放 `EP01_Final.mp4` 等既有輸出。
- 不包含：AI、修復、排程、編輯寫回、發佈。

## v0.2「腳本編輯與一鍵產生」（約 1 週）

- 腳本編輯器寫回 narration.json，保留鍵順序並自動 git commit（checkpoint）。
- 逐句試聽：播放既有的 mp3。單句重生：`--only <id> --force`。
- 繁／簡切換：執行 make_cn.py，對照顯示兩個 locale。
- runner.mjs 的 job DAG 取代 finalize.sh，「一鍵製作」zh-TW 全片。
- render.mjs 與 cosy 腳本的 Studio 版本（複製到 `studio/workers`，新增 `--json-progress`、`--project-root`、`--no-gpu-wait`），原專案腳本保留不動。
- Doctor 的 A 級自動修復：短路徑瀏覽器、py311 venv。

## v0.3「語音與排程」（約 2 週）

- 語音設定檔：CosyVoice（本機）、Edge（實驗功能，必須勾選風險確認）、API 語音（先查證條款與價格，再選擇供應商）。
- 錄製自己的參考音並保存同意紀錄；語速 0.5–2.0 與 `--target-cps` 校準。
- 無人值守排程：時段、防止睡眠、重試、續傳、開機後恢復佇列。
- Doctor 的 B 級修復：下載 ffmpeg、Node、模型、CosyVoice venv，並顯示大小、來源與授權。
- 時間軸檢視：錨點位置與 still 渲染。

## v0.4「AI 助理與自動修復」（約 2 週）

- Skill 套件 `studio/skills/`：`pikara-act`（依照 STYLE／AGENT_BRIEF 製作一幕）、`pikara-fix`（依失敗 log 修復）、`pikara-script`（改稿與錨點建議）。
- 「產生提示詞」與「交給 AI 助理」：`claude -p` 在隔離的 git worktree 中執行，限制工具與預算，產生 diff 後由使用者核准再合併。
- 失敗分類器與「交給 Doctor／交給 AI」路由。
- 效能建議：依 renders 歷史資料調整 concurrency 與 chunk。
- 回滾 UI：checkpoint 列表、revert、reset（需要二次確認）。

## v0.5「模板化」（約 3 週）

- 從 EP01 抽出 `templates/`（3D 顯示卡、矩陣、資料點轉場、字幕、品牌）與 `episode.manifest.json`。
- 新集數精靈：主題 → AI 產生大綱與腳本 → 選擇模板 → 預覽。
- make_cn 改成 locale 層，不再複製整棵原始碼樹。

## v0.9「發佈中心與開源準備」

- 發佈檢查清單、發佈包匯出、手動發佈後回填網址（**永遠不自動上傳**）。
- 開源前清理：移除 EP01 的私有素材，或另外授權；整理 THIRD_PARTY_NOTICES；寄信請 Remotion 確認授權解讀。
- GitHub Actions 建置 Windows EXE（tauri-action@v1，產生 draft release）。

## v1.0「穩定版」

- 全新 Windows 11 機器上，從安裝到產出第一支影片 ≤ 60 分鐘（不含模型下載時間）。
- 在 RTX 4050 6GB 上連續無人值守完成 EP01 繁簡雙版，失敗可續傳。
- 程式碼簽章（見 OPEN_SOURCE_PLAN §6）、updater、SECURITY.md、貢獻指南。
- 自動化測試：Rust 單元測試（scheduler、db）、runner 協定測試、UI 冒煙測試。
