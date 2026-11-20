# Pikara Science Studio — Frontend ⇄ Rust API (v1.3)

Status: **stable v1.3** (additive over v1; v1 callers keep working). Changes will be listed here in the changelog below.

## Changelog
- v1.3 (2026-11-20, Autonomous Production Mode; additive):
  - New commands `auto_defaults`, `auto_start`, `auto_list`, `auto_get`, `auto_events`, `auto_control` (§11) and events `production://update`, `production://event`.
  - Job params may carry **`workdir`** = a Studio worktree id (`.studio/worktrees/<id>`): the job runs there instead of the project root (used by the autopilot; anything that is not an existing worktree is refused).
  - Internal job kinds (not listed by `job_kinds`): `claude_in` `{ prompt, tools, maxTurns, billing: "subscription"|"api", budgetUsd?, title }` (claude -p in the job directory; subscription removes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child and passes no USD cap; api passes `--max-budget-usd`), `stills` `{ comp, frames: "0,120", src? }` (GPU), `typecheck` (CPU, `tsc --noEmit`).
  - `final_tw`, `youtube_15x`, `bilibili` accept `fresh: true` (render.mjs `--fresh`, drop cached frame chunks).
  - Every episode also gets the composition `<EP>-Thumbnail` (generic cover from `sequences.<ep>.thumbnail`).
- v1.2 (2026-11-20, multi-episode; additive — nothing removed or renamed):
  - **Episodes**: an episode is `sequences.<epId>` in narration.json (`epId` = `ep` + 2–3 digits, e.g. `ep02`). zh-TW (`src/`) and zh-CN (`src_cn/`) are managed independently.
  - New commands `episode_list`, `episode_create`, `project_create` (§2a).
  - Every job kind that works on an episode takes **`episode`** (default `"ep01"`); the v1 name `seq` is still accepted and wins when both are given. Output names / compositions are derived from it: `<EP>_Final.mp4`, `<EP>.srt`, `<EP>_YouTube_zh-TW.mp4`, `<EP>_Bilibili_zh-CN.mp4`, comps `<EP>`, `<EP>-30fps`, `<EP>-YT15` (`<EP>` = upper-case id). Invalid ids are rejected at enqueue with a zh-TW message.
  - `render`: `comp` / `out` default to `<EP>-30fps` / `<EP>_Final.mp4`; new `chunk` param (frames per resumable chunk). `qa`: `video` defaults to `<EP>_Final.mp4`.
  - New kind **`final_tw`** `{ episode, out? }` (GPU, 5 steps): timeline → copy `out\subtitles\<ep>.srt` to `<EP>.srt` → mix → render `<EP>-30fps` → qa.
  - `make_cn` `{ episode?, reconvert? }` **no longer overwrites zh-CN narration**: existing src_cn episodes and the src_cn timeline are kept; only episodes missing from src_cn are converted (`reconvert=true` re-converts the given episode). `bilibili` runs `make_cn --seq <ep>`.
  - Job labels get an `"<EP> · "` prefix when an episode is given (`labelCn` follows).
  - **Preflight** before a job starts (not at enqueue): missing ffmpeg/ffprobe, missing video for `qa`, unknown episode, missing `src_cn`, missing CosyVoice Python → the job is marked `failed` with a complete zh-TW sentence in `error`; nothing is spawned. (`job_retry` after fixing.)
  - Test-only env `PIKARA_STUDIO_TEST_HIDE_TOOLS=ffprobe,ffmpeg` makes Studio behave as if those tools were not installed (robustness tests); never set in normal use.
  - Headless CLI for the same backend: `PikaraScienceStudio.exe --cli <command>` (see `src-tauri/src/cli.rs`): `episode-list`, `episode-new`, `validate`, `project-new`, `doctor`, `enqueue`, `run-queue`, `jobs`, `job-retry`, `job-cancel`, `recover`; `--data <dir>` isolates the queue DB.
