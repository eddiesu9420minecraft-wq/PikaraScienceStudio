# Pikara Science Studio

[English](README.en.md) ｜ 繁體中文

輸入一個主題，自動做出一支 AI 科普動畫影片的 Windows 桌面工作台：資料研究、劇本、動畫程式、本地配音（CosyVoice 3）、Whisper 發音檢查、字幕、GPU 渲染、NVENC 編碼、自動品質檢查與修正、封面與上架文字，並輸出繁中 YouTube 版與簡中 Bilibili 版。

> **v0.2.1-alpha**：新增影片內容控制（全自主／指導／自訂腳本）、輸出語言（繁、簡、繁＋簡、英文）、素材匯入、即時工作監控、每部影片獨立資料夾與 Sandbox、環境自動修復（見 [CHANGELOG](CHANGELOG.md)）。**本版未完成完整測試**，請先閱讀 `studio/app/TEST_REPORT_v0.2.1.md` 與下方〈已知限制〉，成品發布前務必人工審閱。

## 包含什麼

| 資料夾 | 內容 |
|---|---|
| `studio/` | Pikara Science Studio 桌面程式原始碼（Tauri 2 + Rust 核心 + HTML 介面）、設計文件、`integrations/doubao-work/`（豆包工作技能） |
| `pipeline/` | 影片製作範本專案：Remotion（React + Three.js）動畫、旁白資料、配音／對齊／混音／渲染／QA 腳本。Studio 開啟的「專案資料夾」就是它 |

## 快速入門

### 1. 安裝 Studio

到 [Releases](../../releases) 下載 `Pikara.Science.Studio_0.2.1_x64-setup.exe` 並安裝（或下載免安裝的 `PikaraScienceStudio.exe`）。需要 Windows 10/11 64 位元；安裝程式會在需要時下載 Microsoft WebView2。可用 Release 附的 `SHA256SUMS.txt` 核對檔案。

### 2. 準備範本專案

```powershell
git clone https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio.git
```

範本專案在 `PikaraScienceStudio\pipeline`（必須是 git 倉庫；自動製作在隔離的 git 工作樹中進行）。

### 3. 首次啟動

1. 開啟 Studio，第一次會顯示快速導覽。
2. 左側 **環境** → **重新檢查**。標示「可自動修復」的項目按 **修復**；其餘項目會顯示需要手動執行的指令。
3. 左側 **專案** → 輸入 `pipeline` 資料夾的完整路徑 → **加入專案**。
4. 安裝並登入 AI 提供者（擇一）：
   - **Claude Code**（預設）：安裝後在終端機執行 `claude` 登入你的帳號。
   - **豆包 CLI**：`npm install -g @bytedance/doubao-cli`，再執行 `doubao login` 掃碼（豆包工作官方說明）。
   - **豆包工作桌面版**：上傳 `pikara-studio-skill.zip` 中的技能，見 `studio/docs/DOUBAO_WORK.md`。
5. 左側 **自動製作** → 輸入主題、選長度與風格、勾選輸出平台 → **開始製作**。完成後會收到 Windows 通知，成品放在專案資料夾。

單一步驟工具（劇本編輯、提示詞、配音、渲染、佇列、回滾）在側欄下方的 **進階模式**。

### 必要與選用環境

| 元件 | 用途 | 安裝方式 |
|---|---|---|
| Node.js 20+ | Remotion 渲染、腳本 | 手動安裝（nodejs.org） |
| Python 3.11 | 時間軸、混音、QA 腳本 | 手動安裝 |
| ffmpeg（含 h264_nvenc） | 編碼、混音、檢查 | 手動安裝（例如 `winget install Gyan.FFmpeg`）。GPL 版本，本專案不隨附 |
| NVIDIA 顯示卡＋驅動 | GPU 渲染（ANGLE）、NVENC、CosyVoice CUDA | 選用；沒有時可用 CPU 相容模式 |
| CosyVoice 3（Python 3.10 venv＋模型） | 本地配音 | 手動安裝，步驟見 `studio/docs/ENVIRONMENT_SETUP.md`；模型權重需自行下載 |
| Claude Code CLI 或 豆包 CLI | 自動製作的研究、劇本、動畫程式與修正 | 使用你自己的帳號登入；Studio 不要求、不保存 API Key 或帳號資訊 |

## 主要功能（v0.2.0）

