# Pikara Science Studio 架構

版本：草案 v0.1（2026-11-19）。技術事實的來源見 RESEARCH_LOG.md。

## 1. 設計原則

1. **檔案是內容的唯一真實來源**：`narration.json`、Remotion 樣板與 act 程式碼都放在專案的 git repo 裡。SQLite 只存索引、狀態、工作佇列與設定。git 回滾就等於內容回滾。
2. **管線程式不重寫，先包裝**：沿用現有的 Python／Node 腳本，由 runner 呼叫並把輸出轉成 JSON 事件。
3. **GPU 是排他資源**：同一時間只允許一個佔用 GPU 的工作，由 Rust 排程器發放租約（lease）。
4. **發佈一定要人工核准**：程式裡沒有任何「自動上傳」的程式路徑。
5. **最小權限**：WebView 不能直接執行 shell 或 SQL；所有副作用都經由 Rust command，並以白名單限制。

## 2. 程序模型

```
┌──────────────────────── Pikara Studio.exe（Tauri 2.12） ────────────────────────┐
│  WebView2 UI（HTML/TS，Apple 風格）                                               │
│    │ invoke('cmd', args) ／ Channel<Event>（進度串流）                           │
│    ▼                                                                             │
│  Rust Core                                                                       │
│   ├ db        rusqlite（WAL）：projects/jobs/job_events/…                        │
│   ├ scheduler 佇列、優先序、GPU 租約、排程時段、重試、續傳                         │
│   ├ doctor    環境偵測與修復（ENVIRONMENT_SETUP.md）                              │
│   ├ monitor   nvml-wrapper（GPU/VRAM/NVENC/溫度）＋ sysinfo（CPU/RAM/Disk）      │
│   ├ vcs       git2：checkpoint、分支、revert                                      │
│   └ procs     spawn／kill 程序樹（Windows Job Object），stdout 逐行解析            │
└─────┬───────────────────────────────────────────────────────────────────────────┘
      │ spawn（一個 job 對應一個程序），stdin：job JSON；stdout：JSONL 事件
      ▼
┌── runner（Node ≥20，studio/runner/runner.mjs） ──┐
│  stage 執行器：bundle／render／encode／qa／…      │
│  呼叫 Remotion CLI、ffmpeg、Python worker          │
└─────┬───────────────────┬─────────────────────────┘
      ▼                   ▼
 Python 3.11 worker     CosyVoice venv（Python 3.10 + torch cu121）
 edge-tts、build_timeline   generate_voiceover_cosy.py（TTS＋faster-whisper 對齊）
 mix_audio、music、qa、make_cn
      │
      ▼
 ffmpeg（使用者系統上的 NVENC 版）、chrome-headless-shell（由 Remotion 下載）

 選用：claude CLI（-p，使用者自行安裝；Skill 目錄 studio/skills/）
```

- **為什麼 Rust 不直接呼叫腳本，而是經過 Node runner**：Remotion 本來就需要 Node 與 node_modules；runner 統一處理 stage 之間的相依、暫存檔、進度換算，Rust 只負責管理程序與存事件。runner 是純 `.mjs`，用偵測到的 Node 執行，**v0.1 不用 pkg 打包成 sidecar**（Remotion 仍需要完整的 Node，打包也省不掉）。
- **程序管理**：每個 job 放進一個 Windows Job Object，取消時終止整棵程序樹（render.mjs 會產生 chrome-headless-shell 子程序）。v0.1 若還沒時間做 Job Object，先用 `taskkill /T /F /PID`。
- **Tauri 權限**：v0.1 不啟用 `tauri-plugin-shell` 的前端執行權限。spawn 由 Rust 的 `std::process::Command` 進行，指令從程式內白名單產生。前端只取得 `core:default`、`dialog`（開啟資料夾）、`notification`。

## 3. 檔案配置

