//! # pikara-splash
//!
//! The Pikara brand startup screen as a Tauri 2 plugin, shared by every Pikara app
//! (Create Your World, Pikara Science Studio, …). Frontend: `web/` in this crate.
//!
//! Contract:
//! * window `splash` — small, frameless, transparent, created hidden. Its page calls `shown`
//!   after the first paint so the window never flashes white (a timer shows it anyway).
//! * window `main` — created hidden. Its page waits for `wait_ready`, loads its real data,
//!   renders, then calls `main_ready`.
//! * the backend runs its real initialization on its own thread / task and reports each step
//!   with [`Splash::begin`] / [`Splash::done`] / [`Splash::warn`] / [`Splash::skip`], or
//!   [`Splash::fail`] which shows the error with recovery actions and returns the one the user
//!   picks. [`Splash::backend_done`] ends the backend part.
//! * as soon as both sides are ready the splash gets `pikara-splash://complete`: it starts its
//!   exit animation and at the same moment reveals the main window (no waiting for animations),
//!   then closes itself. Safety timers make sure the app never stays on the splash because a
//!   page failed to answer; only an explicit failure waits for the user.
//!
//! Nothing here sleeps on purpose, except the test hook `PIKARA_SPLASH_TEST_DELAY`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tokio::sync::watch;

pub const EVT_STATUS: &str = "pikara-splash://status";
pub const EVT_COMPLETE: &str = "pikara-splash://complete";
pub const EVT_REVEAL: &str = "pikara-splash://reveal";

/// Built-in action: quits the app (handled by the plugin).
pub const ACTION_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Pending,
    Running,
    Done,
    Warn,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    pub id: String,
    pub label: String,
    pub state: StepState,
    pub detail: Option<String>,
    /// How long the step took (ms), once finished.
    pub ms: Option<u64>,
}

/// A button on the splash. `quit` is built in; every other id is handled by the app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub label: String,
    pub primary: bool,
}

impl Action {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into(), primary: false }
    }
    pub fn primary(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into(), primary: true }
    }
    pub fn quit(label: impl Into<String>) -> Self {
        Self::new(ACTION_QUIT, label)
    }
}

/// A failure the user has to decide about.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub step: Option<String>,
    pub title: String,
    pub detail: String,
    pub actions: Vec<Action>,
}

