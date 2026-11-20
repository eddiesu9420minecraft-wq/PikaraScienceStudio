//! SQLite persistence (rusqlite, WAL). Schema versioned with PRAGMA user_version.

use crate::util::{now_iso, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub type Db = Arc<Mutex<Connection>>;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema (subset of ARCHITECTURE.md §8 actually used by v0.1)
    r#"
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      root_path  TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      opened_at  TEXT
    );
    CREATE TABLE jobs (
      id            TEXT PRIMARY KEY,
      project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
      kind          TEXT NOT NULL,
      label         TEXT NOT NULL,
      params_json   TEXT NOT NULL DEFAULT '{}',
      resource      TEXT NOT NULL DEFAULT 'cpu' CHECK (resource IN ('cpu','net','gpu')),
      status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','waiting_resource','running','succeeded','failed','canceled','interrupted')),
      progress      REAL NOT NULL DEFAULT 0,
      progress_text TEXT,
      step          INTEGER NOT NULL DEFAULT 0,
      steps_json    TEXT NOT NULL DEFAULT '[]',
      attempt       INTEGER NOT NULL DEFAULT 0,
      pid           INTEGER,
      exit_code     INTEGER,
      error         TEXT,
      wait_reason   TEXT,
      log_path      TEXT,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      heartbeat_ms  INTEGER
    );
    CREATE INDEX idx_jobs_status ON jobs(status, created_at);
    CREATE TABLE job_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      stream  TEXT NOT NULL CHECK (stream IN ('stdout','stderr','system')),
      level   TEXT NOT NULL CHECK (level IN ('info','warn','error')),
      line    TEXT NOT NULL
    );
    CREATE INDEX idx_events_job ON job_events(job_id, id);
    CREATE TABLE env_checks (
      id          TEXT NOT NULL,
      ts          TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('ok','warn','error','skipped')),
      detail_json TEXT NOT NULL,
      PRIMARY KEY (id, ts)
    );
    CREATE TABLE metrics (
      ts INTEGER NOT NULL, job_id TEXT, gpu REAL, vram_mib INTEGER, enc REAL, temp_c INTEGER,
      power_w REAL, cpu REAL, ram_mib INTEGER
    );
    CREATE INDEX idx_metrics_ts ON metrics(ts);
    "#,
];

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    init(&conn)?;
    Ok(conn)
}

pub fn open_memory() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    init(&conn)?;
    Ok(conn)
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    migrate(conn)
}

pub fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let v = user_version(conn) as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(v) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))
            .map_err(|e| format!("migration {}: {e}", i + 1))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- settings

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub queue_enabled: bool,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
    pub gpu_vram_busy_mib: u32,
    pub max_cpu_jobs: u32,
    pub keep_awake: bool,
    pub claude_max_turns: u32,
    pub claude_max_budget_usd: Option<f64>,
    pub node_dir: String,
    pub cosy_python: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            queue_enabled: true,
            window_start: None,
            window_end: None,
            gpu_vram_busy_mib: 2500,
            max_cpu_jobs: 2,
            keep_awake: true,
            claude_max_turns: 30,
            claude_max_budget_usd: None,
            node_dir: r"C:\Program Files\nodejs".into(),
            cosy_python: None,
        }
    }
}