```
Studio 安裝目錄（NSIS currentUser → %LOCALAPPDATA%\Programs\PikaraStudio）
  PikaraStudio.exe
  resources/runner/  runner.mjs, stages/*.mjs
  resources/workers/ *.py（Studio 自己的 Python 包裝）
  resources/skills/  pikara-*/SKILL.md
  resources/licenses/ THIRD_PARTY_NOTICES.md

App 資料（%APPDATA%\com.pikara.studio）
  studio.db（SQLite）、logs/、settings

工具與模型（%LOCALAPPDATA%\PikaraStudio\  ← 短路徑，避開 MAX_PATH）
  runtime/node/        可攜 Node LTS（只在系統沒有 Node 時安裝，需要使用者同意）
  runtime/ffmpeg/      使用者同意下載的 ffmpeg
  chrome-headless-shell/  從 node_modules 複製的短路徑版本（沿用 lib.mjs 的做法）
  venvs/py311/         Python 3.11 venv（edge-tts、opencc、numpy…）
  venvs/cosyvoice/     Python 3.10 venv（torch cu121）
  models/cosyvoice3/  models/whisper-large-v3-turbo/

工作區（使用者選擇，預設 D:\PikaraWork；路徑長度要小於 60 字元，Doctor 會檢查）
  <project>/            ← 一個 git repo（v0.1：直接開啟 <PROJECT_DIR>）
    package.json, node_modules/（使用者機器上 npm ci 安裝的 Remotion）
    src/ src_cn/ public/ scripts/ out/
    .pikara/project.json（Studio 的中繼資料：id、模板版本）
```

## 4. 現有元件盤點（重用／包裝／重構）

