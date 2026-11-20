# 研究紀錄（RESEARCH_LOG）

查證日期：2026-11-19。本文件是工程摘要，不是法律意見。「已查證」表示當天實際讀取官方文件、registry 或本機指令的輸出；「未查證」是推論或記憶，使用前要再確認。

## 1. Tauri 2

| 事實 | 來源 | 狀態 |
|---|---|---|
| crates.io 上 Tauri 2.x 最新版：`tauri 2.12.7`、`tauri-build 2.7.6`、`tauri-plugin-shell 2.6.0`、`tauri-plugin-sql 2.6.0`。授權都是 `Apache-2.0 OR MIT`，`rust-version` 1.90 | 本機 `cargo info tauri@2`（等指令） | 已查證 |
| 另有 `tauri 3.0.0-alpha.6` 等 3.x alpha。**本專案固定用 2.x**，不用 alpha | `cargo search tauri` | 已查證 |
| npm 最新版：`@tauri-apps/cli 2.12.6`、`@tauri-apps/api 2.12.5`、`plugin-shell 2.6.0`、`plugin-sql 2.6.0`、`plugin-fs 2.7.1`、`plugin-dialog 2.8.4`、`plugin-notification 2.8.1`、`plugin-updater 2.14.1` | 本機 `npm view <pkg> version` | 已查證 |
| GitHub releases 上最新的是 `tauri-v2.12.7`、`tauri-cli-v2.12.6` | `gh api repos/tauri-apps/tauri/releases` | 已查證 |
| Windows 前置需求：①Microsoft C++ Build Tools（勾選「Desktop development with C++」）②WebView2（Windows 10 1803 以後已內建）③只有建置 MSI 才需要 VBSCRIPT 選用功能 ④Rust 必須用 MSVC 工具鏈，可用 `winget install --id Rustlang.Rustup` 安裝，再執行 `rustup default stable-msvc` | https://v2.tauri.app/start/prerequisites/ | 已查證 |
| 安裝包格式：NSIS 產生 `-setup.exe`，MSI 用 WiX v3 且只能在 Windows 上建置。`webviewInstallMode` 可選 `downloadBootstrapper`（預設，0MB）、`embedBootstrapper`（約 1.8MB）、`offlineInstaller`（約 127MB）、`fixedRuntime`（約 180MB）、`skip`。NSIS `installMode` 可選 `currentUser`（預設，不需系統管理員權限，裝到 `%LOCALAPPDATA%`）、`perMachine`、`both` | https://v2.tauri.app/distribute/windows-installer/ | 已查證 |
| Sidecar 寫在 `bundle.externalBin`。檔名必須加上 `-<target-triple>` 後綴（Windows 為 `name-x86_64-pc-windows-msvc.exe`），triple 用 `rustc --print host-tuple` 查。執行權限：`shell:allow-execute` 或 `shell:allow-spawn` 加上 `"sidecar": true`；`args` 可以是固定陣列、regex validator，或 `true`（任意參數） | https://v2.tauri.app/develop/sidecar/ | 已查證 |
| 官方的 Node sidecar 教學用 `@yao-pkg/pkg`（MIT）把 JS 打包成 exe | https://v2.tauri.app/learn/sidecar-nodejs/ | 已查證 |
| tauri-plugin-sql 以 sqlx 實作，SQLite 用 feature `sqlite` 開啟；用 Rust 的 `Migration` 定義遷移；`sql:default` 只包含 load/select/close，`execute` 要另外授權 `sql:allow-execute`；資料庫路徑相對於 `BaseDirectory::AppConfig` | https://v2.tauri.app/plugin/sql/ | 已查證 |
| `rusqlite` 最新版 0.43.0 | `cargo search rusqlite` | 已查證 |
| 系統監控 crate：`sysinfo 0.40.4`、`nvml-wrapper 0.13.0`；Git：`git2 0.21.0` | `cargo search` | 已查證 |
| `tauri-apps/tauri-action` 最新 release 是 `action-v1.0.0`，授權 MIT。範例需要 `permissions: contents: write`，並提供 `tagName: app-v__VERSION__`、`releaseDraft`、`args` 等輸入 | https://github.com/tauri-apps/tauri-action 、`gh api .../releases/latest` | 已查證 |
| 第一次建置時 Tauri bundler 會自動下載 NSIS／WiX 工具 | 記憶 | **未查證**（明天第一次 `tauri build` 時確認） |
| Updater 簽章用環境變數 `TAURI_SIGNING_PRIVATE_KEY` | 記憶；tauri-action 頁面沒有提到 | **未查證** |