- v1.1 (2026-11-20, additive only — nothing removed or renamed):
  - `job_kinds[]` items gain `labelKey` (= kind) and `labelCn` (Simplified label or null); `Job` gains `labelCn` (null for free-form labels such as render/qa/custom with parameters).
  - Doctor `Check` gains `labelKey` (= id) and `labelCn`.
  - `Worktree` gains `branchExists: boolean` and `orphan: boolean`. For an orphan (no branch and no valid worktree) `claude_worktree_diff` / `claude_worktree_merge` reject with a message telling the user to discard; `claude_worktree_discard` always cleans up the folder, prunes, and deletes the branch if present. If only the branch is missing, diff/merge use the worktree's HEAD.
  - Second app launch focuses the running window (single-instance).
- v1 (2026-11-20): initial contract.

## Conventions

- Call with `window.__TAURI__.core.invoke(name, args)` (the app sets `app.withGlobalTauri = true`, so no bundler is needed).
  Listen with `window.__TAURI__.event.listen(eventName, (e) => e.payload)`.
- **Argument names are camelCase in JS** (Tauri converts them to the Rust snake_case names).
- Every command returns a Promise. On failure the Promise rejects with a **string** error message (human readable, may be Chinese or English).
- Timestamps: ISO-8601 UTC strings (`"2026-11-20T03:12:45.123Z"`) unless named `ts` (epoch milliseconds, number).
- Paths are absolute Windows paths with backslashes.
- `projectId` is a UUID string returned by `project_register` / `project_list`.
- `locale` is `"zh-TW"` (file `src/data/narration.json`) or `"zh-CN"` (file `src_cn/data/narration.json`).

---

## 1. App & settings

| command | args | returns |
|---|---|---|
| `app_info` | – | `{ version, dataDir, dbPath, logsDir, exePath }` |
| `settings_get` | – | `Settings` |
| `settings_set` | `{ settings: Partial<Settings> }` | `Settings` (merged, saved) |

```ts
Settings = {
  queueEnabled: boolean,          // scheduler starts queued jobs (default true)
  windowStart: string | null,     // "01:00" — GPU jobs only start inside the window; null = any time
  windowEnd: string | null,       // "07:00"
  gpuVramBusyMiB: number,         // external GPU usage threshold (default 2500)
  maxCpuJobs: number,             // parallel CPU/net jobs (default 2)
  keepAwake: boolean,             // SetThreadExecutionState while jobs run (default true)
  claudeMaxTurns: number,         // default 30
  claudeMaxBudgetUsd: number | null,
  nodeDir: string,                // default "C:\\Program Files\\nodejs"
  cosyPython: string | null       // default <project>\tools\CosyVoice\.venv\Scripts\python.exe
}
```

## 2. Projects

| command | args | returns |
|---|---|---|
| `project_list` | – | `Project[]` (most recently opened first) |
| `project_register` | `{ path }` | `Project` (creates or returns existing; marks opened) |
| `project_remove` | `{ projectId }` | `null` (only forgets it in the DB, files untouched) |
| `project_info` | `{ projectId }` | `ProjectInfo` |

```ts
Project = { id, name, rootPath, createdAt, openedAt }
ProjectInfo = {
  project: Project,
  episodes: [{ locale, seqKey, title, voiceEngine: string|null, scenes: number, lines: number }],
  outputs: [{ name, path, ext: "mp4"|"srt"|"png", size: number, mtime: string }],
  git: GitStatus
}
GitStatus = { isRepo: boolean, branch: string|null, head: string|null, headSubject: string|null,
              dirty: [{ code: string, path: string }] }   // code = porcelain XY, e.g. " M", "??"
```

## 2a. Episodes & new project (v1.2)

| command | args | returns |
|---|---|---|
| `episode_list` | `{ projectId }` | `Episode[]` sorted by number (union of zh-TW and zh-CN narration) |
| `episode_create` | `{ projectId, title, episodeId?, sceneTitle?, firstLine?, locales? = ["zh-TW"] }` | `{ episodeId, title, files: [{ locale, path, sha256, commit, commitError }], compositions: string[], outputs, next }` |
| `project_create` | `{ dest, title, templateProjectId?, templatePath?, linkTools? = true }` | `{ project: Project, scaffold: { path, title, template, files, bytes, tools, git: { init, commit, error }, next } }` |