- **自動製作（Autonomous Production Mode）**：一鍵從主題到成品。自動分配集數（不覆蓋既有作品）、在隔離 git 工作樹中依序完成研究與劇本 → 動畫程式 → 配音與發音檢查 → 時間軸 → 關鍵幀 AI 畫面審查 → 繁中正式版 → YouTube 1.5× → Bilibili 簡中 → 封面 → 上架資訊 → 交付。每個階段建立 git checkpoint；檢查失敗會交給 AI 修正並重試（有次數與時間上限）；全部通過才自動合併，失敗時專案完全不變，可一鍵捨棄回復。可暫停、繼續、停止；Studio 關閉或當機後重開會接著做。
- **AI 提供者**：Claude Code 訂閱模式（預設，不設美元上限，達到用量上限自動暫停並保存進度，不會切換付費 API）、Claude API 付費模式（必須設定每次上限）、**豆包官方 CLI**、**外部 Agent**（例如豆包工作桌面版＋Pikara Studio 技能，透過 Studio 命令列 `agent-task`／`agent-done` 協作）。不同提供者的登入互不影響。
- **自動品質檢查與除錯**：旁白格式與字數、資料來源數量、TypeScript、Whisper 拼音比對發音、關鍵幀畫面審查、黑幀／靜音／音量／字幕 QA；失敗原因與日誌自動交給 AI 修正。
- **Bilibili 簡中版**：OpenCC＋中國大陸科技術語表（顯存、內存、英偉達…），大陸配音，簡中封面與上架文字。
- **命令列**：`PikaraScienceStudio.exe --cli auto-start|auto-run|auto-status|agent-task|agent-done|agent-check|job-log|…`。
- 既有功能：劇本編輯（繁／簡）、提示詞與 Claude 工作樹、SQLite 持久化佇列（GPU 鎖、心跳、中斷恢復）、即時資源監控、環境醫生、預覽與發布中心（**沒有任何上傳程式碼，發布一律由你手動完成**）、git 回滾。

## 已知限制（v0.2.1-alpha）

- **v0.2.1 的新功能大多沒有端到端實測**（內容控制的劇本階段與需求檢查已實際跑過；英文、僅簡中渲染、素材在畫面中的使用、增量渲染、環境自動修復等未驗證）。
- **仍為 Alpha 測試版本。** 成品請人工審閱影片內容與資料來源後再自行發布。
- **豆包 CLI 尚未使用真實帳號實際測試**（程式已完成；連線與能力測試需帳號持有人掃碼登入）。
- **豆包工作桌面客戶端尚未實機驗證**；技能＋命令列流程已依技能內容逐步操作、完成模擬端到端測試（由測試者扮演 Agent）。
- **完整使用教程尚未完成**（目前有程式內「使用教學」頁、`studio/docs/DOUBAO_WORK.md`）。
- 新集數若使用「通用樣板」只有章節標題＋關鍵詞卡片；「AI 動畫」品質取決於 AI 提供者，已有 tsc 與畫面審查把關，仍可能需要人工調整。
- 同一個資料夾同時只能有一個 Studio（視窗或 `--cli auto-run`）執行佇列。
- 沒有資料夾選擇視窗；CosyVoice 安裝與模型下載尚未自動化；安裝程式與 exe 未程式碼簽章，SmartScreen 可能顯示警告。

## 授權

- 本倉庫自行撰寫的程式碼與文件：**MIT**（`LICENSE`）。
- 第三方元件保留原授權，**不因本倉庫而變成 MIT**，詳見 `THIRD_PARTY_NOTICES.md`。重點：
  - **Remotion** 使用自有授權（非開源）：個人、≤3 人營利公司、非營利組織免費；其他需要 Company License，自動化渲染另有條款。Remotion 不包含在本倉庫或安裝程式中，使用前請閱讀 <https://www.remotion.dev/license>。
  - 字型 Noto Sans TC／SC：SIL Open Font License 1.1（`pipeline/public/fonts/OFL.txt`）。
  - ffmpeg、CosyVoice 模型權重、Whisper 模型、Chrome Headless Shell、Claude Code、豆包 CLI：不隨附，由使用者自行安裝並遵守其條款。
  - 配音參考人聲請使用你本人或取得明確同意者的錄音。

## 文件

- `studio/README.md`：Studio 功能與建置方式
- `studio/docs/DOUBAO_WORK.md`：豆包工作／豆包 CLI 快速接入
- `studio/docs/`：架構、介面設計、環境設定、開發計畫、路線圖、開源計畫
- `studio/app/TEST_REPORT_v0.2.0.md`：實測紀錄
- `pipeline/README.md`：影片製作流程與指令
- `CHANGELOG.md`：版本紀錄
