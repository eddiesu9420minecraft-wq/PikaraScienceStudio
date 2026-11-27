# 架構（跨平台）

```
studio/app/src            前端（純 ES module，WebView2／WKWebView／WebKitGTK）
studio/app/src-tauri/src
  platform/               ← 所有作業系統差異都在這裡
    mod.rs                路徑（資料／快取）、exe 名稱、venv、which、PATH、獨佔鎖、防睡眠、檔案管理員、容器偵測
    process.rs            ProcessManagerBackend：程序樹 kill／pause／resume、子程序設定
  hardware/               HardwareDetectionBackend
    native.rs             Windows：DXGI／D3D12／CUDA driver API
    apple.rs              macOS：sysctl + system_profiler
    manager.rs            依平台建立 Snapshot（快取、重新偵測）
    selector.rs           UI／渲染／AI／編碼裝置分配（CUDA、Apple GPU、CPU）
    encoders.rs           VideoEncoderBackend 的 Rust 端（實測試編碼）
    profile.rs            MachineProfile + 功率模式預算（省電／平衡／高效能／自訂）
  queue.rs                佇列、排程、心跳、停滯監控、取消／暫停／繼續
  db.rs                   SQLite（WAL、版本、online backup、遷移鎖）
pipeline/scripts          製作腳本（各自是子程序）
  render.mjs + hwenc.mjs  RenderBackend（Remotion/Chromium）＋ VideoEncoderBackend（hw_encoders.json）
  generate_voiceover_cosy.py  VoiceBackend（CosyVoice 3）＋ SpeechRecognitionBackend（Whisper）
  accel_probe.py          AI 加速器實測
  voice_ab.py             TTS 候選 A/B
  gpu_lock.py             全機 GPU 租約（與 gpulock.rs 互通）
```

## 統一介面

後端的「實作」大多是子程序腳本，所以統一介面定義在程序邊界上，而不是為了好看重寫成 Rust trait：

| 介面 | 輸入 | 輸出／進度 | 取消／暫停／續跑 | 錯誤 |
|---|---|---|---|---|
| ProcessManagerBackend（Rust `platform::process`） | 一個 PID（程序樹根） | 處理了幾個程序 | `kill_tree`／`suspend_tree`／`resume_tree`；全部有逾時上限 | 字串說明，不 panic |
| HardwareDetectionBackend（`hardware::manager` + `profile`） | — | `Snapshot`、`MachineProfile`、`Budget` | — | `Snapshot.error`；偵測有 15–20 秒上限 |
| VideoEncoderBackend（`hw_encoders.json`） | 編碼器 id、模式（final／preview） | 實測結果 `{works, ms, error}` | 失敗自動換下一個候選 | 每個候選獨立 |
| RenderBackend（`render.mjs`） | 合成名稱、幀範圍、模式 | stdout 進度行（Parser::Render）、報告 JSON | 分段續傳；取消＝kill_tree；暫停＝suspend_tree | 結束代碼 + 最後幾行 |
| VoiceBackend（`generate_voiceover_cosy.py`） | 句子 JSON、語系、裝置（`PIKARA_AI_DEVICE`）、批次上限（`PIKARA_TTS_BATCH_MAX`） | 每句檔案 + meta（CER）、stdout 進度（Parser::Voice） | 快取鍵避免重做；暫停保留常駐模型 | OOM 重試、每句重試 |
| SpeechRecognitionBackend | 音檔、語言 | 句／字級時間戳 | 同上 | CER 檢查 |
| RuntimeBackend | `platform::python311`、`node_program`、`default_cosy_python`、`util::tool` | 可執行檔路徑 | — | doctor 檢查 |

環境變數是腳本與 Studio 之間的契約：`PIKARA_PERF`、`PIKARA_RENDER_TARGET`、`PIKARA_RENDER_GPU_LUID`（只在 Windows）、`PIKARA_RENDER_MAX_CONC`、`PIKARA_AI_DEVICE`（`gpu`／`apple`／`cpu`）、`CUDA_VISIBLE_DEVICES`、`PIKARA_TTS_BATCH_MAX`、`PIKARA_CPU_THREADS`、`PIKARA_MEM_BUDGET_MIB`、`PIKARA_LOW_PRIORITY`、`PIKARA_ENCODER`、`PIKARA_VRAM_CAP`。

## 暫停的資料流

```
UI「暫停」→ job_pause → Queue::pause
   寫入 <data>/paused/<job id>     ← 跨程序可見（視窗、--cli run-queue）
   suspend_tree(pid)               ← NtSuspendProcess／SIGSTOP 整棵樹
run_step 停滯監控：看到標記 → 重設停滯計時，不殺程序
run_job：標記存在時不開始下一步
「繼續」→ resume_tree → 刪除標記
「取消」→ 刪除標記 → kill_tree（被暫停的程序也能被結束）
```

資料庫 schema 不變（status 仍是 `running`；`Job.paused` 由標記計算），所以舊版 Studio 開啟同一個資料庫不受影響。

## 資料庫遷移

```
open(path)
  版本已是最新 → 直接開啟
  否則 → 取得 <db>.migrate.lock（最多等 60 s）→ 重新讀版本
        → online backup API 備份 + integrity_check + 版本驗證（失敗就不遷移）
        → 每個 migration：BEGIN IMMEDIATE → 交易內再檢查版本 → 執行 → COMMIT
restore：scheduler.lock 被持有（Studio 在執行）→ 拒絕
```