- `episode_create` picks the next free `epNN` when `episodeId` is omitted, refuses an id that already exists in any requested locale (never overwrites), inserts a one-scene / one-line skeleton (`scenes[0].id = "s01"`, line id `<ep>-01`, `voiceEngine = "cosyvoice"`), validates the whole document with the `narration_validate` rules, writes atomically and commits only that file (`Studio: new episode <ep>（<locale>）`).
- `project_create` copies the pipeline from the template (`templatePath`, else the project `templateProjectId`, else `<exe dir>\pipeline-template`): `scripts/` (minus `export_release.py`), `src/`, `public/fonts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `remotion.config.ts`, `.gitignore`. Content is reset (narration = one `ep01` skeleton with `title`, empty timeline, no hand-made acts → every episode uses the generic template). `linkTools` creates a directory junction `tools\CosyVoice` → the template's install (no 9 GB copy). Then `git init` + first commit, and the folder is registered (`project_register`). `dest` must be absolute and not exist or be empty; Chinese characters and spaces are fine. `node_modules` is not copied (doctor → `npm_install`).

```ts
Episode = { id: "ep02", comp: "EP02", title: string|null,
  locales: { "zh-TW"?: EpisodeLocale, "zh-CN"?: EpisodeLocale },
  outputs: { final, srt, youtube, youtubeSrt, bilibili, bilibiliSrt },   // default file names
  present: { final: string|null, ... } }                                  // absolute path when the file exists
EpisodeLocale = { locale, title, scenes: number, lines: number, voiced: number /* lines with an mp3 */,
  timeline: null | { totalFrames: number, duration: number, mix: string|null } }
```

## 3. Narration (content editor)

| command | args | returns |
|---|---|---|
| `narration_read` | `{ projectId, locale }` | `NarrationFile` |
| `narration_validate` | `{ doc }` | `Validation` |
| `narration_save` | `{ projectId, locale, doc, expectedSha256, message? }` | `SaveResult` |

- `doc` is the **whole** narration JSON object (as returned in `NarrationFile.doc`, modified by the UI). Key order is preserved on save; output is 2-space-indented UTF-8 like the original.
- `narration_save` refuses (rejects) when validation has errors, or when the file on disk changed since `expectedSha256` (external edit). It writes atomically (temp file + rename) and then runs `git add <file>` + `git commit -m "Studio: edit narration"` (message overridable; only that file is committed).

```ts
NarrationFile = {
  path, locale, sha256,
  doc: object,                     // raw JSON
  sequences: [{ key, title, voiceEngine: string|null,
    scenes: [{ id, title, lines: [Line] }] }]
}
Line = { id, subtitle, speak: string|null, anchors: { [name]: string }, pauseAfter: number|null }
Validation = { ok: boolean,
  errors:   [{ seqKey, sceneId, lineId, field, message }],
  warnings: [{ seqKey, sceneId, lineId, field, message }] }