## 2. Remotion（對 MIT 發佈影響最大）

| 事實 | 來源 | 狀態 |
|---|---|---|
| npm 上 `remotion`、`@remotion/cli`、`@remotion/renderer` 最新都是 4.0.545，與本機 node_modules 相同 | `npm view`、本機 package.json | 已查證 |
| Free License 適用對象：個人、員工不超過 3 人的營利組織、非營利組織，以及評估用途。其他人都需要 Company License | https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md | 已查證 |
| LICENSE 禁止為了出售、出租或授權而複製或修改 Remotion 程式碼（"not allowed to copy or modify Remotion code for the purpose of selling, renting, licensing"） | 同上 | 已查證 |
| 價格：Creator 每席每月 $25；Automator 每次渲染 $0.01，最低每月 $100；Enterprise 每月 $500 起 | https://www.remotion.dev/docs/license/pricing.md | 已查證 |
| FAQ：Remotion 是 source-available，不是 open source；任何商業用途都允許，只要不是把 Remotion 本身當產品賣；呼叫 `renderMedia()` 等渲染 API 的程式算「automation」；人數以整間公司計算，不是只算使用 Remotion 的人；客戶若共同操作專案，人數要合併計算 | https://www.remotion.dev/docs/license/faq.md | 已查證 |
| FAQ 沒有直接回答「開源 App 的終端使用者在自己電腦上渲染，是否需要各自取得授權」，官方建議遇到這種情況直接聯絡 Remotion | 同上 | 已查證（官方未明文） |
| 遙測：v4 的 server-side 渲染沒有自動遙測；Remotion 5.0 會讓 Automators 客戶的遙測變成強制。LICENSE 也提到 5.0 的授權條款會調整 | 同上、LICENSE.md | 已查證 |
| Chrome Headless Shell 不會在 npm install 時下載，而是第一次使用時下載到 `node_modules/.remotion/chrome-headless-shell/<platform>/`；可以用 `npx remotion browser ensure` 預先下載；需要連線的網域是 `remotion.media`、`storage.googleapis.com`；可用 `browserExecutable` 指定其他瀏覽器，但官方不建議 | https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell | 已查證 |
| GitHub 偵測 remotion-dev/remotion 的 SPDX 為 `NOASSERTION`（不是 OSI 授權） | `gh api repos/remotion-dev/remotion` | 已查證 |

**結論**：Studio 自己的程式碼可以用 MIT，但 Remotion 不在 MIT 範圍內。repo 和 EXE 都不內含 Remotion，改為安裝時從 npm registry 安裝到使用者電腦，授權關係由使用者自己與 Remotion 成立。安裝流程與「關於」頁要明確提示授權門檻，Automator 計費（自動化渲染）也要提示。官方沒有明文說明的部分，建議 1.0 前寄信請 Remotion 書面確認。

## 3. FFmpeg／NVENC

