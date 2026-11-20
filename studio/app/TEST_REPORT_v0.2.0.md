# v0.2.0-alpha 實測紀錄（自動製作模式、AI 提供者、豆包工作）

測試日期 2026-11-20。Windows 11、RTX 4050 Laptop 6 GB。全部為實際執行；原始輸出在專案的 `out/auto-e2e/`、`out/auto-ctl/`、`out/auto-ext/`（不公開，含本機路徑）。

## 1. 端對端：Claude Code（訂閱）從主題做出完整一集 — EP04

設定：主題「顯示卡的 VRAM 是什麼？為什麼在自己電腦跑 AI 模型時 VRAM 這麼重要」、2 分鐘、AI 動畫、YouTube 1.5×＋Bilibili、封面、上架資訊、全部檢查。以 `--cli auto-start`／`auto-run` 執行（與 App 相同的後端）。

| 階段 | 結果 |
|---|---|
| 準備 | 自動分配 EP04（EP01–03 不受影響），建立隔離工作樹與分支 |
| 研究與劇本 | Claude 實際搜尋與讀取 NVIDIA、Hugging Face 官方文件；6 場景 475 字，`EP04_SOURCES.md` 4 個來源並逐句對應 |
| 動畫程式 | Claude 撰寫 `src/acts/ep04/` 6 幕＋共用元件，tsc 通過 |
| 配音＋發音 | 第 1、2 次各有 5、2 句被舊的字元 CER 標記 → Claude 修正 → 第 3 次通過（事後分析：多數是數字寫法與同音字的誤報，已改用拼音比對，見 §4） |
| 時間軸 | 通過 |
| 畫面審查 | 6 張關鍵幀；Claude 找到 1 個 major（場景 2 舊標籤沒有淡出、與新圖重疊）並修正 |
| 繁中正式版 | 第 1 次 QA 5 項（場景交界轉場被算成黑幀）→ Claude 修改轉場 → 重渲染 QA 0 項 |
| YouTube 1.5× / Bilibili | QA 皆 0 項 |
| 封面、上架資訊 | 兩張封面；`EP04_PUBLISH_METADATA.md`（YouTube 繁中、Bilibili 大陸用語） |
| 交付 | 合併分支、成品移到專案根目錄、清除工作樹 |

成品：`EP04_Final.mp4`（182.9 s，1080p30，QA 0）、`EP04_YouTube_zh-TW.mp4`（121.9 s，QA 0）、`EP04_Bilibili_zh-CN.mp4`（118.5 s，QA 0）、3 組字幕、2 張封面、上架資訊、資料來源。
執行時間約 58 分鐘（16:49–17:47，含一次測試環境造成的中斷與續跑）。Claude 執行 9 次。

## 2. 控制與恢復（`out/auto-ctl/`）

| 測試 | 結果 |
|---|---|
| 暫停 | 正在執行的 Claude 工作做完，之後不開始新步驟 ✅ |
| 繼續 | 從下一步接著做 ✅ |
| Studio 被強制結束後重新啟動 | 製作繼續 ✅ |
| 停止 | 工作取消，專案 HEAD 不變 ✅ |
| 捨棄（回復） | 工作樹與分支刪除；`node_modules`（160 項）與 CosyVoice venv 完好 ✅ |
| 兩個程式同時執行同一個佇列 | 第二個被拒絕並顯示說明（排程鎖）✅ |

## 3. 外部 Agent（豆包工作用）— EP05

依 `studio/integrations/doubao-work/pikara-studio/SKILL.md` 逐步操作（由測試者扮演 Agent，完全使用技能裡的 PowerShell 指令）：

| 步驟 | 結果 |
|---|---|
| `auto-start --config-file`（PowerShell 5.1、UTF-8 BOM） | ✅（直接傳 JSON 參數在 PS 5.1 會失敗 → 已改用設定檔並寫進技能） |
| `auto-run` 停在 `waiting_agent`，寫出 `out/auto/AGENT_TASK.md` | ✅ |
| Agent 寫旁白＋3 個已驗證來源 → `agent-done` → 劇本檢查通過 | ✅ |
| 配音：1 句字元差異被拼音比對判定為讀音相符 | ✅ |
| QA 問題 → Agent 修正任務 ×2 → 第 3 次以警告繼續 | ✅（該工作樹使用舊版 QA 腳本；新版已不把場景交界轉場算成問題） |
| 上架資訊（Agent）→ 交付 | ✅ |
| 合併衝突（EP04 已先合併）→ 第一次「需要手動合併」→ 加入集數感知合併後 `auto-resume` 自動解決 | ✅ |

## 4. 單元測試與自我檢查

- `cargo test`：44 通過（含：訂閱模式不設美元上限、額度／未登入偵測、拼音發音比對實例、集數不重複、劇本檢查、階段規劃）。
- 正式版 `PikaraScienceStudio.exe --selftest`：17/17。
- 正式版 exe 不含本機使用者名稱與專案路徑。
- `agent-check --provider claude --deep`：實際寫檔＋執行 `node --version` 通過（19.8 s）。

## 5. 未完成驗證

- **豆包 CLI 提供者**：程式已完成，但本機尚未安裝 `@bytedance/doubao-cli`，且需帳號持有人掃碼登入，所以 `agent-check --provider doubao --deep` 與實際製作尚未執行。
- 豆包工作桌面版實際載入技能與執行：需要在有豆包工作帳號的電腦操作。