SaveResult = { sha256, commit: string|null, commitError: string|null, validation: Validation }
```
Validation rules: line ids unique within a sequence (errors), scene ids unique within a sequence (errors), every anchor value must appear in `speak` (or `subtitle` when `speak` is absent) — checked against the spoken text, falling back to the subtitle (error if in neither), empty subtitle (error), `pauseAfter` must be a number 0–10 (error).

## 4. Prompt generator

| command | args | returns |
|---|---|---|
| `prompt_tasks` | – | `[{ id, label, description, needs: ("seqKey"|"sceneId"|"topic"|"jobId"|"notes")[] }]` |
| `prompt_build` | `{ projectId, task, options }` | `{ task, text, chars }` |

`task` ids: `rewrite_act_pacing`, `fix_qa_issues`, `new_episode_script`, `fix_failed_job`, `improve_anchors`, `translate_cn_review`.
`options = { seqKey?, sceneId?, topic?, notes?, jobId?, locale? }`.

## 5. Claude Code integration

| command | args | returns |
|---|---|---|
| `claude_detect` | – | `{ found: boolean, path: string|null, version: string|null }` |
| `claude_install_skill` | `{ projectId, overwrite?: boolean }` | `{ path, written: boolean, existed: boolean }` |
| `claude_run` | `{ projectId, prompt, allowEdits?: boolean }` | `Job` (kind `claude`) |
| `claude_worktrees` | `{ projectId }` | `Worktree[]` |
| `claude_worktree_diff` | `{ projectId, worktreeId }` | `{ stat: string, diff: string, commits: string[] }` |
| `claude_worktree_merge` | `{ projectId, worktreeId }` | `{ merged: boolean, output: string }` |
| `claude_worktree_discard` | `{ projectId, worktreeId }` | `{ removed: boolean, output: string }` |

- `claude_run` enqueues a job that creates `git worktree add <project>\.studio\worktrees\<id> -b studio/claude/<id>` and runs `claude -p <prompt> --output-format stream-json --verbose --permission-mode dontAsk --allowedTools <list> --max-turns N [--max-budget-usd X]` inside it. Tool list: `Read,Glob,Grep,Bash(git diff *),Bash(git status *),Bash(git log *)` plus `Edit,Write` when `allowEdits` (default true). After exit, Studio commits any changes inside the worktree branch. **Nothing is merged automatically.**
- Job log lines from claude are the stream-json lines summarised as text (assistant text, tool calls, final result).

```ts
Worktree = { id, path, branch, jobId: string|null, exists: boolean, commitsAhead: number, changedFiles: number }
```

## 6. Environment doctor

| command | args | returns |
|---|---|---|
| `doctor_run` | `{ projectId?: string, gpuTests?: boolean }` | `DoctorReport` |
| `doctor_fix` | `{ projectId, fixId }` | `FixResult` |

```ts
DoctorReport = { ts: string, checks: Check[] }
Check = { id, label, status: "ok"|"warn"|"error"|"skipped", detail: string, value: string|null,
          fix: { id, label, kind: "auto"|"instructions", instructions: string|null } | null }
FixResult = { kind: "job", job: Job } | { kind: "done", message: string } | { kind: "instructions", text: string }
```
Check ids: `os.version, os.longpaths, webview2, gpu.driver, node, npm.deps, browser.chs, ffmpeg.present, ffmpeg.nvenc, py311, cosy.venv, cosy.model, whisper.model, disk.free, git, claude, project.folders`.
`ffmpeg.nvenc` test encode only runs when `gpuTests=true` **and** the GPU is free (else `skipped`).
Fix ids: `npm_install` (job), `remotion_browser_ensure` (job), `create_folders` (done), `pip_install:<pkg>` (job, CosyVoice venv), `longpaths_instructions`, `driver_instructions`, `install_python311`, `install_ffmpeg`, `install_claude` (instructions only).

## 7. Job queue

| command | args | returns |
|---|---|---|
| `job_kinds` | – | `[{ kind, label, resource: "cpu"|"gpu"|"net", params: [{ name, type, required, default, help }] }]` |
| `job_enqueue` | `{ projectId, kind, params }` | `Job` |
| `job_list` | `{ projectId?, status?, limit? }` | `Job[]` (newest first, default limit 200) |
| `job_get` | `{ jobId }` | `Job` |
| `job_events` | `{ jobId, afterId?, limit? }` | `JobEvent[]` (ascending id, default limit 1000) |
| `job_cancel` | `{ jobId }` | `Job` (kills the whole process tree with `taskkill /T /F`) |
| `job_retry` | `{ jobId }` | `Job` (failed/canceled/interrupted → queued) |
| `job_remove` | `{ jobId }` | `null` (not allowed while running) |
| `queue_status` | – | `QueueStatus` |
| `gpu_external_status` | – | `ExternalGpu` |

Job kinds (`params`) — `episode` defaults to `"ep01"` (v1 `seq` still accepted); `<EP>` = upper-case episode id:
- `voiceover_tw` `{ episode, only?: string (space separated ids), force?: bool, speed?: number, targetCps?: number }` — GPU
- `voiceover_cn` `{ episode, only?, force?, targetCps=5.4 }` — GPU (src_cn narration, voiceover_cosy_cn, reference_cn)
- `timeline` `{ episode, src="src", estimate?: bool }` — CPU (src_cn → voice dir voiceover_cosy_cn, srt name `<ep>_cn`)
- `mix` `{ episode, src="src" }` — CPU (episodes other than ep01 use the generic mood/SFX rules of mix_audio.py)
- `render` `{ episode, comp="<EP>-30fps", mode="gpu"|"cpu"|"preview", src="src", out="<EP>_Final.mp4", mix?: string, fps?: number, frames?: "a-b", chunk?: number, concurrency?: number }` — GPU (`fps` is informational; the comp defines fps)
- `qa` `{ episode, video="<EP>_Final.mp4", src="src", speed?: number }` — CPU
- `make_cn` `{ episode?, reconvert?: bool }` — CPU (regenerates src_cn code; keeps existing zh-CN narration and timeline per episode)
- `final_tw` `{ episode, out="<EP>_Final.mp4" }` — GPU, steps: timeline → copy SRT to `<EP>.srt` → mix → render `<EP>-30fps` → qa
- `youtube_15x` `{ episode, out="<EP>_YouTube_zh-TW.mp4" }` — GPU, steps: scale `<EP>.srt` 1.5× → render `<EP>-YT15`
- `bilibili` `{ episode, out="<EP>_Bilibili_zh-CN.mp4" }` — GPU, steps: make_cn --seq → voiceover_cn → timeline(src_cn) → copy SRT → mix(src_cn) → render `<EP>-30fps --src src_cn` → qa
- `custom` `{ command: string, gpu?: bool }` — runs `cmd /c <command>` in the project root
- `claude` (created by `claude_run` / `job_analyse_with_claude`), `doctor_fix` (created by `doctor_fix`)

```ts
Job = { id, projectId, kind, label, params: object, resource: "cpu"|"gpu"|"net",
  status: "queued"|"waiting_resource"|"running"|"succeeded"|"failed"|"canceled"|"interrupted",
  progress: number /*0..1*/, progressText: string|null, step: number, steps: string[],
  attempt: number, pid: number|null, exitCode: number|null, error: string|null,
  waitReason: string|null, logPath: string|null,
  createdAt, startedAt: string|null, finishedAt: string|null, heartbeatAt: string|null }