| 事實 | 來源 | 狀態 |
|---|---|---|
| FFmpeg 本體是 LGPL 2.1+；只要啟用 GPL 元件，整個 FFmpeg 都適用 GPL。符合 LGPL 的檢查清單：不加 `--enable-gpl`、不加 `--enable-nonfree`、動態連結、提供對應原始碼、附上 configure 選項說明、不使用 libx264 等 GPL 函式庫 | https://www.ffmpeg.org/legal.html | 已查證 |
| gyan.dev 的 essentials 與 full build 都是 GPLv3 靜態建置，都包含 nvenc／nvdec／cuvid | https://www.gyan.dev/ffmpeg/builds/ | 已查證 |
| 本機 ffmpeg 9.0.2 gyan full_build 的 configure 有 `--enable-gpl --enable-version3 --enable-nvenc --enable-ffnvcodec --enable-libx264`，**沒有** `--enable-nonfree`。也就是說，啟用 NVENC 不需要 nonfree | 本機 `ffmpeg -version` | 已查證 |
| BtbN/FFmpeg-Builds 提供 gpl、lgpl、nonfree 與各自的 -shared 版本；lgpl 版不含 libx264／libx265；repo 本身是 MIT | https://github.com/BtbN/FFmpeg-Builds | 已查證 |
| BtbN 的 lgpl 版是否包含 NVENC | 頁面沒有寫 | **未查證**（下載後用 `ffmpeg -encoders` 確認） |
| NVIDIA 的官方指南仍把 `--enable-nonfree` 和 `--enable-cuda-nvcc`／libnpp 一起使用；13.1 版建議 CUDA 12.8 以後避免使用 libnpp | https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html | 已查證 |

**結論**：MIT 專案不附帶 gyan 的 GPL 版。GPL 執行檔和 MIT 程式以獨立程序搭配使用，法律上可以，但必須附上對應原始碼與 GPL 全文，合規負擔不值得。改為偵測使用者既有的 ffmpeg，或經使用者同意後從 gyan／BtbN 下載。nonfree 版不得散布。

## 4. Python／語音／對齊

| 事實 | 來源 | 狀態 |
|---|---|---|
| CosyVoice 官方安裝方式：`conda create -n cosyvoice python=3.10`；推薦模型 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`，用 `snapshot_download` 下載；README 沒有 Windows 專用說明 | https://github.com/FunAudioLLM/CosyVoice | 已查證 |
| CosyVoice repo 的授權是 Apache-2.0 | `gh api` | 已查證 |
| Fun-CosyVoice3-0.5B-2512 權重是 Apache-2.0 | `tools/CosyVoice/LICENSES_PIKARA.md`（2026-11-19 調查），https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512 | 引用既有調查 |
| requirements.txt 使用 `--extra-index-url https://download.pytorch.org/whl/cu121`；onnxruntime-gpu 只用於 Linux，Windows 用 CPU 版 `onnxruntime==1.18.0`；deepspeed／tensorrt 只用於 Linux | 本機 `tools/CosyVoice/requirements.txt` | 已查證 |
| 本機 venv：Python 3.10.22（uv）、torch／torchaudio 2.3.1+cu121、faster-whisper 1.2.1、ctranslate2 4.9.0、onnxruntime 1.18.0、modelscope 1.20.0；venv 大小 5.7G | 本機 | 已查證 |
| 模型大小：Fun-CosyVoice3-0.5B 9.1G、whisper large-v3-turbo 1.6G | 本機 `du` | 已查證 |
| faster-whisper 的授權是 MIT | `gh api repos/SYSTRAN/faster-whisper` | 已查證 |
| faster-whisper large-v3-turbo（mobiuslabsgmbh 轉檔）的授權是 MIT | LICENSES_PIKARA.md | 引用既有調查 |
| OpenCC 的授權是 Apache-2.0 | `gh api repos/BYVoid/OpenCC` | 已查證 |
| Noto CJK 的授權是 SIL OFL 1.1（`Sans/LICENSE` 開頭） | `gh api repos/notofonts/noto-cjk/contents/Sans/LICENSE` | 已查證 |
| edge-tts 的程式碼是 LGPLv3（repo 內含 `gpl-3.0.txt`、LICENSE），GitHub SPDX 顯示 NOASSERTION；它呼叫的是非官方 Read-aloud 端點；依 Microsoft Services Agreement §14.s，不得用 AI 服務的資料建立 AI（因此不能拿來當複製聲音的參考音） | LICENSES_PIKARA.md、`gh api repos/rany2/edge-tts/contents` | 引用既有調查與已查證 |
| Common Voice 資料集是 CC0-1.0，但說話者沒有明確同意「被複製聲音後公開發布」；官方規則要求不得嘗試辨識說話者 | LICENSES_PIKARA.md | 引用既有調查 |
| 官方雲端 TTS（例如 Azure Speech）的價格與條款 | — | **未查證**（v0.3 開發 API 語音前再查） |

