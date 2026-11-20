# v0.1.1-alpha 實測紀錄

測試日期 2026-11-20。環境：Windows 11、RTX 4050 Laptop 6 GB、Studio debug 版（`--cli`）與 release 版（`--selftest`）。每一項都是實際執行，原始輸出保存在專案的 `out/multiep/logs/`（不隨公開倉庫發布，因含本機路徑）。

| # | 測試 | 方法 | 結果 |
|---|---|---|---|
| 1 | 新增集數 ep02、ep03 | `--cli episode-new` | ✅ 建立骨架、驗證通過、自動 git commit |
| 2 | 多集佇列 | `--cli enqueue` 6 個工作（ep02／ep03 配音、ep02／ep03 繁中正式版、ep02 YouTube 1.5×、ep02 Bilibili 簡中）→ `--cli run-queue` | ✅ 全部 succeeded；GPU 工作依序執行（實際以 CosyVoice 3 配音） |
| 3 | 成品 QA | `qa_video.py` 對 EP02_Final、EP03_Final、EP02_YouTube_zh-TW、EP02_Bilibili_zh-CN | ✅ 皆 0 項問題；自動判斷集數、繁／簡時間軸、1.5× 倍速 |
| 4 | 繁簡各自獨立 | make_cn 前後比對 src／src_cn 的旁白、時間軸、Composition 清單 | ✅ 已存在的簡體集數未被覆寫 |
| 5 | 建立新專案（中文＋空白路徑 `out\測試 專案`） | `--cli project-new` → `doctor` → CPU 工作 | ✅ 126 個檔案、git init、CosyVoice 目錄連結；工作成功 |
| 6 | 找不到影片 | 對不存在的 `不存在 的影片.mp4` 排 QA 工作 | ✅ 預檢直接標記失敗，繁中說明 |
| 7 | 損壞的 MP4 | 非影片內容的 `壞掉 的影片.mp4`、截斷的 `截斷 的影片.mp4` | ✅ 「ffprobe 無法讀取…可能已損壞」／「影片檔不完整或已損壞…無法解碼結尾」，結束碼 2 |
| 8 | 缺 ffprobe | 以測試用環境變數 `PIKARA_STUDIO_TEST_HIDE_TOOLS=ffprobe,ffmpeg` 讓 Studio 看不到工具（ffmpeg 未真的移除）後排 QA 工作 | ✅ 「找不到 ffprobe。請安裝 ffmpeg…」，結束碼 2，無 Traceback |
| 9 | Studio 被強制結束 | 渲染中 kill Studio 程序 → 重新啟動 `run-queue` | ✅ heartbeat 過期 → interrupted → 自動重排 → 已完成的渲染區段略過 → 成品 QA 0 項問題 |
| 10 | 渲染器被外部結束（Studio 仍在執行） | 渲染中只 kill `render.mjs` 程序樹 | ✅ 工作 failed，訊息為「步驟『渲染 EP03-30fps』意外結束（結束碼 1）…按『重試』會從這一步繼續」 |
| 11 | 失敗後重試 | 對第 10 項的工作 `--cli job-retry` → `run-queue` | ✅ 「從第 4 步續跑（前 3 步已完成）」→ succeeded → QA 0 項問題 |
| 12 | Rust 單元測試 | `cargo test` | ✅ 37 通過 |
| 13 | 正式版自我檢查 | `PikaraScienceStudio.exe --selftest` | ✅ 16/16 通過（含多集檢查） |

## 已知限制

- EP02、EP03 是驗證多集流程用的短片（約 1 分鐘），使用通用旁白樣板（章節標題＋關鍵詞卡片），畫面遠比 EP01 的手工動畫簡單。
- 第 10 項的錯誤訊息改善（只取失敗步驟的輸出）是在測試中發現並修正的；修正前的輸出保存在 `43a_*.txt`。