impl Failure {
    pub fn new(step: &str, title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { step: Some(step.to_string()), title: title.into(), detail: detail.into(), actions: vec![] }
    }
    pub fn action(mut self, a: Action) -> Self {
        self.actions.push(a);
        self
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    /// Wall clock (Unix ms) when the plugin was created — near process start.
    pub started_unix_ms: u64,
    /// Below: ms since `started_unix_ms`.
    pub shown_ms: Option<u64>,
    pub backend_done_ms: Option<u64>,
    pub frontend_ready_ms: Option<u64>,
    pub complete_ms: Option<u64>,
    pub revealed_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Increases with every change. The status reply and the status events can arrive in either
    /// order; the frontend ignores anything older than what it already shows.
    pub seq: u64,
    pub app_name: String,
    pub version: String,
    pub steps: Vec<StepView>,
    pub current: Option<String>,
    pub message: String,
    /// ms the current step has been running, at the time of this snapshot.
    pub step_elapsed_ms: Option<u64>,
    /// The current step passed `slow_after`; `slow_actions` are offered.
    pub slow: bool,
    pub slow_actions: Vec<Action>,
    pub failure: Option<Failure>,
    pub warnings: Vec<String>,
    pub backend_done: bool,
    pub frontend_ready: bool,
    pub complete: bool,
    pub timings: Timings,
    /// Set when a `PIKARA_SPLASH_TEST_*` hook is active, so a test run is never mistaken for a real one.
    pub test_hooks: Option<String>,
}

type ActionHandler<R> = Arc<dyn Fn(&AppHandle<R>, &str) + Send + Sync>;

/// Plugin configuration. Build with [`Config::new`] and the chained setters.
pub struct Config<R: Runtime> {
    steps: Vec<(String, String)>,
    splash_label: String,
    main_label: String,
    show_fallback: Duration,
    frontend_timeout: Duration,
    close_timeout: Duration,
    slow_after: Duration,
    slow_actions: Vec<(Option<String>, Action)>,
    on_action: Option<ActionHandler<R>>,
    initial_message: String,
    ui_message: String,
    ready_message: String,
}

impl<R: Runtime> Default for Config<R> {
    fn default() -> Self {
        Self {
            steps: vec![],
            splash_label: "splash".into(),
            main_label: "main".into(),
            show_fallback: Duration::from_millis(1500),
            frontend_timeout: Duration::from_secs(10),
            close_timeout: Duration::from_secs(4),
            slow_after: Duration::from_secs(8),
            slow_actions: vec![],
            on_action: None,
            initial_message: "正在啟動…".into(),
            ui_message: "正在載入介面…".into(),
            ready_message: "準備就緒".into(),
        }
    }
}

impl<R: Runtime> Config<R> {
    pub fn new() -> Self {
        Self::default()
    }
    /// Declare an initialization step (in order). `label` is the short name shown in the step list.
    pub fn step(mut self, id: &str, label: &str) -> Self {
        self.steps.push((id.into(), label.into()));
        self
    }
    pub fn windows(mut self, splash: &str, main: &str) -> Self {
        self.splash_label = splash.into();
        self.main_label = main.into();
        self
    }
    /// After this long in one step the splash says so and offers `slow_actions`.
    pub fn slow_after(mut self, d: Duration) -> Self {
        self.slow_after = d;
        self
    }
    /// Offered on any slow step.
    pub fn slow_action(mut self, a: Action) -> Self {
        self.slow_actions.push((None, a));
        self
    }
    /// Offered only while step `id` is slow (e.g. "skip the network check").
    pub fn slow_action_for(mut self, id: &str, a: Action) -> Self {
        self.slow_actions.push((Some(id.to_string()), a));
        self
    }
    /// Main window must report `main_ready` within this time after the backend is done, or it is shown anyway.
    pub fn frontend_timeout(mut self, d: Duration) -> Self {
        self.frontend_timeout = d;
        self
    }
    /// Called for every action the user picks (failure or slow buttons), before waiters wake up.
    pub fn on_action(mut self, f: impl Fn(&AppHandle<R>, &str) + Send + Sync + 'static) -> Self {
        self.on_action = Some(Arc::new(f));
        self
    }
    pub fn messages(mut self, initial: &str, loading_ui: &str, ready: &str) -> Self {
        self.initial_message = initial.into();
        self.ui_message = loading_ui.into();
        self.ready_message = ready.into();
        self
    }
}

struct Inner {
    snap: Snapshot,
    step_started: Option<Instant>,
}

/// The splash controller, managed as Tauri state. Get it with [`SplashExt::splash`].
pub struct Splash<R: Runtime> {
    inner: Mutex<Inner>,
    app: OnceLock<AppHandle<R>>,
    ready_tx: watch::Sender<bool>,
    /// (sequence, action id) of the latest user action.
    action_tx: watch::Sender<(u64, String)>,
    action_seq: AtomicU64,
    revealed: AtomicBool,
    started: Instant,
    splash_label: String,
    main_label: String,
    show_fallback: Duration,
    frontend_timeout: Duration,
    close_timeout: Duration,
    slow_after: Duration,
    slow_actions: Vec<(Option<String>, Action)>,
    on_action: Option<ActionHandler<R>>,
    ui_message: String,
    ready_message: String,
    test_delays: Vec<(String, u64)>,
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn parse_delays(v: &str) -> Vec<(String, u64)> {
    v.split(',')
        .filter_map(|p| {
            let (id, ms) = p.split_once(':')?;
            Some((id.trim().to_string(), ms.trim().parse().ok()?))
        })
        .collect()
}

impl<R: Runtime> Splash<R> {
    fn new(cfg: Config<R>) -> Self {
        let delays = std::env::var("PIKARA_SPLASH_TEST_DELAY").map(|v| parse_delays(&v)).unwrap_or_default();
        let fail = std::env::var("PIKARA_SPLASH_TEST_FAIL").ok().filter(|s| !s.is_empty());
        let mut hooks = vec![];
        if !delays.is_empty() {
            hooks.push(format!("PIKARA_SPLASH_TEST_DELAY={}", std::env::var("PIKARA_SPLASH_TEST_DELAY").unwrap_or_default()));
        }
        if let Some(f) = &fail {
            hooks.push(format!("PIKARA_SPLASH_TEST_FAIL={f}"));
        }
        let steps = cfg
            .steps
            .iter()
            .map(|(id, label)| StepView { id: id.clone(), label: label.clone(), state: StepState::Pending, detail: None, ms: None })
            .collect();
        let snap = Snapshot {
            seq: 0,
            app_name: String::new(),
            version: String::new(),
            steps,
            current: None,
            message: cfg.initial_message.clone(),
            step_elapsed_ms: None,
            slow: false,
            slow_actions: vec![],
            failure: None,
            warnings: vec![],
            backend_done: false,
            frontend_ready: false,
            complete: false,
            timings: Timings { started_unix_ms: unix_ms(), ..Default::default() },
            test_hooks: (!hooks.is_empty()).then(|| hooks.join(" ")),
        };
        Self {
            inner: Mutex::new(Inner { snap, step_started: None }),
            app: OnceLock::new(),
            ready_tx: watch::channel(false).0,
            action_tx: watch::channel((0, String::new())).0,
            action_seq: AtomicU64::new(0),
            revealed: AtomicBool::new(false),
            started: Instant::now(),
            splash_label: cfg.splash_label,
            main_label: cfg.main_label,
            show_fallback: cfg.show_fallback,
            frontend_timeout: cfg.frontend_timeout,
            close_timeout: cfg.close_timeout,
            slow_after: cfg.slow_after,
            slow_actions: cfg.slow_actions,
            on_action: cfg.on_action,
            ui_message: cfg.ui_message,
            ready_message: cfg.ready_message,
            test_delays: delays,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn snapshot(&self) -> Snapshot {
        let g = self.lock();
        let mut s = g.snap.clone();
        s.step_elapsed_ms = g.step_started.map(|t| t.elapsed().as_millis() as u64);
        if s.slow {
            let cur = s.current.as_deref();
            s.slow_actions = self
                .slow_actions
                .iter()
                .filter(|(step, _)| step.is_none() || step.as_deref() == cur)
                .map(|(_, a)| a.clone())
                .collect();
        }
        s
    }

    fn publish(&self) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(EVT_STATUS, self.snapshot());
        }
    }

