# macOS 版本（Apple Silicon 優先，Intel 視相容性）

> 狀態（2026-11-27）：分支 `feat/cross-platform`。macOS 程式碼已能在 GitHub macOS runner 編譯與執行單元測試（結果見 TESTING.md §4）。**還沒有在 Mac mini M2 真機上跑過完整製作流程**——下列「待真機」項目都不能當成已可用。

## 1. 目標與原則

- 整條製作流程（研究 → 腳本 → 分鏡 → 動畫 → 配音 → ASR → 字幕對齊 → 混音 → 渲染 → 硬體編碼 → QA → 封面 → 匯出）都要在 macOS 真的跑完，不是只有一個能開啟的 DMG。
- 不為了小或快而選音質較差的模型。每個選擇都要有同一批測試句的實測結果（§3）。
- Apple Silicon 是統一記憶體：CPU、GPU、ANE 共用同一個記憶體池。Studio 不把它當成 VRAM，不套用獨顯的 VRAM 公式（`hardware::profile`）。
- VideoToolbox（影片編碼）與 Chromium WebGL 走 Metal（畫面渲染）是兩件不同的事，分開實測、分開報告。

## 2. 平台對應

| 功能 | macOS 實作 | 狀態 |
|---|---|---|
| 資料 | `~/Library/Application Support/PikaraScienceStudio`（studio.db、logs、backups）；快取 `~/Library/Caches/PikaraScienceStudio`；GPU 租約 `~/Library/Caches/PikaraScience` | 已改，CI 驗證中 |
| 程序樹 | 子程序以自己的 process group 啟動；取消＝SIGSTOP 整棵樹後 SIGKILL 群組與所有後代；暫停／繼續＝SIGSTOP/SIGCONT | 已改，CI 驗證中 |
| 單一佇列鎖 | `flock`（Rust `File::try_lock`；Python `fcntl.flock`，兩者互通） | 已改 |
| 防睡眠 | `/usr/bin/caffeinate -i -w <Studio pid>`（Studio 結束時自動釋放） | 已改，待真機 `pmset -g assertions` |
| 工具搜尋 | PATH + `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`（Finder 啟動的 App 的 PATH 很短） | 已改，待真機 |
| 硬體 | `sysctl`（Apple Silicon／Intel、Rosetta、P/E 核心、記憶體）＋ `system_profiler SPDisplaysDataType -json`（GPU、核心數、Metal 家族；Intel Mac 的 AMD 獨顯 VRAM） | 已改，單元測試＋CI |
| 加速器 | `scripts/accel_probe.py`：torch MPS、MLX 各做一次真實矩陣乘並比對 CPU 結果 | 已改；CI arm64 VM：MLX Metal 可用（809 GFLOPS），MPS 在 VM 中不可用 |
| 編碼 | `h264_videotoolbox`／`hevc_videotoolbox`，`-allow_sw 0`，每次 1 秒 720p60 試編碼＋ffprobe 驗證；失敗退回 libx264/libx265 | **CI（arm64 VM）實測可用**：h264／hevc_videotoolbox 真實編碼通過；Intel VM 不可用並正確退回 libx264；真機待測 |
| 渲染 | Remotion + chrome-headless-shell（`mac-arm64`／`mac-x64`），`--gl=angle`（ANGLE → Metal） | CI arm64 VM：1080p30 90 幀實際渲染成功（3.2 fps，VM 3 核）；WebGL renderer 字串待下一次 CI；真機 FPS 待測 |
| 套件 | `.app` + `.dmg`（`tauri.macos.conf.json`，最低 macOS 12），**未簽章、未公證** | CI 建置中 |

## 3. 語音（TTS）候選與 A/B 測試計畫

### 3.1 候選（第一輪清單，全部「待真機測試」）

| 候選 | 執行方式 | 為什麼列入 | 已知風險 | 授權（需再核對官方 LICENSE） |
|---|---|---|---|---|
| **A. CosyVoice 3（官方 PyTorch）＋ MPS** | 現有 `generate_voiceover_cosy.py`，`PYTORCH_ENABLE_MPS_FALLBACK=1` | 與 Windows 同一個模型、同一個參考聲音 → 音色與克隆一致，現有發音字典、CER 檢查直接沿用 | 部分運算不支援 MPS 會退回 CPU；`ttsfrd` 沒有 macOS wheel（退回 wetext 正規化，數字／單位念法可能改變） | 程式 Apache-2.0；模型依 FunAudioLLM 模型卡 |
| **B. CosyVoice 3（官方 PyTorch）CPU fp32** | 同上，`PIKARA_AI_DEVICE=cpu` | 現有程式已支援，品質與 GPU 相同 | 慢；需要量測 M2 上的 chars/s | 同上 |
| **C. CosyVoice 3 MLX 移植** | 社群移植：mlx-audio PR #861（未確認是否已合併）、mlx-audio-plus、Hugging Face 上的 8-bit／4-bit 轉換權重（含 zero-shot 克隆用的 S3 tokenizer） | 可能最快、最省記憶體，同一個模型家族 | 非官方；量化（4-bit／8-bit）可能降低音質 → **優先測 8-bit／未量化，不因為小就選 4-bit** | 移植碼與權重各自授權，需逐一核對 |
| **D. Qwen3-TTS（MLX 版，0.6B／1.7B Base）** | mlx-audio 或 qwen3-tts-mlx | 支援參考音訊克隆，中文品質口碑佳 | 與 Windows 音色不同（兩平台輸出不一致）；台灣腔未知 | 第三方頁面寫 Apache-2.0，需核對 QwenLM 官方 |
| **E. speech-swift（MLX／CoreML，含 CosyVoice3）** | Swift 原生 | 免 Python | 要另寫橋接；成熟度未知 | 需核對 |