## 5. Claude Code

| 事實 | 來源 | 狀態 |
|---|---|---|
| `claude -p` 是非互動模式。`--output-format text|json|stream-json`；`json` 包含 `result`、`session_id`、`total_cost_usd`。`--json-schema` 會把結果放在 `structured_output`。成功時 exit 0 | https://code.claude.com/docs/en/headless | 已查證 |
| `--bare` 會跳過 hooks、skills、plugins、MCP、CLAUDE.md 的自動載入，不讀 OAuth，需要 `ANTHROPIC_API_KEY`；用 `--add-dir` 指定的資料夾中 `.claude/skills/` 仍會載入；官方表示它未來會成為 `-p` 的預設 | 同上 | 已查證 |
| 權限：`--allowedTools`（使用規則語法，例如 `Bash(git diff *)`）、`--disallowedTools`、`--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`；v2.1.302 起，沒有設定時 `-p` 從 Manual 模式開始；`--permission-prompts none`（v2.1.259 以上）會在無人看管時直接拒絕需要詢問的操作；另有 `--max-turns`、`--max-budget-usd`、`--no-session-persistence`、`--tools` | 同上；https://code.claude.com/docs/en/cli-reference.md | 已查證 |
| SIGTERM 時 exit 143，並終止執行中 Bash 的程序樹 | headless 頁 | 已查證 |
| Skill 格式：`.claude/skills/<name>/SKILL.md`（專案）或 `~/.claude/skills/<name>/SKILL.md`（個人）。YAML frontmatter 欄位有 `name`、`description`、`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context: fork`、`agent` 等；本文建議 500 行以內；用 `/skill-name` 呼叫，參數為 `$ARGUMENTS` | https://code.claude.com/docs/en/skills.md | 已查證 |
| **第三方產品限制**：除非事先取得核准，Anthropic 不允許第三方開發者在自己的產品中提供 claude.ai 登入或使用其額度（含以 Agent SDK 打造的 agent），應改用 API key | https://code.claude.com/docs/en/agent-sdk/overview.md | 已查證 |
| 品牌：產品可以稱為「Claude Agent」或「{名稱} Powered by Claude」，**不可**稱為「Claude Code」或使用模仿它的視覺元素；SDK 適用 Anthropic Commercial Terms | 同上 | 已查證 |
| 本機 Claude Code 版本：2.1.325 | `claude --version` | 已查證 |

**結論**：Studio 不代替使用者登入 claude.ai。預設路徑是 Studio 偵測使用者自行安裝並登入的 `claude` CLI，而且只在使用者明確啟用後呼叫。散布版的建議路徑是由使用者提供 `ANTHROPIC_API_KEY`，搭配 `--bare`。「呼叫使用者自己已登入的 CLI」是否屬於上述限制，官方沒有明文說明，**待確認**。UI 用語用「AI 助理（Powered by Claude）」。

## 6. 本機工具鏈（read-only 指令，2026-11-19）

詳見 ENVIRONMENT_SETUP.md 的〈本機實測〉一節。

## 7. 無法查證或待確認

1. 開源 App 的終端使用者是否需要各自取得 Remotion 授權：FAQ 沒有明文，需要寄信請 Remotion 確認。
2. 呼叫使用者自己已登入的 `claude` CLI，是否屬於「第三方提供 claude.ai 登入」：需要確認。
3. BtbN lgpl 版是否包含 NVENC。
4. Tauri bundler 是否自動下載 NSIS（明天實測）。
5. Remotion 4.0.545 在 Node 26 上的官方支援狀態：本機實際能跑，但沒有查官方支援矩陣。
6. 官方雲端 TTS 的條款與價格。