    fn update(&self, f: impl FnOnce(&mut Inner)) {
        {
            let mut g = self.lock();
            f(&mut g);
            g.snap.seq += 1;
        }
        self.publish();
    }

    fn finish_running(inner: &mut Inner, state: StepState) {
        let ms = inner.step_started.take().map(|t| t.elapsed().as_millis() as u64);
        if let Some(cur) = inner.snap.current.take() {
            if let Some(s) = inner.snap.steps.iter_mut().find(|s| s.id == cur) {
                if s.state == StepState::Running {
                    s.state = state;
                    s.ms = ms;
                }
            }
        }
        inner.snap.slow = false;
    }

    /// Start step `id` (a still-running previous step is marked done). `message` is the status line.
    pub fn begin(&self, id: &str, message: impl Into<String>) {
        let message = message.into();
        self.update(|i| {
            Self::finish_running(i, StepState::Done);
            if let Some(s) = i.snap.steps.iter_mut().find(|s| s.id == id) {
                s.state = StepState::Running;
                s.detail = None;
                s.ms = None;
            }
            i.snap.current = Some(id.to_string());
            i.snap.message = message;
            i.step_started = Some(Instant::now());
        });
        // TEST ONLY: PIKARA_SPLASH_TEST_DELAY=step:ms[,step:ms] makes a step artificially slow.
        if let Some((_, ms)) = self.test_delays.iter().find(|(s, _)| s == id) {
            std::thread::sleep(Duration::from_millis(*ms));
        }
    }

    fn set_step(&self, id: &str, state: StepState, detail: Option<String>) {
        self.update(|i| {
            let running = i.snap.current.as_deref() == Some(id);
            if running {
                Self::finish_running(i, state);
            }
            if let Some(s) = i.snap.steps.iter_mut().find(|s| s.id == id) {
                s.state = state;
                if detail.is_some() {
                    s.detail = detail.clone();
                }
            }
            if state == StepState::Warn {
                if let Some(d) = &detail {
                    i.snap.warnings.push(d.clone());
                }
            }
        });
    }

