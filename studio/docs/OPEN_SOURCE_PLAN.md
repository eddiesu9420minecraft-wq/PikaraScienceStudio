# 開源與發佈計畫

工程摘要，不是法律意見。來源見 RESEARCH_LOG.md。

## 1. MIT 的範圍

MIT 只涵蓋 **Studio 自己撰寫的程式碼**：Tauri 殼層（Rust）、UI、runner、Python 包裝腳本、Skills、文件、以及日後抽出的模板程式碼（模板會 `import remotion`，但模板原始碼本身仍可用 MIT 授權）。

不在 MIT 範圍內：Remotion（專有的 Remotion License）、ffmpeg、模型權重、參考音、字型、EP01 的影片素材與腳本（是否另外授權由作者決定，預設不放進 repo）。

## 2. 第三方授權矩陣

| 元件 | 授權 | Studio 是否內含 | 取得方式 |
|---|---|---|---|
| Tauri 2.12 及其 plugins | Apache-2.0 OR MIT | 是（編譯進 EXE） | cargo |
| rusqlite／SQLite | MIT／Public Domain | 是 | cargo（bundled） |
| sysinfo、nvml-wrapper、git2（libgit2） | MIT；MIT/Apache；git2 為 MIT/Apache，但 libgit2 是 GPLv2 with linking exception（記憶，**未查證**） | 是 | cargo。附上 libgit2 的授權全文；若查證有疑慮，改成呼叫系統 `git` CLI |
| **Remotion 4.x** | Remotion License（source-available；個人、3 人以下營利組織、非營利組織免費，否則需要 Company License；自動化渲染屬於 Automator 計費） | **否** | 安裝時在使用者機器上執行 `npm ci`，從 npm registry 安裝，並先要求使用者確認授權提示 |
| Chrome Headless Shell | Chromium（BSD-3 與第三方授權） | 否 | 由 `remotion browser ensure` 下載 |
| React、Three.js、@react-three/fiber | MIT | 否（專案相依，npm 安裝） | npm |
| Node.js | MIT（含第三方） | 否 | 偵測系統上的 Node，或經使用者同意後下載官方 zip |
| **ffmpeg gyan full／essentials** | **GPLv3** | **否** | 偵測，或經使用者同意後透過 winget／下載取得 |
| ffmpeg BtbN lgpl | LGPL | 否（v1.0 前不內含；NVENC 支援未查證） | 下載選項 |
| ffmpeg nonfree 版本 | 不得散布 | 絕不 | — |
| CosyVoice（程式碼）、Matcha-TTS | Apache-2.0；MIT | 否 | 安裝時 `git clone` 鎖定的 commit |
| Fun-CosyVoice3-0.5B-2512 權重 | Apache-2.0 | 否（9.1GB） | 從 Hugging Face／ModelScope 下載 |
| faster-whisper、large-v3-turbo 權重 | MIT | 否（1.6GB） | 從 Hugging Face 下載 |
| PyTorch（cu121 wheel） | BSD-3（CUDA 執行庫另依 NVIDIA EULA） | 否 | pip，從 download.pytorch.org 安裝 |
| OpenCC | Apache-2.0 | 否 | pip |
| edge-tts | LGPLv3；呼叫的是非官方的 Microsoft 端點 | 否 | pip；**預設關閉**，啟用前必須確認風險 |
| Noto Sans TC／SC | SIL OFL 1.1 | 可以（OFL 允許隨軟體散布，不得單獨販售） | v0.1 不內含，由專案 npm／public 提供 |
| Common Voice 參考音 | CC0-1.0（說話者沒有同意聲音被複製） | 否 | 不提供預設聲音，引導使用者錄製自己的聲音 |
| Claude Code CLI | Anthropic 條款 | 否 | 使用者自行安裝；需要 API key 或自己登入 |

## 3. 安裝時必須由使用者下載與確認的項目