Edge-TTS（舊版線上語音）不列入：需要網路、不能克隆、不符合「本機製作」。

### 3.2 測試方法（`scripts/voice_ab.py`）

- 測試句固定在 `scripts/voice_ab_texts.json`：繁中短句、台灣口語語氣、技術詞（GPU／CPU／CUDA／Transformer）、數字、數學、單位、中英混合、長文（穩定性與速度漂移）、簡中三句。
- 同一個參考聲音、同一段參考文字；每個候選是一個外部指令（某個候選當掉不影響其他候選）。
- 自動量測：每句牆鐘時間、音訊長度、RTF、chars/s、整棵程序樹的峰值 RSS、結束代碼；ASR（優先 mlx-whisper，否則 faster-whisper）算 CER，繁簡先以 OpenCC 摺疊（臺／台不算錯）。
- 人工：產生 `listen.md` 盲聽評分表（檔案以 S001… 匿名，對照表另存 `listen.key.json`），評自然度、台灣腔、克隆相似度、停頓節奏、術語念法。
- 選擇規則：先排除 CER 明顯較高或長文不穩定者；剩下的依盲聽分數排序；速度與記憶體只在音質相當時才決定勝負；授權不允許商用或再散布者不得成為預設。

### 3.3 記憶體與批次

- 安全批次由 `hardware::profile::budget` 給上限（`PIKARA_TTS_BATCH_MAX`）：可用預算＝(實體記憶體 − 系統保留 4 GiB，省電 6 GiB) × 模式比例；模型常駐估 5 GiB（CPU／MPS fp32），每句再估 600 MiB。M2 16 GB 平衡模式 → 約 4 句；8 GB → 1 句。這些常數必須用 voice_ab.py 的峰值 RSS 校正（BENCHMARK.md）。
- 已驗證的音訊永不重新產生（沿用現有快取鍵與版本機制）；暫停＝SIGSTOP（模型留在記憶體）；取消／重配音／單句重試沿用佇列機制。

## 4. ASR／字幕

| 候選 | 字級時間戳 | 備註 |
|---|---|---|
| faster-whisper（CTranslate2）CPU int8 | 有（與 Windows 同一套程式碼） | macOS 沒有 Metal 後端；作為基準與備援 |
| mlx-whisper（large-v3／turbo） | 有（`word_timestamps=True`） | Metal；需確認中文字級時間戳與 faster-whisper 的差距 |
| whisper.cpp（Metal／CoreML） | 權杖級；字級需額外處理 | 速度快；整合成本較高 |

驗收：同一批音檔比較 CER、字級時間戳與 faster-whisper 的平均／最大差（毫秒）、整集字幕時間軸不可漂移；保留現有字幕格式與時間軸規則；繁簡不同字不可被判為錯誤。

## 5. 編碼與渲染驗收（真機）

- `node scripts/hwenc.mjs` h264／hevc 全部候選實測；VideoToolbox 必須 `works: true` 才使用。
- `node scripts/gpu-check.mjs --force`：WebGL renderer 字串必須是 Apple GPU（不是 SwiftShader）。
- 1080p30 整集渲染：記錄 FPS、編碼速度、CPU／記憶體峰值、A/V 同步（`qa_video.py`）、分段續傳（中途取消再繼續）。

## 6. 套件、簽章、公證

- CI 產出 `PikaraScienceStudio-macos-arm64-NOT-NOTARIZED`、`…-x64-NOT-NOTARIZED`：沒有 Apple Developer 憑證，Gatekeeper 會擋，第一次開啟需右鍵 → 打開（或 `xattr -dr com.apple.quarantine`）。
- Apple 公證 ≠ Pikara 更新簽章：前者讓 macOS 信任 App；後者（minisign，Pikara release key）讓 Studio／CYW 信任更新檔。兩者獨立。
- CYW 目錄期待 macOS 資產名稱含 `_aarch64`／`_x64`；Tauri 的 `.app.tar.gz` 預設不含架構，發佈時要改名（ROADMAP P11）。

## 7. 需要使用者協助的項目

1. **Mac mini M2 存取**（例如 SSH），才能做 §3–§5 的真機測試與 BENCHMARK。
2. 是否把 Pikara release 簽章金鑰加到 Studio repo 的 Actions secrets（啟用簽章發佈）。
3. 是否申請 Apple Developer Program（公證；付費）。

參考：[mlx-audio CosyVoice3 PR](https://github.com/Blaizzy/mlx-audio/pull/861)、[CosyVoice3 MLX 8-bit 權重](https://huggingface.co/aufklarer/CosyVoice3-0.5B-MLX-8bit-full)、[speech-swift](https://github.com/soniqo/speech-swift)、[mlx-whisper](https://pypi.org/project/mlx-whisper/0.2.0)、[qwen3-tts-mlx](https://github.com/suckerfish/qwen3-tts-mlx)、[mlx-audio](https://github.com/Blaizzy/mlx-audio)。