    pub fn done(&self, id: &str) {
        self.set_step(id, StepState::Done, None);
    }
    /// Done, with a short result shown next to the step (e.g. "已恢復 2 個工作").
    pub fn done_with(&self, id: &str, detail: impl Into<String>) {
        self.set_step(id, StepState::Done, Some(detail.into()));
    }
    /// Non-fatal problem: the step finished but the user should know (also listed in `warnings`).
    pub fn warn(&self, id: &str, detail: impl Into<String>) {
        self.set_step(id, StepState::Warn, Some(detail.into()));
    }
    pub fn skip(&self, id: &str, detail: impl Into<String>) {
        self.set_step(id, StepState::Skipped, Some(detail.into()));
    }

    /// TEST ONLY: `PIKARA_SPLASH_TEST_FAIL=<step>` — lets an app inject a failure into that step to
    /// exercise its recovery path. Returns the injected error text. Cleared after the first retry.
    pub fn injected_failure(&self, id: &str) -> Option<String> {
        let v = std::env::var("PIKARA_SPLASH_TEST_FAIL").ok()?;
        if v != id {
            return None;
        }
        std::env::remove_var("PIKARA_SPLASH_TEST_FAIL");
        Some(format!("測試注入的失敗（PIKARA_SPLASH_TEST_FAIL={id}）"))
    }

    fn set_failure(&self, f: Failure) {
        self.update(|i| {
            let ms = i.step_started.map(|t| t.elapsed().as_millis() as u64);
            if let Some(id) = f.step.clone().or_else(|| i.snap.current.clone()) {
                if let Some(s) = i.snap.steps.iter_mut().find(|s| s.id == id) {
                    s.state = StepState::Failed;
                    s.ms = ms;
                    s.detail = Some(f.title.clone());
                }
            }
            i.snap.slow = false;
            i.snap.message = f.title.clone();
            i.snap.failure = Some(f);
        });
        // a failed start must be visible even if the splash page has not reported first paint yet
        if let Some(app) = self.app.get() {
            show_window(app, &self.splash_label);
        }
    }

    fn clear_failure(&self) {
        self.update(|i| {
            i.snap.failure = None;
            if let Some(cur) = i.snap.current.clone() {
                if let Some(s) = i.snap.steps.iter_mut().find(|s| s.id == cur) {
                    s.state = StepState::Running;
                    s.detail = None;
                }
                i.step_started = Some(Instant::now());
            }
        });
    }

    /// Show `failure` and block this (non-async) thread until the user picks one of its actions.
    /// Returns that action id; the failure is cleared again (except for `quit`, which exits).
    pub fn fail_blocking(&self, failure: Failure) -> String {
        let ids: Vec<String> = failure.actions.iter().map(|a| a.id.clone()).collect();
        let mut rx = self.action_tx.subscribe();
        rx.borrow_and_update();
        self.set_failure(failure);
        let id = loop {
            if tauri::async_runtime::block_on(rx.changed()).is_err() {
                break ACTION_QUIT.to_string();
            }
            let (_, id) = rx.borrow_and_update().clone();
            if ids.contains(&id) {
                break id;
            }
        };
        self.clear_failure();
        id
    }

    /// Async version of [`Splash::fail_blocking`].
    pub async fn fail(&self, failure: Failure) -> String {
        let ids: Vec<String> = failure.actions.iter().map(|a| a.id.clone()).collect();
        let mut rx = self.action_tx.subscribe();
        rx.borrow_and_update();
        self.set_failure(failure);
        let id = loop {
            if rx.changed().await.is_err() {
                break ACTION_QUIT.to_string();
            }
            let (_, id) = rx.borrow_and_update().clone();
            if ids.contains(&id) {
                break id;
            }
        };
        self.clear_failure();
        id
    }