JobEvent = { id: number, jobId, ts: number, stream: "stdout"|"stderr"|"system", level: "info"|"warn"|"error", line: string }
QueueStatus = { enabled: boolean, inWindow: boolean, running: Job[], queued: number,
  gpuHolder: string|null /* job id */, external: ExternalGpu, keepAwake: boolean }
ExternalGpu = { busy: boolean, reasons: string[], processes: [{ pid, name, cmd }], vramUsedMiB: number|null }
```
Recovery: on start, jobs left `running` with a heartbeat older than 20 s are marked `interrupted`, then automatically re-queued (attempt+1); render.mjs and the TTS scripts skip work that is already done.

## 8. Monitoring

| command | args | returns |
|---|---|---|
| `monitor_sample` | – | `MonitorSample` (one fresh sample) |

## 9. Auto-fix & rollback

| command | args | returns |
|---|---|---|
| `job_analyse_with_claude` | `{ jobId }` | `Job` (kind `claude`, prompt = failure summary + log tail + latest QA report) |
| `git_log` | `{ projectId, limit? }` | `[{ hash, short, subject, author, date }]` |
| `git_status` | `{ projectId }` | `GitStatus` |
| `git_revert` | `{ projectId, commit }` | `{ ok, output }` (`git revert --no-edit <commit>`, keeps history) |
| `git_branch_from` | `{ projectId, commit, branch }` | `{ ok, output }` (`git branch <branch> <commit>`; no checkout) |
| `git_reset_hard` | `{ projectId, commit, confirm }` | `{ ok, output }` — destructive; `confirm` must equal `"RESET " + first 7 chars of commit`, else rejected. Creates backup branch `studio/backup-<timestamp>` first. |

## 10. Preview & publish centre (no upload code)

| command | args | returns |
|---|---|---|
| `outputs_list` | `{ projectId, probe?: boolean }` | `[{ name, path, ext, size, mtime, probe: Probe|null }]` |
| `publish_metadata` | `{ projectId }` | `{ path, exists, sections: [{ level, title, content }] }` |
| `open_path` | `{ projectId, path, reveal?: boolean }` | `null` — opens file/folder in Explorer (`reveal` = select it). Path must be inside the project. |
| `asset_url_allowed` | `{ projectId }` | `{ allowed: boolean }` — project root is added to the asset-protocol scope (so `convertFileSrc(path)` works in `<video>`). |

```ts
Probe = { durationS: number|null, width, height, fps: number|null, vcodec, acodec: string|null,
          bitRate: number|null, sizeBytes: number }