pub fn settings_get(conn: &Connection) -> Settings {
    let v: Option<String> = conn
        .query_row("SELECT value_json FROM settings WHERE key='app'", [], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn settings_merge(conn: &Connection, patch: &Value) -> Result<Settings, String> {
    let cur = serde_json::to_value(settings_get(conn)).map_err(|e| e.to_string())?;
    let mut obj = cur.as_object().cloned().unwrap_or_default();
    if let Some(p) = patch.as_object() {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    let s: Settings = serde_json::from_value(Value::Object(obj)).map_err(|e| format!("invalid settings: {e}"))?;
    conn.execute(
        "INSERT INTO settings(key,value_json,updated_at) VALUES('app',?1,?2)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        params![serde_json::to_string(&s).unwrap(), now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(s)
}

// ---------------------------------------------------------------- projects

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub opened_at: Option<String>,
}

fn row_project(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project { id: r.get(0)?, name: r.get(1)?, root_path: r.get(2)?, created_at: r.get(3)?, opened_at: r.get(4)? })
}

pub fn project_upsert(conn: &Connection, root: &str, name: &str) -> Result<Project, String> {
    let now = now_iso();
    let existing: Option<String> = conn
        .query_row("SELECT id FROM projects WHERE lower(root_path)=lower(?1)", [root], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let id = match existing {
        Some(id) => {
            conn.execute("UPDATE projects SET opened_at=?1 WHERE id=?2", params![now, id]).map_err(|e| e.to_string())?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO projects(id,name,root_path,created_at,opened_at) VALUES(?1,?2,?3,?4,?4)",
                params![id, name, root, now],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    project_get(conn, &id)
}

pub fn project_get(conn: &Connection, id: &str) -> Result<Project, String> {
    conn.query_row("SELECT id,name,root_path,created_at,opened_at FROM projects WHERE id=?1", [id], row_project)
        .map_err(|_| format!("unknown project {id}"))
}

pub fn project_list(conn: &Connection) -> Result<Vec<Project>, String> {
    let mut st = conn
        .prepare("SELECT id,name,root_path,created_at,opened_at FROM projects ORDER BY coalesce(opened_at,created_at) DESC")
        .map_err(|e| e.to_string())?;
    let rows = st.query_map([], row_project).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn project_remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM projects WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- jobs

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// Simplified-Chinese label for the UI's 简 toggle (null for free-form labels).
    pub label_cn: Option<String>,
    pub project_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub params: Value,
    pub resource: String,
    pub status: String,
    pub progress: f64,
    pub progress_text: Option<String>,
    pub step: i64,
    pub steps: Vec<String>,
    pub attempt: i64,
    pub pid: Option<i64>,
    pub exit_code: Option<i64>,
    pub error: Option<String>,
    pub wait_reason: Option<String>,
    pub log_path: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub heartbeat_at: Option<String>,
}

const JOB_COLS: &str = "id,project_id,kind,label,params_json,resource,status,progress,progress_text,step,steps_json,attempt,pid,exit_code,error,wait_reason,log_path,created_at,started_at,finished_at,heartbeat_at";

fn row_job(r: &Row) -> rusqlite::Result<Job> {
    let params: String = r.get(4)?;
    let steps: String = r.get(10)?;
    let kind: String = r.get(2)?;
    let label: String = r.get(3)?;
    let base = crate::jobs::kinds().into_iter().find(|k| k.kind == kind).map(|k| k.label);
    let label_cn = if base == Some(label.as_str()) || kind == "claude" || kind == "doctor_fix" {
        crate::i18n::cn_label(&kind).map(String::from)
    } else {
        None
    };
    Ok(Job {
        label_cn,
        id: r.get(0)?,
        project_id: r.get(1)?,
        kind: r.get(2)?,
        label: r.get(3)?,
        params: serde_json::from_str(&params).unwrap_or(json!({})),
        resource: r.get(5)?,
        status: r.get(6)?,
        progress: r.get(7)?,
        progress_text: r.get(8)?,
        step: r.get(9)?,
        steps: serde_json::from_str(&steps).unwrap_or_default(),
        attempt: r.get(11)?,
        pid: r.get(12)?,
        exit_code: r.get(13)?,
        error: r.get(14)?,
        wait_reason: r.get(15)?,
        log_path: r.get(16)?,
        created_at: r.get(17)?,
        started_at: r.get(18)?,
        finished_at: r.get(19)?,
        heartbeat_at: r.get(20)?,
    })
}

pub fn job_insert(
    conn: &Connection,
    project_id: Option<&str>,
    kind: &str,
    label: &str,
    params: &Value,
    resource: &str,
    steps: &[String],
) -> Result<Job, String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO jobs(id,project_id,kind,label,params_json,resource,steps_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, project_id, kind, label, params.to_string(), resource, serde_json::to_string(steps).unwrap(), now_iso()],
    )
    .map_err(|e| e.to_string())?;
    job_get(conn, &id)
}

pub fn job_get(conn: &Connection, id: &str) -> Result<Job, String> {
    conn.query_row(&format!("SELECT {JOB_COLS} FROM jobs WHERE id=?1"), [id], row_job)
        .map_err(|_| format!("unknown job {id}"))
}

pub fn job_list(conn: &Connection, project_id: Option<&str>, status: Option<&str>, limit: i64) -> Result<Vec<Job>, String> {
    let mut sql = format!("SELECT {JOB_COLS} FROM jobs WHERE 1=1");
    let mut args: Vec<String> = vec![];
    if let Some(p) = project_id {
        args.push(p.to_string());
        sql.push_str(&format!(" AND project_id=?{}", args.len()));
    }
    if let Some(s) = status {
        args.push(s.to_string());
        sql.push_str(&format!(" AND status=?{}", args.len()));
    }
    sql.push_str(&format!(" ORDER BY created_at DESC LIMIT {}", limit.max(1)));
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), row_job).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Queued/waiting jobs in FIFO order.
pub fn jobs_pending(conn: &Connection) -> Result<Vec<Job>, String> {
    let mut st = conn
        .prepare(&format!(
            "SELECT {JOB_COLS} FROM jobs WHERE status IN ('queued','waiting_resource') ORDER BY created_at ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = st.query_map([], row_job).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn job_set_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    conn.execute("UPDATE jobs SET status=?1 WHERE id=?2", params![status, id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_set_waiting(conn: &Connection, id: &str, reason: Option<&str>) -> Result<bool, String> {
    let status = if reason.is_some() { "waiting_resource" } else { "queued" };
    let n = conn
        .execute(
            "UPDATE jobs SET status=?1, wait_reason=?2 WHERE id=?3 AND status IN ('queued','waiting_resource')
             AND (status<>?1 OR coalesce(wait_reason,'')<>coalesce(?2,''))",
            params![status, reason, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn job_mark_started(conn: &Connection, id: &str, log_path: &str) -> Result<(), String> {
    let now = now_iso();
    conn.execute(
        "UPDATE jobs SET status='running', started_at=coalesce(started_at,?1), finished_at=NULL, wait_reason=NULL,
         error=NULL, exit_code=NULL, heartbeat_at=?1, heartbeat_ms=?2, log_path=?3 WHERE id=?4",
        params![now, now_ms(), log_path, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_set_pid(conn: &Connection, id: &str, pid: Option<u32>) -> Result<(), String> {
    conn.execute("UPDATE jobs SET pid=?1 WHERE id=?2", params![pid, id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_set_step(conn: &Connection, id: &str, step: i64) -> Result<(), String> {
    conn.execute("UPDATE jobs SET step=?1 WHERE id=?2", params![step, id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_set_progress(conn: &Connection, id: &str, progress: f64, text: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET progress=?1, progress_text=coalesce(?2, progress_text) WHERE id=?3",
        params![progress.clamp(0.0, 1.0), text, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_heartbeat(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET heartbeat_at=?1, heartbeat_ms=?2 WHERE id=?3 AND status='running'",
        params![now_iso(), now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job_finish(conn: &Connection, id: &str, status: &str, exit_code: Option<i32>, error: Option<&str>) -> Result<(), String> {
    let progress_sql = if status == "succeeded" { ", progress=1" } else { "" };
    conn.execute(
        &format!("UPDATE jobs SET status=?1, exit_code=?2, error=?3, finished_at=?4, pid=NULL{progress_sql} WHERE id=?5"),
        params![status, exit_code, error, now_iso(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// failed / canceled / interrupted → queued (attempt+1). Keeps `step` so multi-step jobs resume.
pub fn job_requeue(conn: &Connection, id: &str) -> Result<Job, String> {
    let n = conn
        .execute(
            "UPDATE jobs SET status='queued', attempt=attempt+1, error=NULL, exit_code=NULL, finished_at=NULL, pid=NULL, wait_reason=NULL
             WHERE id=?1 AND status IN ('failed','canceled','interrupted','succeeded')",
            [id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("job is not in a retryable state".into());
    }
    job_get(conn, id)
}

pub fn job_remove(conn: &Connection, id: &str) -> Result<(), String> {
    let j = job_get(conn, id)?;
    if j.status == "running" {
        return Err("cannot remove a running job; cancel it first".into());
    }
    conn.execute("DELETE FROM jobs WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Startup recovery: running jobs whose heartbeat is older than `stale_ms` → interrupted.
/// Returns the ids that were marked.
pub fn recover_stale(conn: &Connection, stale_ms: i64, now: i64) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare("SELECT id FROM jobs WHERE status='running' AND (heartbeat_ms IS NULL OR heartbeat_ms < ?1)")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = st
        .query_map([now - stale_ms], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for id in &ids {
        conn.execute(
            "UPDATE jobs SET status='interrupted', pid=NULL, error='Studio 結束或電腦睡眠時工作中斷（heartbeat 過期）', finished_at=?1 WHERE id=?2",
            params![now_iso(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(ids)
}

// ---------------------------------------------------------------- events

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: i64,
    pub job_id: String,
    pub ts: i64,
    pub stream: String,
    pub level: String,
    pub line: String,
}

pub fn event_add(conn: &Connection, job_id: &str, stream: &str, level: &str, line: &str) -> Result<JobEvent, String> {
    let ts = now_ms();
    conn.execute(
        "INSERT INTO job_events(job_id,ts,stream,level,line) VALUES(?1,?2,?3,?4,?5)",
        params![job_id, ts, stream, level, line],
    )
    .map_err(|e| e.to_string())?;
    Ok(JobEvent {
        id: conn.last_insert_rowid(),
        job_id: job_id.into(),
        ts,
        stream: stream.into(),
        level: level.into(),
        line: line.into(),
    })
}

pub fn events_list(conn: &Connection, job_id: &str, after_id: i64, limit: i64) -> Result<Vec<JobEvent>, String> {
    let mut st = conn
        .prepare("SELECT id,job_id,ts,stream,level,line FROM job_events WHERE job_id=?1 AND id>?2 ORDER BY id ASC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![job_id, after_id, limit], |r| {
            Ok(JobEvent { id: r.get(0)?, job_id: r.get(1)?, ts: r.get(2)?, stream: r.get(3)?, level: r.get(4)?, line: r.get(5)? })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn env_check_add(conn: &Connection, id: &str, status: &str, detail: &Value) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO env_checks(id,ts,status,detail_json) VALUES(?1,?2,?3,?4)",
        params![id, now_iso(), status, detail.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn metric_add(conn: &Connection, s: &Value) -> Result<(), String> {
    let g = &s["gpu"];
    conn.execute(
        "INSERT INTO metrics(ts,gpu,vram_mib,enc,temp_c,power_w,cpu,ram_mib) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            s["ts"].as_i64().unwrap_or(0),
            g["util"].as_f64(),
            g["vramUsedMiB"].as_i64(),
            g["encoderUtil"].as_f64(),
            g["tempC"].as_i64(),
            g["powerW"].as_f64(),
            s["cpu"]["usage"].as_f64(),
            s["ram"]["usedMiB"].as_i64()
        ],
    )
    .map_err(|e| e.to_string())?;
    // keep 7 days
    conn.execute("DELETE FROM metrics WHERE ts < ?1", [now_ms() - 7 * 86_400_000]).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_once_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("pss-db-{}", uuid::Uuid::new_v4()));
        let p = dir.join("studio.db");
        {
            let c = open(&p).unwrap();
            assert_eq!(user_version(&c), MIGRATIONS.len() as i64);
            let pr = project_upsert(&c, r"D:\X", "X").unwrap();
            let j = job_insert(&c, Some(&pr.id), "qa", "QA", &json!({"video":"a.mp4"}), "cpu", &["qa".into()]).unwrap();
            assert_eq!(j.status, "queued");
            event_add(&c, &j.id, "stdout", "info", "hello 中文").unwrap();
        }
        // second open must not re-run migrations (would fail on CREATE TABLE)
        let c = open(&p).unwrap();
        assert_eq!(user_version(&c), MIGRATIONS.len() as i64);
        let jobs = job_list(&c, None, None, 10).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].params["video"], "a.mp4");
        let ev = events_list(&c, &jobs[0].id, 0, 10).unwrap();
        assert_eq!(ev[0].line, "hello 中文");
        // same root (case-insensitive) → same project
        let a = project_upsert(&c, r"d:\x", "X").unwrap();
        assert_eq!(a.id, jobs[0].project_id.clone().unwrap());
        drop(c);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_merge_and_defaults() {
        let c = open_memory().unwrap();
        assert_eq!(settings_get(&c).gpu_vram_busy_mib, 2500);
        let s = settings_merge(&c, &json!({"maxCpuJobs": 3, "windowStart": "01:00"})).unwrap();
        assert_eq!(s.max_cpu_jobs, 3);
        assert_eq!(settings_get(&c).window_start.as_deref(), Some("01:00"));
        assert!(settings_merge(&c, &json!({"maxCpuJobs": "x"})).is_err());
    }

    #[test]
    fn stale_running_jobs_become_interrupted_and_requeue() {
        let c = open_memory().unwrap();
        let j = job_insert(&c, None, "render", "R", &json!({}), "gpu", &[]).unwrap();
        job_mark_started(&c, &j.id, "x.log").unwrap();
        let fresh = job_insert(&c, None, "qa", "Q", &json!({}), "cpu", &[]).unwrap();
        job_mark_started(&c, &fresh.id, "y.log").unwrap();
        // pretend the first job's heartbeat is 60 s old
        c.execute("UPDATE jobs SET heartbeat_ms=heartbeat_ms-60000 WHERE id=?1", [&j.id]).unwrap();
        let ids = recover_stale(&c, 20_000, now_ms()).unwrap();
        assert_eq!(ids, vec![j.id.clone()]);
        assert_eq!(job_get(&c, &j.id).unwrap().status, "interrupted");
        assert_eq!(job_get(&c, &fresh.id).unwrap().status, "running");
        let r = job_requeue(&c, &j.id).unwrap();
        assert_eq!(r.status, "queued");
        assert_eq!(r.attempt, 1);
        assert!(job_requeue(&c, &fresh.id).is_err());
        assert!(job_remove(&c, &fresh.id).is_err());
    }
}