    /// Resolves when the user picks one of `ids` (e.g. a slow-step "skip" button).
    pub async fn wait_action(&self, ids: &[&str]) -> String {
        let mut rx = self.action_tx.subscribe();
        rx.borrow_and_update();
        loop {
            if rx.changed().await.is_err() {
                return ACTION_QUIT.to_string();
            }
            let (_, id) = rx.borrow_and_update().clone();
            if ids.contains(&id.as_str()) {
                return id;
            }
        }
    }

    fn user_action(&self, id: &str) {
        if let (Some(app), Some(f)) = (self.app.get(), &self.on_action) {
            f(app, id);
        }
        let seq = self.action_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.action_tx.send_replace((seq, id.to_string()));
        if id == ACTION_QUIT {
            if let Some(app) = self.app.get() {
                app.exit(0);
            }
        }
    }

    /// Backend initialization finished.
    pub fn backend_done(&self) {
        let now = self.ms();
        self.update(|i| {
            Self::finish_running(i, StepState::Done);
            i.snap.backend_done = true;
            i.snap.timings.backend_done_ms = Some(now);
            i.snap.message = self.ui_message.clone();
            i.snap.failure = None;
        });
        // send_replace stores the value even when nobody is subscribed yet (send() would drop it).
        self.ready_tx.send_replace(true);
        self.maybe_complete();
        // Safety net: never leave the user on the splash if the main page fails to report.
        if let Some(app) = self.app.get() {
            let app = app.clone();
            let d = self.frontend_timeout;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(d).await;
                app.splash().frontend_ready();
            });
        }
    }

    pub fn frontend_ready(&self) {
        let now = self.ms();
        {
            let mut i = self.lock();
            if !i.snap.frontend_ready {
                i.snap.frontend_ready = true;
                i.snap.timings.frontend_ready_ms = Some(now);
            }
        }
        self.maybe_complete();
    }

    pub async fn wait_ready(&self) {
        let mut rx = self.ready_tx.subscribe();
        let _ = rx.wait_for(|v| *v).await;
    }

    pub fn is_complete(&self) -> bool {
        self.lock().snap.complete
    }

    fn maybe_complete(&self) {
        let now = self.ms();
        let fire = {
            let mut i = self.lock();
            let s = &mut i.snap;
            if s.backend_done && s.frontend_ready && !s.complete {
                s.seq += 1;
                s.complete = true;
                s.timings.complete_ms = Some(now);
                s.message = self.ready_message.clone();
                true
            } else {
                false
            }
        };
        if !fire {
            return;
        }
        self.publish();
        let Some(app) = self.app.get() else { return };
        let _ = app.emit(EVT_COMPLETE, ());
        // Safety net: if the splash page never answers, still show the app and drop the splash.
        let app = app.clone();
        let d = self.close_timeout;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(d).await;
            reveal_main(&app);
            close_splash(&app);
        });
    }

    fn mark_shown(&self) {
        let now = self.ms();
        let mut i = self.lock();
        i.snap.timings.shown_ms.get_or_insert(now);
    }
}

/// Access the controller from any `Manager` (AppHandle, App, Window …).
pub trait SplashExt<R: Runtime> {
    fn splash(&self) -> State<'_, Splash<R>>;
}

impl<R: Runtime, T: Manager<R>> SplashExt<R> for T {
    fn splash(&self) -> State<'_, Splash<R>> {
        self.state::<Splash<R>>()
    }
}

fn show_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show the main window under the (fading) splash and tell the main page to play its reveal.
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    let s = app.splash();
    if s.revealed.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let now = s.ms();
        s.lock().snap.timings.revealed_ms = Some(now);
    }
    show_window(app, &s.main_label);
    let _ = app.emit(EVT_REVEAL, ());
    // Keep the fading splash above the freshly focused main window.
    if let Some(w) = app.get_webview_window(&s.splash_label) {
        let _ = w.set_always_on_top(true);
    }
}

pub fn close_splash<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(&app.splash().splash_label) {
        let _ = w.destroy();
    }
}