```

---

## 11. Autonomous production (v1.3)

A production turns a topic into a finished episode: allocate episode → isolated worktree → research & script (Claude) →
animation code (Claude, optional) → voice (CosyVoice) + Whisper pronunciation check → timeline → stills + AI review →
zh-TW 30 fps render + QA → YouTube 1.5× + QA → Bilibili zh-CN + QA → thumbnails → publish metadata (text only) →
deliver (move outputs to the project root, merge the branch, remove the worktree). Heavy steps are ordinary queue jobs.
Nothing is uploaded or published.

| command | args | returns |
|---|---|---|
| `auto_defaults` | — | `{ config: AutoConfig, stages: {id,label}[] }` |
| `auto_start` | `{ projectId, config: AutoConfig }` | `Production` (status `queued`; episode reserved) |
| `auto_list` | `{ limit? }` | `Production[]` newest first |
| `auto_get` | `{ id }` | `Production` |
| `auto_events` | `{ id, afterId?, limit? }` | `{ id, ts, level, stage, line }[]` |
| `auto_control` | `{ id, action: "pause"\|"resume"\|"stop"\|"discard"\|"remove" }` | `Production` (or `{removed:true}`) |

```ts
AutoConfig = { topic: string, minutes: number /*0.5–20*/, style: "ai"|"generic", tone, audience, notes: string,
  youtube, bilibili, thumbnail, publishInfo, visualReview, pronunciationCheck: boolean,
  maxAttempts /*per stage, 1–10, default 3*/, maxMinutes /*active time, default 480*/, maxTurns /*per Claude run, default 80*/,
  billing: "subscription" /*default*/ | "api", budgetUsd: number|null /*required for api, ignored for subscription*/ }
Production = { id, projectId, episode, config: AutoConfig,
  status: "queued"|"running"|"paused"|"paused_limit"|"needs_merge"|"succeeded"|"failed"|"canceled",
  stage, action, attempt, mode: "main"|"fix", jobId: string|null, worktree: string|null, branch, message: string|null,
  warnings: string[], activeMs, claudeCostUsd /*sum of Claude Code total_cost_usd: model-equivalent estimate, not a charge in subscription mode*/,
  claudeRuns, outputs: string[], stages: { id, label, status: "pending"|"running"|"done"|"warned"|"failed"|"skipped",
  attempts, startedAt, finishedAt, checkpoint /*short sha in the worktree*/, note }[], createdAt, startedAt, finishedAt }
```

Rules: one production runs at a time (GPU). Failed check → Claude fix job → stage re-runs, up to `maxAttempts`;
pronunciation / visual review / QA / thumbnail / metadata end with a **warning** when attempts run out, a crashed
render or TTS stops the production (`failed`; project untouched; `resume` retries the stage with fresh attempts,
`discard` deletes worktree + branch). Claude usage/credit limit or missing login → `paused_limit` (progress kept, no
retry, no billing switch); `resume` continues at the same step. Transient API errors (overloaded) back off 5 min (≤ 6×,
not counted). Merge conflict on delivery → `needs_merge` (outputs are delivered anyway).

## Events (`listen(name, cb)`)

| event | payload | when |
|---|---|---|
| `job://update` | `Job` | status / progress / step change (throttled to ≤ 4/s per job) |
| `job://log` | `JobEvent` | each stdout/stderr line of a running job |
| `queue://status` | `QueueStatus` | every scheduler change, and every 5 s |
| `monitor://sample` | `MonitorSample` | every 2 s |
| `production://update` | `Production` | any production state change (and every ~5 s while a job runs) |
| `production://event` | `{ id, level, stage, line }` | each production log line |

```ts
MonitorSample = { ts: number,
  cpu: { usage: number /*%*/, cores: number },
  ram: { usedMiB: number, totalMiB: number },
  gpu: null | { name, driver, util: number, vramUsedMiB, vramTotalMiB, tempC, powerW: number|null,
                smClockMHz: number|null, encoderUtil: number|null, thermalHw: boolean, thermalSw: boolean },
  external: ExternalGpu }
```
