# Pikara Science Studio

Windows 桌面工具（Tauri 2），把 Pikara Science 的科普影片製作流程（Remotion 動畫、CosyVoice 3 本地配音、Whisper 對齊、混音、GPU 渲染、NVENC 編碼、品質檢查）包裝成可視化、可排程、可中斷恢復的工作台。授權：MIT（僅涵蓋本資料夾的 Studio 程式碼，第三方元件見 `THIRD_PARTY_NOTICES.md`）。

## 下載與執行

- 安裝程式：`dist/Pikara Science Studio_0.1.0_x64-setup.exe`
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

`app/PROGRESS_APP.md`（後端，含測試輸出）、`app/PROGRESS_UI.md`（介面）、`app/API.md`（命令與事件規格，v1.1）、`docs/`（架構、介面、環境、路線圖）。
