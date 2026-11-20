# Pikara Science Studio — Frontend ⇄ Rust API (v1)

Status: **stable v1**. Changes will be listed here in the changelog below.

## Changelog
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

Job kinds (`params`):
- `voiceover_tw` `{ seq="ep01", only?: string (space separated ids), force?: bool, speed?: number, targetCps?: number }` — GPU
- `voiceover_cn` `{ seq="ep01", only?, force?, targetCps=5.4 }` — GPU (src_cn narration, voiceover_cosy_cn, reference_cn)
- `timeline` `{ seq="ep01", src="src", estimate?: bool }` — CPU (src_cn → voice dir voiceover_cosy_cn, srt name `ep01_cn`)
- `mix` `{ seq="ep01", src="src" }` — CPU
- `render` `{ comp="EP01-30fps", mode="gpu"|"cpu"|"preview", src="src", out="EP01_Final.mp4", mix?: string, fps?: number, frames?: "a-b", concurrency?: number }` — GPU (`fps` is informational; the comp defines fps)
- `qa` `{ video="EP01_Final.mp4", seq="ep01", src="src", speed?: number }` — CPU
- `make_cn` `{}` — CPU (regenerates src_cn from src — overwrites src_cn!)
- `youtube_15x` `{ out="EP01_YouTube_zh-TW.mp4" }` — GPU, steps: scale SRT 1.5× → render EP01-YT15
- `bilibili` `{ out="EP01_Bilibili_zh-CN.mp4" }` — GPU, steps: make_cn → voiceover_cn → timeline(src_cn) → mix(src_cn) → render EP01-30fps --src src_cn → qa
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

## Events (`listen(name, cb)`)

| event | payload | when |
|---|---|---|
| `job://update` | `Job` | status / progress / step change (throttled to ≤ 4/s per job) |
| `job://log` | `JobEvent` | each stdout/stderr line of a running job |
| `queue://status` | `QueueStatus` | every scheduler change, and every 5 s |
| `monitor://sample` | `MonitorSample` | every 2 s |

```ts
MonitorSample = { ts: number,
  cpu: { usage: number /*%*/, cores: number },
  ram: { usedMiB: number, totalMiB: number },
  gpu: null | { name, driver, util: number, vramUsedMiB, vramTotalMiB, tempC, powerW: number|null,
                smClockMHz: number|null, encoderUtil: number|null, thermalHw: boolean, thermalSw: boolean },
  external: ExternalGpu }
```