| 元件 | 判定 | 理由與要做的事 |
|---|---|---|
| `generate_voiceover.py`（Edge-TTS） | **包裝** | 重試、拆句、快取、`.part` 驗證都很完整。runner 用 `--seq` 呼叫，從 stdout 逐句解析進度。風險：非官方端點，預設關閉（見 OPEN_SOURCE_PLAN） |
| `generate_voiceover_cosy.py` | **包裝 → 重構** | 已有 `--only/--speed/--target-cps/--ref/--narration/--out-root` 可以直接用。要重構的地方：`wait_for_gpu()` 用 `tasklist` 偵測 chrome-headless-shell 並以 VRAM 大於 3GB 判斷，應改成由 Studio 的 GPU 租約控制，並新增 `--no-gpu-wait`；`ROOT` 由腳本位置推得，需要 `--project-root` |
| `build_timeline.py` | **直接重用** | 已支援 `--src/--voice-dir/--srt-name`。`VO_DIRS` 寫死兩個引擎，新增引擎時才需要修改 |
| `mix_audio.py`、`music.py` | **直接重用** | 參數只有 `--seq/--src/--mix-name`，輸出路徑固定，runner 依約定讀取即可 |
| `render.mjs` | **包裝 → 重構** | 分段續傳、動態並行、遙測都可以直接用。硬編碼：comp id（`EP01`、`EP01-30fps`、`EP01-YT15`）、由 comp 名稱推導 `seqId`、`totalFrames` 的公式、`SPEED`；輸出為中文文字而非 JSON；`spawn('ffmpeg')` 依賴 PATH。v0.1 runner 用 regex 解析「區段 a–z：…」行換算進度；v0.2 新增 `--json-progress`、`--ffmpeg <path>`，並把 comp → seq／fps 的對應移到 `.pikara/project.json` |
| `lib.mjs` `ensureBrowser()` | **重用＋強化** | exe 路徑大於等於 240 字元時，複製 chrome-headless-shell 到 `%LOCALAPPDATA%\pikara-science\`。本機路徑只有 121 字元，所以不會觸發，但 `LongPathsEnabled=0`，使用者工作區路徑較長時一定需要。Doctor 應主動檢查，複製到 Studio 的短路徑 |
| `gpu-check.mjs` | **重用** | 會輸出 `out/gpu-check.json`，Doctor 直接讀取。注意：它會渲染 GpuProbe still，**會用到 GPU**，只能在沒有 GPU 租約時執行 |
| `qa_video.py` | **重用** | 輸出 `out/qa/*.md`。v0.2 新增 `--json`，讓 UI 能以表格顯示 |
| `make_cn.py` | **短期重用，長期重構** | 現在是 rmtree 後整棵 `src → src_cn` 原始碼樹複製轉換，會產生兩份程式碼與兩份 bundle。1.0 改成 locale 層：`narration.zh-CN.json` 加字串表，同一份程式碼以 `locale` prop 切換，OpenCC 與詞彙對照表保留 |
| `scale_srt.py`、`export_voiceover_md.py`、`stills.mjs` | **直接重用** | 參數單純 |
| `finalize.sh` | **淘汰** | 由 runner 的 job DAG 取代（時間軸 → 混音與渲染並行 → 編碼 → QA） |
| `src/acts/Act01..07`、`registry.ts`、`Root.tsx` | **重構（v0.4 以後）** | 每集的 act 程式碼不能直接重用。抽出 `templates/`（場景元件：3D 顯示卡、矩陣、資料點轉場、字幕、品牌片尾）與 `episode.manifest.json`（scene → template＋params＋anchors）。EP01 保留為範例專案 |
| `src/theme/palette.ts`、`fonts.ts`、`lib/anim.ts`、`camera*.ts`、`timewarp.ts` | **直接重用** | 成為模板 SDK 的核心 |
| `narration.json` | **重用（唯一真實來源）** | Studio 的腳本編輯器讀寫這個檔案；每次儲存都產生 git commit |
| `tools/CosyVoice/` | **重用（不內含）** | 使用者機器上由 Doctor 安裝（clone、建立 venv、下載模型） |

## 5. 工作模型

### 5.1 Job 種類與資源

| kind | 執行者 | 資源 | 可續傳 |
|---|---|---|---|
| `tts.edge` | py311 → generate_voiceover.py | net | 是（逐句快取） |
| `tts.cosy` | cosyvoice venv | **gpu:exclusive**（約 2–3GB VRAM） | 是（逐句快取） |
| `align` | cosyvoice venv `--align-only` | cpu | 是 |
| `timeline` | build_timeline.py | cpu | 不需要 |
| `mix` | mix_audio.py | cpu | 不需要 |
| `locale.cn` | make_cn.py | cpu | 不需要 |
| `render` | runner → render.mjs | **gpu:exclusive** | 是（區段） |
| `encode` | ffmpeg NVENC | gpu:nvenc（可與 CPU 工作並行） | 否（重跑即可） |
| `qa` | qa_video.py | cpu | 不需要 |
| `still` | stills.mjs | gpu:exclusive（短時間） | 不需要 |
| `doctor.*` | Rust／runner | 依檢查項目而定 | — |
| `agent.fix` | claude -p | net（需要 API） | 否 |

**Pipeline 範本**（一鍵製作）：`tts → timeline → (mix ‖ render) → encode → qa →（locale.cn → tts.cosy(cn) → timeline(cn) → mix(cn) → render(cn) → encode → qa）`，由 `jobs.parent_id` 加上 `depends_on` 組成 DAG。

### 5.2 狀態機

```
queued → waiting_resource → running → succeeded
                │              ├→ failed → (retry ≤ max_retries, 指數退避) → queued
                │              ├→ paused（使用者暫停，或排程時段結束：送 SIGINT 等 render 區段完成）
                │              └→ canceled
                └→ blocked（相依 job 失敗）
```

- **GPU 租約**：scheduler 同時最多發出一張 `gpu:exclusive`。發出前用 NVML 讀取 VRAM 使用量；若有非 Studio 的程式佔用大於 1.5GB（例如另一個渲染或遊戲），就維持 `waiting_resource` 並在 UI 顯示原因。
- **排程（無人值守）**：`schedules` 表定義時段（例如 01:00–07:00）。時段內才發放 GPU 租約；執行期間呼叫 `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` 防止睡眠（只防止系統睡眠，不防止關閉螢幕）。
- **續傳**：render 沿用 `out/frames/<tag>/` 的區段機制；TTS 沿用逐句快取。重啟 Studio 時，狀態為 `running` 但沒有程序的 job 改為 `queued`，重新執行時會自動跳過已完成的部分。

### 5.3 runner 事件協定（stdout JSONL，每行一個事件）

```json
{"v":1,"type":"stage","stage":"render","status":"start","ts":1763550000123}
{"v":1,"type":"progress","stage":"render","done":1800,"total":25257,"unit":"frame","fps":13.2,"eta_s":1320}
{"v":1,"type":"metric","gpu":97,"vram_mib":4100,"enc":0,"temp_c":71,"power_w":78,"cpu":42}
{"v":1,"type":"log","level":"warn","msg":"區段 1800–3599：熱降頻，並行降為 3"}
{"v":1,"type":"artifact","kind":"video","path":"EP01_Final.mp4","sha256":"…"}
{"v":1,"type":"result","status":"succeeded","exit":0}
```

不是 JSON 的行一律當成 `log/info` 存起來（包裝舊腳本時一定會有這種行）。Rust 依 job_id 寫入 `job_events`（metric 每 10 秒取樣一筆存入，UI 則即時轉發）。

## 6. 錯誤處理、自動修復與 Git 回滾

1. **失敗分類**（runner 依 exit code 與 stderr 的最後 4KB 比對規則）：`env`（找不到 ffmpeg、chrome 無法啟動、CUDA 錯誤）→ 導向 Doctor；`transient`（Edge `NoAudioReceived`、網路）→ 自動重試；`content`（tsc 錯誤、anchor 不存在）→ 可交給 AI 修復；`resource`（VRAM 不足、熱降頻）→ 降低並行數後重試。
2. **Checkpoint**：每次執行 pipeline 前、AI 修改前、使用者儲存腳本後，都自動 `git commit`（訊息前綴 `studio:`），並加上輕量 tag `studio/cp/<job_id>`。工作目錄有未提交的使用者改動時，**先詢問**，不要自動 stash。
3. **AI 自動修復**（`agent.fix`，使用者在設定中啟用後才執行）：
   - 在 `git worktree add ../.pikara-wt/<job_id> -b studio/fix/<job_id>` 隔離的工作樹中執行，主工作樹不受影響。
   - 指令：`claude -p "<失敗摘要＋log 檔路徑>" --bare --add-dir <worktree> --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --allowedTools "Read,Edit,Glob,Grep,Bash(node node_modules/typescript/bin/tsc *),Bash(git diff *),Bash(git status *)" --max-turns 30 --max-budget-usd <設定值>`（使用 `--bare` 時需要 API key；使用者選擇「本機已登入的 CLI」模式時，拿掉 `--bare` 並改用 `--settings` 傳入限制）。
   - 驗收：typecheck 通過，且重新渲染失敗段落的 still 成功，才標記為 `fix_ready`。**合併到主分支需要使用者按下「套用」**；按「捨棄」則刪除分支與 worktree。
4. **效能最佳化**：只調整 render 參數（concurrency、chunk、`--vram-cap`），依 `renders` 歷史資料建議。不修改 GPU 時脈、功耗或散熱設定（沿用 render.mjs 的原則）。
5. **回滾 UI**：時間軸列出 checkpoint；「回到這裡」＝`git revert`（保留歷史，預設）或 `git reset --hard`（需要二次確認，並提示會遺失哪些檔案）。

## 7. 遙測（只在本機）

- 不上傳任何資料。`metrics` 只存在本機 SQLite，渲染報告沿用 `out/reports/<tag>.json`。
- Remotion v4 的 server-side 渲染沒有自動遙測（RESEARCH_LOG §2）。升級到 Remotion 5 前要重新評估。
- 若有當機報告，只寫入本機 `logs/`，由使用者自行附到 GitHub issue。

## 8. 資料庫設計（SQLite，`studio.db`）

使用 rusqlite（不使用 tauri-plugin-sql）。理由：排程器與 runner 事件寫入都在 Rust 端；前端不需要也不應取得 `sql:allow-execute`。啟動時設定 `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`，遷移以 `PRAGMA user_version` 管理。

```sql
-- 001_init.sql
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,               -- UUID
  name         TEXT NOT NULL,
  root_path    TEXT NOT NULL UNIQUE,           -- git repo 根目錄
  template_ver TEXT,
  default_locale TEXT NOT NULL DEFAULT 'zh-TW' CHECK (default_locale IN ('zh-TW','zh-CN')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  opened_at    TEXT,
  archived     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE voice_profiles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  engine        TEXT NOT NULL CHECK (engine IN ('cosyvoice','edge','api','manual')),
  locale        TEXT NOT NULL CHECK (locale IN ('zh-TW','zh-CN')),
  ref_audio     TEXT,                          -- cosyvoice 參考音路徑
  ref_text      TEXT,
  ref_sha256    TEXT,
  voice_name    TEXT,                          -- edge/api 的語音名稱
  speed         REAL NOT NULL DEFAULT 1.0 CHECK (speed BETWEEN 0.5 AND 2.0),
  target_cps    REAL,                          -- 目標字／秒（cosy --target-cps）
  consent_kind  TEXT NOT NULL CHECK (consent_kind IN ('self','signed_release','cc0_dataset','tos_service','unknown')),
  consent_note  TEXT,
  licence_id    TEXT REFERENCES licences(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE episodes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq_key       TEXT NOT NULL,                 -- narration.json 的 sequences.<seq_key>
  title         TEXT NOT NULL,
  composition   TEXT NOT NULL,                 -- Remotion comp id，例如 EP01-30fps
  fps           INTEGER NOT NULL DEFAULT 60,
  width         INTEGER NOT NULL DEFAULT 1920,
  height        INTEGER NOT NULL DEFAULT 1080,
  voice_profile_tw TEXT REFERENCES voice_profiles(id),
  voice_profile_cn TEXT REFERENCES voice_profiles(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','voiced','rendered','qa_passed','approved','published')),
  UNIQUE (project_id, seq_key)
);

CREATE TABLE scripts (                          -- 一集的一個 locale 版本（對應一個 narration.json）
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  locale        TEXT NOT NULL CHECK (locale IN ('zh-TW','zh-CN')),
  file_path     TEXT NOT NULL,                 -- 相對於專案根目錄：src/data/narration.json
  file_sha256   TEXT NOT NULL,                 -- 和檔案比對，偵測外部修改
  git_commit    TEXT,
  synced_at     TEXT NOT NULL,
  UNIQUE (episode_id, locale)
);

CREATE TABLE scenes (
  id            TEXT PRIMARY KEY,
  script_id     TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  scene_key     TEXT NOT NULL,                 -- 例如 act01
  ord           INTEGER NOT NULL,
  title         TEXT,
  UNIQUE (script_id, scene_key)
);

CREATE TABLE lines (                            -- 檔案的鏡像，供編輯器與搜尋使用；寫入一律回寫 narration.json
  id            TEXT PRIMARY KEY,
  scene_id      TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  line_key      TEXT NOT NULL,                 -- 例如 a1-00
  ord           INTEGER NOT NULL,
  subtitle      TEXT NOT NULL,
  speak         TEXT,                          -- 朗讀文字（可為 NULL＝同字幕）
  pause_after   REAL,
  anchors_json  TEXT NOT NULL DEFAULT '{}',
  speed         REAL,                          -- 單句語速覆寫
  audio_path    TEXT,
  audio_sha256  TEXT,
  duration_s    REAL,
  asr_cer       REAL,                          -- 對齊後的字元錯誤率（cosy＋whisper）
  tts_cache_key TEXT,
  UNIQUE (scene_id, line_key)
);
CREATE INDEX idx_lines_scene ON lines(scene_id, ord);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  episode_id    TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  parent_id     TEXT REFERENCES jobs(id) ON DELETE CASCADE,  -- pipeline 父 job
  kind          TEXT NOT NULL,                 -- tts.cosy / render / encode / qa / agent.fix / doctor.* …
  params_json   TEXT NOT NULL DEFAULT '{}',
  depends_on    TEXT NOT NULL DEFAULT '[]',    -- JSON 陣列：job id
  resource      TEXT NOT NULL DEFAULT 'cpu' CHECK (resource IN ('cpu','net','gpu_exclusive','gpu_nvenc')),
  priority      INTEGER NOT NULL DEFAULT 100,  -- 數字越小越優先
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','waiting_resource','running','paused','succeeded','failed','canceled','blocked','fix_ready')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 2,
  schedule_id   TEXT REFERENCES schedules(id),
  not_before    TEXT,
  pid           INTEGER,
  exit_code     INTEGER,
  error_class   TEXT CHECK (error_class IN ('env','transient','content','resource','unknown')),
  error_summary TEXT,
  git_checkpoint TEXT,                         -- 執行前的 commit
  progress      REAL NOT NULL DEFAULT 0,       -- 0..1
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status, priority, created_at);
CREATE INDEX idx_jobs_parent ON jobs(parent_id);

CREATE TABLE job_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,              -- epoch ms
  type          TEXT NOT NULL CHECK (type IN ('stage','progress','metric','log','artifact','result')),
  stage         TEXT,
  level         TEXT CHECK (level IN ('debug','info','warn','error')),
  payload_json  TEXT NOT NULL
);
CREATE INDEX idx_events_job ON job_events(job_id, ts);

CREATE TABLE schedules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  rrule         TEXT NOT NULL,                 -- 例如 FREQ=DAILY;BYHOUR=1
  window_minutes INTEGER NOT NULL,             -- 時段長度
  gpu_allowed   INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE renders (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  locale        TEXT NOT NULL,
  variant       TEXT NOT NULL,                 -- 1080p30 / 1080p60 / yt15 / preview720
  mode          TEXT NOT NULL CHECK (mode IN ('gpu','cpu','preview')),
  codec         TEXT NOT NULL,                 -- h264_nvenc / hevc_nvenc / libx264
  output_path   TEXT,
  output_sha256 TEXT,
  frames        INTEGER,
  duration_s    REAL,
  render_s      REAL,
  encode_s      REAL,
  vram_peak_mib INTEGER,
  temp_max_c    INTEGER,
  report_path   TEXT,                          -- out/reports/<tag>.json
  qa_report_path TEXT,
  qa_status     TEXT CHECK (qa_status IN ('pass','warn','fail')),
  git_commit    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE licences (
  id            TEXT PRIMARY KEY,              -- 例如 remotion, ffmpeg-gpl, cosyvoice3-weights
  component     TEXT NOT NULL,
  spdx          TEXT,                          -- 沒有 SPDX 時為 NULL（例如 Remotion）
  url           TEXT NOT NULL,
  redistributable INTEGER NOT NULL,            -- Studio 是否可以內含
  requires_ack  INTEGER NOT NULL DEFAULT 0,    -- 安裝時需要使用者確認
  acked_at      TEXT,
  notes         TEXT
);

CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('audio_ref','music','sfx','font','image','model','video','subtitle','thumbnail')),
  path          TEXT NOT NULL,
  sha256        TEXT,
  bytes         INTEGER,
  source_url    TEXT,
  licence_id    TEXT REFERENCES licences(id),
  attribution   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, path)
);

CREATE TABLE publish_items (                    -- 發佈中心：只記錄與核准，不自動上傳
  id            TEXT PRIMARY KEY,
  render_id     TEXT NOT NULL REFERENCES renders(id),
  platform      TEXT NOT NULL CHECK (platform IN ('youtube','bilibili','other')),
  title         TEXT, description TEXT, tags_json TEXT, srt_path TEXT, thumbnail_path TEXT,
  checklist_json TEXT NOT NULL DEFAULT '{}',   -- 授權／聲音同意／QA 勾選項目
  approved_by   TEXT, approved_at TEXT,
  published_url TEXT, published_at TEXT        -- 使用者手動發佈後回填
);

CREATE TABLE env_checks (
  id            TEXT NOT NULL,                 -- 例如 gpu.driver
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status        TEXT NOT NULL CHECK (status IN ('ok','warn','fail','skipped')),
  detail_json   TEXT NOT NULL,
  PRIMARY KEY (id, ts)
);

CREATE TABLE metrics (                          -- 資源監控歷史（保留 7 天）
  ts INTEGER NOT NULL, job_id TEXT, gpu REAL, vram_mib INTEGER, enc REAL, temp_c INTEGER,
  power_w REAL, cpu REAL, ram_mib INTEGER
);
CREATE INDEX idx_metrics_ts ON metrics(ts);
```

**同步規則**：開啟專案時讀取 narration.json，若 sha256 與 `scripts.file_sha256` 不同，就重建 scenes/lines（以檔案為準）。編輯器儲存時，依原有鍵順序寫回 JSON（保留 2 空格縮排與鍵順序，讓 git diff 乾淨），接著 commit，再更新 sha256。
