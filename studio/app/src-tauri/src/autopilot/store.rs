//! Persistence (SQLite `productions` / `production_events`) and episode / test number allocation.

use super::*;

// ------------------------------------------------------------------ persistence

pub(crate) fn row_to_prod(state: String) -> Result<Production, String> {
    serde_json::from_str(&state).map_err(|e| e.to_string())
}

pub fn save(conn: &rusqlite::Connection, p: &Production) -> Result<(), String> {
    let s = serde_json::to_string(p).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO productions (id, project_id, episode, status, state_json, created_at, updated_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, state_json=excluded.state_json, updated_ms=excluded.updated_ms",
        params![p.id, p.project_id, p.episode, p.status, s, p.created_at, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// By full id, or by a unique prefix of at least 6 characters (convenient for CLI users and agents).
pub fn get(conn: &rusqlite::Connection, id: &str) -> Result<Production, String> {
    let s: Option<String> = conn
        .query_row("SELECT state_json FROM productions WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(s) = s {
        return row_to_prod(s);
    }
    if id.len() >= 6 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        let mut st = conn.prepare("SELECT state_json FROM productions WHERE id LIKE ?1 || '%' LIMIT 2").map_err(|e| e.to_string())?;
        let rows: Vec<String> = st.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        match rows.len() {
            1 => return row_to_prod(rows.into_iter().next().unwrap()),
            2 => return Err(format!("id 開頭 {id} 對應到不只一個製作，請輸入完整 id")),
            _ => {}
        }
    }
    Err(format!("找不到製作 {id}"))
}

pub fn list(conn: &rusqlite::Connection, limit: i64) -> Result<Vec<Production>, String> {
    let mut st = conn.prepare("SELECT state_json FROM productions ORDER BY created_at DESC LIMIT ?1").map_err(|e| e.to_string())?;
    let rows = st.query_map([limit], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.filter_map(|r| r.ok()).map(row_to_prod).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PEvent {
    pub id: i64,
    pub ts: i64,
    pub level: String,
    pub stage: String,
    pub line: String,
}

pub fn events(conn: &rusqlite::Connection, id: &str, after: i64, limit: i64) -> Result<Vec<PEvent>, String> {
    let mut st = conn
        .prepare("SELECT id, ts, level, stage, line FROM production_events WHERE production_id=?1 AND id>?2 ORDER BY id ASC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![id, after, limit], |r| Ok(PEvent { id: r.get(0)?, ts: r.get(1)?, level: r.get(2)?, stage: r.get(3)?, line: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub(crate) fn event(conn: &rusqlite::Connection, p: &Production, level: &str, line: &str) {
    let _ = conn.execute(
        "INSERT INTO production_events (production_id, ts, level, stage, line) VALUES (?1,?2,?3,?4,?5)",
        params![p.id, now_ms(), level, p.stage, line],
    );
}

// ------------------------------------------------------------------ episode allocation

/// Next episode id that is not used anywhere: zh-TW / zh-CN narration, output files in the project root,
/// other productions (active or not) and `studio/auto/*` branches. Never overwrites an existing episode.
pub fn allocate_episode(conn: &rusqlite::Connection, root: &Path) -> Result<String, String> {
    let mut used: Vec<u32> = vec![];
    for loc in ["zh-TW", "zh-CN"] {
        if let Ok(r) = crate::narration::read(root, loc) {
            if let Some(m) = r["doc"]["sequences"].as_object() {
                used.extend(m.keys().filter_map(|k| crate::episodes::number(k)));
            }
        }
    }
    static RE_OUT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^EP(\d{2,3})[_.]").unwrap());
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if let Some(c) = RE_OUT.captures(&e.file_name().to_string_lossy()) {
                used.extend(c[1].parse::<u32>().ok());
            }
        }
    }
    let mut st = conn.prepare("SELECT episode FROM productions").map_err(|e| e.to_string())?;
    let eps: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    used.extend(eps.iter().filter_map(|e| crate::episodes::number(e)));
    if let Ok(o) = git(root, &["branch", "--list", "studio/auto/*", "--format=%(refname:short)"]) {
        static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"studio/auto/ep(\d{2,3})-").unwrap());
        for l in o.stdout.lines() {
            if let Some(c) = RE_BR.captures(l) {
                used.extend(c[1].parse::<u32>().ok());
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(root.join("projects")) {
        for e in rd.flatten() {
            used.extend(crate::episodes::number(&e.file_name().to_string_lossy().to_ascii_lowercase()));
        }
    }
    let n = used.into_iter().max().unwrap_or(0) + 1;
    if n > 999 {
        return Err("集數已達上限 ep999".into());
    }
    Ok(format!("ep{n:02}"))
}

/// Sandbox productions use TEST numbers and never take a formal episode number.
pub fn allocate_test(conn: &rusqlite::Connection, root: &Path) -> Result<String, String> {
    let mut st = conn.prepare("SELECT episode FROM productions").map_err(|e| e.to_string())?;
    let eps: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let mut used = eps;
    if let Ok(o) = git(root, &["branch", "--list", "studio/auto/*", "--format=%(refname:short)"]) {
        static RE_TB: Lazy<Regex> = Lazy::new(|| Regex::new(r"studio/auto/(test\d{3})-").unwrap());
        used.extend(o.stdout.lines().filter_map(|l| RE_TB.captures(l).map(|c| c[1].to_string())));
    }
    Ok(crate::layout::next_test(root, &used))
}
