# 用豆包工作操作 Pikara Science Studio（快速接入）

適用：使用 **豆包工作（Doubao Work）桌面客戶端** 的人。不需要 API Key，不需要另外購買 API 額度；使用你自己的豆包帳號。
Studio 不逆向豆包客戶端、不讀取或保存任何登入憑證，也不影響同一台電腦上 Claude Code 的登入。

以下能力都來自豆包工作官方說明（2026-11 查證）：

- 工作任務的 **本地電腦** 模式可存取本機磁碟、執行程式、調用本機工具與技能（〈使用工作任務模式〉）。
- 可 **上傳自訂技能**：資料夾內至少有 `SKILL.md`，開頭是 YAML 格式的名稱與描述（〈使用技能〉）。
- 可新增 **自訂插件（MCP，HTTP 或 STDIO）**（〈使用插件〉）。Studio 目前不需要 MCP，用技能＋命令列即可。
- 另有官方 **豆包 CLI**（`npm install -g @bytedance/doubao-cli`，`doubao login` 掃碼登入，可讀寫檔案與執行命令）（〈快速上手豆包 CLI〉、〈豆包 CLI 命令參考〉）。

有兩種用法，擇一即可：

| | A. 豆包工作桌面版指揮 Studio（推薦給豆包工作使用者） | B. Studio 呼叫豆包 CLI |
|---|---|---|
| 誰做研究、劇本、修正 | 你在豆包工作裡的對話（使用 Pikara Studio 技能） | Studio 自動在背景執行 `doubao -p` |
| 你要做的事 | 在豆包工作說「幫我做一支 XX 的科普影片」，偶爾回答它 | 在 Studio 按「開始製作」，之後不用管 |
| 需要安裝 | 豆包工作桌面版＋上傳技能 | 豆包 CLI（npm）＋登入 |

兩種都需要先完成 Studio 本身的安裝與環境檢查（見 `TUTORIAL.md`）。

---

## A. 豆包工作桌面版 ＋ Pikara Studio 技能

### 1. 上傳技能（一次）

1. 從 Studio 的 GitHub Releases 下載 `pikara-studio-skill.zip`，解壓縮得到資料夾 `pikara-studio`（裡面有 `SKILL.md`）。
   原始碼在 `studio/integrations/doubao-work/pikara-studio/`。
2. 打開豆包工作客戶端 → 左側 **插件·技能·伙伴** → **技能** 頁 → 右上角 **+ 添加** → **上傳技能** → 選 `pikara-studio` 資料夾。

### 2. 開始一支影片

1. 打開 Pikara Science Studio（視窗開著時，配音、渲染等工作會由 Studio 自動執行）。
2. 在豆包工作點 **新工作任務**，運行環境選 **本地電腦**，權限選 **按需確認** 或 **全部允許**。
3. 輸入例如：

   ```text
   用 pikara-studio 技能，在 <PROJECT_DIR> 專案做一支約 2 分鐘的科普影片，主題：為什麼冰塊會浮在水面上。要繁中 YouTube 版和簡中 Bilibili 版。
   ```

4. 豆包會用 Studio 命令列建立製作（`agent = external`），接著：
   - Studio 做到需要 AI 的步驟（研究與劇本、動畫程式、畫面審查、修正、上架文字）時，狀態會變成 **等待 Agent**，並把任務說明寫在工作樹的 `out/auto/AGENT_TASK.md`；
   - 豆包讀任務、修改工作樹裡的檔案，然後執行 `agent-done` 回報；
   - Studio 檢查豆包的成果（旁白格式、字數、資料來源、TypeScript、發音、QA），沒通過會再給一個「修正」任務。
5. 完成後豆包會回報成品路徑；Studio 也會跳出 Windows 通知。**請人工審閱影片與資料來源後再自行發布。**

在 Studio 的「自動製作」頁可以同時看到進度；需要時也能按 **Agent 已完成**、**暫停**、**停止**。

### 常用命令（技能會自動使用，也可以自己在 PowerShell 執行）

```powershell
$S = "$env:LOCALAPPDATA\Pikara Science Studio\PikaraScienceStudio.exe"
& $S --cli auto-status | Out-String                 # 所有製作的狀態與下一步
& $S --cli agent-task --id <id 前 8 碼> | Out-String  # 目前要 Agent 做的事
& $S --cli agent-done --id <id> --note "說明" | Out-String
& $S --cli job-log --id <工作 id> --tail 80 | Out-String
```

注意：Studio 是視窗程式，命令後面要接 `| Out-String` 才會等它結束並拿到輸出；設定請寫成 JSON 檔再用 `--config-file` 傳入（Windows PowerShell 5.1 會吃掉命令列參數中的引號）。

---

## B. 在 Studio 使用豆包 CLI 當 AI 提供者

1. 安裝 Node.js（Studio 環境檢查也需要），然後在 PowerShell 執行（豆包工作官方指令）：

   ```powershell
   npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org/
   doubao --version
   doubao login
   ```

   用豆包或飛書手機版掃描終端機的 QR Code 完成登入。
2. Studio → **自動製作** → **更多選項** → **AI 提供者** 選 **豆包 CLI**（模型可留空＝Auto）→ 按 **測試連線與能力**。
   測試會讓豆包在暫存資料夾實際寫一個檔案並執行 `node --version`；兩項都打勾才代表能讀寫程式碼與調用工具。
3. 按 **開始製作**。Studio 會在隔離工作樹中以
   `doubao -C <工作樹> --permission-mode always_allow -p "<讀取 out/auto/AGENT_TASK.md 並完成>"` 執行每個 AI 步驟，其餘流程與 Claude 相同。

隔離：Studio 不傳任何帳號資訊給豆包 CLI，並在子程序中移除 `ANTHROPIC_API_KEY`／`ANTHROPIC_AUTH_TOKEN`；豆包與 Claude 各自使用自己的登入，互不影響。
豆包 CLI 會讀取工作區 `.claude/skills/` 下的技能（官方說明的掃描路徑之一），所以專案內的 `pikara-video` 技能對豆包同樣有效。

## 常見問題

- **豆包說找不到 Studio**：告訴它 `PikaraScienceStudio.exe` 的完整路徑（安裝版預設在 `%LOCALAPPDATA%\Pikara Science Studio\`）。
- **一直停在「排隊中／製作中」**：Studio 視窗沒開，且沒有人執行 `auto-run`。打開 Studio 即可。
- **出現「另一個 Studio 正在執行佇列」**：同一個資料夾同時只能有一個 Studio（視窗或 `auto-run`）執行工作，關掉其中一個。
- **豆包 CLI 顯示未登入**：執行 `doubao login` 重新掃碼，然後在 Studio 按「繼續」。
- **能不能用雲電脑模式？** 不行：Studio、專案與 GPU 都在你的電腦上，必須用本地電腦模式。
