# Pikara Science Studio

[English](README.en.md) ｜ 繁體中文

把「AI 科普動畫影片」的整條製作流程，包成一個 Windows 桌面工作台：劇本與旁白編輯、Claude Code 協作、本地配音（CosyVoice 3）、Whisper 字詞對齊、動畫與字幕同步、GPU 渲染、NVENC 編碼、品質檢查，以及可中斷恢復的無人值守工作佇列。

> **v0.1.1-alpha**：公開測試版（多集支援、QA 錯誤修正，見 [CHANGELOG](CHANGELOG.md)）。功能可用，但仍有已知限制（見下方），請勿用於無法承受錯誤的正式工作。

## 包含什麼

| 資料夾 | 內容 |
|---|---|
| `studio/` | Pikara Science Studio 桌面程式原始碼（Tauri 2 + Rust 核心 + HTML 介面）與設計文件 |
| `pipeline/` | 影片製作範本專案：Remotion（React + Three.js）動畫、旁白資料、配音／對齊／混音／渲染／QA 腳本。Studio 開啟的「專案資料夾」就是它 |

## 快速入門

### 1. 安裝 Studio

到 [Releases](../../releases) 下載 `Pikara Science Studio_0.1.1_x64-setup.exe` 並安裝（或下載免安裝的 `PikaraScienceStudio.exe`）。需要 Windows 10/11 64 位元；安裝程式會在需要時下載 Microsoft WebView2。

### 2. 準備範本專案

```powershell
git clone https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio.git
```

範本專案在 `PikaraScienceStudio\pipeline`。

### 3. 首次啟動

1. 開啟 Studio → 左側 **專案** → 輸入 `pipeline` 資料夾的完整路徑 → **加入專案**。
2. 左側 **環境醫生** → **重新檢查**。標示「可自動修復」的項目按 **修復**（例如安裝 Remotion 相依套件、下載 Chrome Headless Shell）；其餘項目會顯示需要手動執行的指令。
3. 確認狀態後，到 **製作** 選擇工作（例如只執行 QA 或渲染），按 **加入佇列**，在 **佇列** 與 **監控** 看進度。

### 必要與選用環境

| 元件 | 用途 | 安裝方式 |
|---|---|---|
| Node.js 20+ | Remotion 渲染、腳本 | 手動安裝（nodejs.org） |
| Python 3.11 | 時間軸、混音、QA 腳本 | 手動安裝 |
| ffmpeg（含 h264_nvenc） | 編碼、混音、檢查 | 手動安裝（例如 `winget install Gyan.FFmpeg`）。GPL 版本，本專案不隨附 |
| NVIDIA 顯示卡＋驅動 | GPU 渲染（ANGLE）、NVENC、CosyVoice CUDA | 選用；沒有時可用 CPU 相容模式 |
| CosyVoice 3（Python 3.10 venv＋模型） | 本地配音 | 手動安裝，步驟見 `studio/docs/ENVIRONMENT_SETUP.md`；模型權重需自行下載 |
| Claude Code CLI | 提示詞執行、協作修改 | 選用；使用你自己的帳號或 API 金鑰 |

## 主要功能（v0.1.1）

- **專案**：註冊專案資料夾，列出劇本版本、成品影片與 git 狀態。
- **劇本編輯**：繁體與簡體旁白各自編輯（字幕、朗讀文字、動畫錨點、停頓），即時驗證，存檔自動 git commit，可試聽已產生的旁白。
- **提示詞**：依專案實際內容產生 Claude 提示詞；可在隔離的 git worktree 以 Claude Code 執行，檢視差異後手動合併或捨棄。
- **製作與佇列**：YouTube 繁中 1.5× 版、Bilibili 簡中版，以及配音、時間軸、混音、渲染、QA 單一步驟；SQLite 持久化佇列，一次一個 GPU 工作並偵測外部 GPU 程式，心跳監控，中斷後自動重新排入。
- **多集與新專案**：集數選擇器與「新增集數」；輸出檔名由集數推得（`EP02_Final.mp4` 等）；沒有手工動畫的集數使用通用旁白樣板；可從範本建立新專案（支援中文與空白路徑）；無視窗命令列 `--cli`。
- **監控**：即時 CPU、RAM、GPU 使用率、VRAM、溫度、功耗、時脈、NVENC。
- **環境醫生**：17 項實測檢查與安全的自動修復。
- **預覽與發布中心**：影片播放、ffprobe 資訊、封面、上架文字一鍵複製。**沒有任何上傳程式碼，發布一律由你手動完成。**
- **回滾**：列出 git checkpoint，可 revert，或（輸入確認字樣並自動建立備份分支後）reset。

## 已知問題（v0.1.1-alpha）

- 新集數只有通用旁白樣板（章節標題＋關鍵詞卡片）；精緻動畫仍需自行撰寫 React 元件（或透過提示詞頁交給 Claude Code）。
- 沒有資料夾選擇視窗，專案路徑需手動輸入。
- 取消工作以 `taskkill /T /F` 結束程序樹；失敗的工作不會自動重試，按「重試」會從失敗的步驟繼續。
- CosyVoice 安裝與模型下載尚未自動化。
- 安裝程式與 exe 尚未程式碼簽章，Windows SmartScreen 可能顯示警告。

## 授權

- 本倉庫自行撰寫的程式碼與文件：**MIT**（`LICENSE`）。
- 第三方元件保留原授權，**不因本倉庫而變成 MIT**，詳見 `THIRD_PARTY_NOTICES.md`。重點：
  - **Remotion** 使用自有授權（非開源）：個人、≤3 人營利公司、非營利組織免費；其他需要 Company License，自動化渲染另有條款。Remotion 不包含在本倉庫或安裝程式中，使用前請閱讀 <https://www.remotion.dev/license>。
  - 字型 Noto Sans TC／SC：SIL Open Font License 1.1（`pipeline/public/fonts/OFL.txt`）。
  - ffmpeg、CosyVoice 模型權重、Whisper 模型、Chrome Headless Shell：不隨附，由使用者自行下載並遵守其授權。
  - 配音參考人聲請使用你本人或取得明確同意者的錄音。

## 文件

- `studio/README.md`：Studio 功能與建置方式
- `studio/docs/`：架構、介面設計、環境設定、路線圖、開源計畫
- `pipeline/README.md`：影片製作流程與指令
- `CHANGELOG.md`：版本紀錄