/// Bring the app to the front (e.g. from a single-instance callback): the splash while starting,
/// the main window afterwards.
pub fn focus<R: Runtime>(app: &AppHandle<R>) {
    let s = app.splash();
    let label = if s.revealed.load(Ordering::SeqCst) { &s.main_label } else { &s.splash_label };
    if let Some(w) = app.get_webview_window(label).or_else(|| app.get_webview_window(&s.main_label)) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

mod commands {
    //! All commands are async on purpose: sync commands run on the main thread, and WebView2 may be
    //! creating the main window in a nested message loop at that moment (the splash page is tiny and
    //! calls `shown` very early). Showing/focusing a window re-entrantly from there deadlocked the
    //! event loop (found in a real Studio start). Async commands post window operations instead.
    use super::*;

    #[tauri::command]
    pub async fn status<R: Runtime>(_app: AppHandle<R>, s: State<'_, Splash<R>>) -> Result<Snapshot, String> {
        Ok(s.snapshot())
    }

    #[tauri::command]
    pub async fn shown<R: Runtime>(app: AppHandle<R>, s: State<'_, Splash<R>>) -> Result<(), String> {
        s.mark_shown();
        if !s.revealed.load(Ordering::SeqCst) {
            show_window(&app, &s.splash_label);
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn reveal_main<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        super::reveal_main(&app);
        Ok(())
    }

    #[tauri::command]
    pub async fn close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        super::close_splash(&app);
        Ok(())
    }

    #[tauri::command]
    pub async fn main_ready<R: Runtime>(_app: AppHandle<R>, s: State<'_, Splash<R>>) -> Result<(), String> {
        s.frontend_ready();
        Ok(())
    }

    #[tauri::command]
    pub async fn wait_ready<R: Runtime>(_app: AppHandle<R>, s: State<'_, Splash<R>>) -> Result<(), String> {
        s.wait_ready().await;
        Ok(())
    }

    #[tauri::command]
    pub async fn action<R: Runtime>(_app: AppHandle<R>, s: State<'_, Splash<R>>, id: String) -> Result<(), String> {
        s.user_action(&id);
        Ok(())
    }
}

/// Create the plugin. Register it first so the controller exists before your `setup` runs.
pub fn init<R: Runtime>(config: Config<R>) -> TauriPlugin<R> {
    let ctrl = Splash::new(config);
    let splash_label = ctrl.splash_label.clone();
    let cell = Mutex::new(Some(ctrl));
    PluginBuilder::new("pikara-splash")
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::shown,
            commands::reveal_main,
            commands::close,
            commands::main_ready,
            commands::wait_ready,
            commands::action
        ])
        .setup(move |app, _api| {
            let ctrl = cell.lock().unwrap().take().expect("pikara-splash set up twice");
            {
                let info = app.package_info();
                let mut i = ctrl.lock();
                i.snap.app_name = info.name.clone();
                i.snap.version = info.version.to_string();
            }
            let _ = ctrl.app.set(app.clone());
            app.manage(ctrl);

            // Show the splash even if its page is slow to report first paint.
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let d = h.splash().show_fallback;
                tokio::time::sleep(d).await;
                let s = h.splash();
                if !s.is_complete() && !s.revealed.load(Ordering::SeqCst) {
                    show_window(&h, &s.splash_label);
                }
            });

            // Slow-step watch: flags a step that runs longer than `slow_after`.
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let s = h.splash();
                    let flag = {
                        let mut i = s.lock();
                        if i.snap.complete {
                            break;
                        }
                        let late = i.step_started.is_some_and(|t| t.elapsed() >= s.slow_after);
                        if late && !i.snap.slow && i.snap.failure.is_none() {
                            i.snap.seq += 1;
                            i.snap.slow = true;
                            true
                        } else {
                            false
                        }
                    };
                    if flag {
                        s.publish();
                    }
                }
            });
            Ok(())
        })
        .on_window_ready(move |w| {
            if w.label() != splash_label {
                return;
            }
            let app = w.app_handle().clone();
            // Closing the splash (Alt+F4, taskbar) before the app is up means "quit", never a hidden zombie app.
            w.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { .. } = e {
                    if !app.splash().revealed.load(Ordering::SeqCst) {
                        app.exit(0);
                    }
                }
            });
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_parse() {
        assert_eq!(parse_delays("db:3000, env:20"), vec![("db".into(), 3000), ("env".into(), 20)]);
        assert!(parse_delays("garbage").is_empty());
    }
}