1. **Remotion 授權確認**（Sheet，一定要勾選才能繼續）：「Remotion 不是開源軟體。個人、3 人以下的公司、非營利組織可以免費使用；其他組織需要購買 Company License。Studio 的一鍵製作會呼叫 Remotion 的渲染 API，依 Remotion FAQ 屬於『Automator』用途。請閱讀 remotion.dev/license。」確認時間寫入 `licences.acked_at`，「關於」頁永遠顯示這段說明。
2. ffmpeg（GPL）：說明它的授權，以及 Studio 不內含它的原因。
3. 模型權重與 CosyVoice：顯示大小、來源與授權。
4. Edge-TTS：說明非官方端點與 Microsoft 條款的風險，預設不啟用。
5. 聲音：只接受「本人」或「有簽署同意書」作為參考音；CC0 資料集的聲音要標示 ⚠，發佈時檢查清單會提醒。

**待確認**：官方 FAQ 沒有說明開源 App 的終端使用者在自己電腦上渲染時，需要的是哪一類授權。v0.9 前寄信請 Remotion 書面確認，並把回覆附在 repo 的 `docs/legal/`。

## 4. Repo 結構（新 repo：`pikara-science-studio`）

```
.github/workflows/  build.yml（PR：check + test）、release.yml（tag：tauri-action）
app/                Tauri 專案（src/ UI、src-tauri/ Rust）
runner/             runner.mjs、stages/
workers/            Python 包裝腳本、requirements.lock
skills/             pikara-act/、pikara-fix/、pikara-script/（SKILL.md）
templates/          Remotion 模板（v0.5）
examples/           最小範例專案（不含 EP01 的素材）
docs/               本資料夾的文件
LICENSE（MIT）  THIRD_PARTY_NOTICES.md  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md
```

## 5. CI（GitHub Actions）

```yaml
name: release
on: { push: { tags: ['v*'] } }
jobs:
  windows:
    runs-on: windows-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
        working-directory: app
      - uses: tauri-apps/tauri-action@v1
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
        with:
          projectPath: app
          tagName: v__VERSION__
          releaseName: 'Pikara Studio v__VERSION__'
          releaseDraft: true
          args: --bundles nsis
```

- release 一律是 **draft**，由人工核對後再發布。
- 產物只有 Studio 本身，不包含 Remotion、ffmpeg 或模型（CI 中加一個檢查步驟：安裝包中不得出現 `remotion`、`ffmpeg.exe`、`*.safetensors`／`*.pt`）。
- `dtolnay/rust-toolchain` 與 `projectPath` 輸入名稱尚未查證，第一次建立 workflow 時要確認。

## 6. 程式碼簽章

- 未簽章的 EXE 會被 SmartScreen 警告。v0.x 接受這個狀況，並在 README 說明如何驗證 sha256。
- v1.0 候選方案：Azure Trusted Signing 或 OV 憑證（費用與資格**未查證**）。Tauri 提供 Windows 簽章設定（`bundle.windows.signCommand` 等，**未查證**）。
- Updater 的簽章金鑰（`TAURI_SIGNING_PRIVATE_KEY`，**未查證**）存放在 GitHub Secrets，不得放進 repo。

## 7. 貢獻與安全政策

- CONTRIBUTING：PR 必須通過 `cargo clippy`、`cargo test`、`tsc --noEmit`；新增相依套件時要更新 THIRD_PARTY_NOTICES；不接受內含 GPL 二進位檔或模型權重的 PR。
- SECURITY.md：透過 GitHub Security Advisories 私下回報；只支援最新的次版本。
- 安全基線：Tauri capabilities 最小化，前端沒有 shell 和 SQL 權限；asset protocol 只開放專案目錄；CSP 禁止外部 script；API key 存在 Windows Credential Manager，不放進 SQLite；AI 修復只在隔離的 worktree 中進行，並限制工具與預算，合併需要人工核准；**發佈中心不含任何上傳程式碼**。
- 品牌：產品不得以「Claude Code」為名，AI 功能標示為「AI 助理（Powered by Claude）」。
