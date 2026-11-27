/**
 * pikara-splash — framework-free frontend of the Pikara startup screen.
 *
 * Single source of truth: CreateYourWorld/crates/pikara-splash/web/src. Apps without a bundler
 * use the compiled `web/dist/pikara-splash.js` (vendored by `crates/pikara-splash/sync.mjs`).
 * React apps use `./react.tsx`, a thin wrapper around this file.
 *
 * Everything shown comes from the backend (`plugin:pikara-splash|status`): no fake progress,
 * no timers that pretend work is happening.
 */
// ------------------------------------------------------------------ transport & bridge
/** Transport over `window.__TAURI__` (apps with `withGlobalTauri: true`). */
export function globalTransport() {
    const T = window.__TAURI__;
    if (!T?.core?.invoke || !T?.event?.listen)
        throw new Error("pikara-splash: window.__TAURI__ not available (enable withGlobalTauri or pass a transport)");
    return {
        invoke: (cmd, args) => T.core.invoke(cmd, args),
        listen: (event, cb) => T.event.listen(event, (e) => cb(e.payload)),
    };
}
const P = "plugin:pikara-splash|";
export const EVENTS = {
    status: "pikara-splash://status",
    complete: "pikara-splash://complete",
    reveal: "pikara-splash://reveal",
};
export function createBridge(t = globalTransport()) {
    return {
        status: () => t.invoke(P + "status"),
        /** Splash page painted: the backend may now show the (still hidden) splash window. */
        shown: () => t.invoke(P + "shown"),
        revealMain: () => t.invoke(P + "reveal_main"),
        close: () => t.invoke(P + "close"),
        /** Main window rendered with its initial data. */
        mainReady: () => t.invoke(P + "main_ready"),
        /** Resolves once backend initialization finished. */
        waitReady: () => t.invoke(P + "wait_ready"),
        action: (id) => t.invoke(P + "action", { id }),
        onStatus: (cb) => t.listen(EVENTS.status, cb),
        onComplete: (cb) => t.listen(EVENTS.complete, () => cb()),
        onReveal: (cb) => t.listen(EVENTS.reveal, () => cb()),
    };
}
// ------------------------------------------------------------------ logo
/**
 * The original Pikara geometric mark: four gold corner wedges framing a central diamond.
 * Pieces carry `data-piece` so the transitions can move them independently.
 */
export const LOGO_PIECES = [
    ["tl", "M14 14H44L14 44Z"],
    ["tr", "M86 14V44L56 14Z"],
    ["br", "M86 86H56L86 56Z"],
    ["bl", "M14 86V56L44 86Z"],
    ["core", "M50 30L70 50L50 70L30 50Z"],
];
export const LOGO_GRADIENT = ["#FFD25A", "#E39B00"];
export function logoSvg(size = 64, cls = "") {
    const id = `pkg${Math.random().toString(36).slice(2, 8)}`;
    const paths = LOGO_PIECES.map(([p, d]) => `<path data-piece="${p}" d="${d}"/>`).join("");
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="pikara">` +
        `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${LOGO_GRADIENT[0]}"/><stop offset="1" stop-color="${LOGO_GRADIENT[1]}"/></linearGradient></defs>` +
        `<g fill="url(#${id})">${paths}</g></svg>`;
}
// ------------------------------------------------------------------ helpers
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls)
        e.className = cls;
    if (text != null)
        e.textContent = text;
    return e;
}
function applyTheme(node, theme) {
    if (theme && theme !== "system")
        node.dataset.pkTheme = theme;
    else
        delete node.dataset.pkTheme;
}
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const TEXT = {
    starting: "正在啟動…",
    slow: "這一步已經花了 {s} 秒，比平常久。",
    copy: "複製錯誤內容",
    copied: "已複製",
    warnings: "{n} 個提醒",
    failedHint: "啟動沒有完成。你可以選擇下一步：",
};
/** Render the splash into `root` and drive the hand-off. Returns a cleanup function. */
export function mountSplash(root, opts) {
    const tx = { ...TEXT, ...(opts.text || {}) };
    const bridge = createBridge(opts.transport);
    const exitMs = reducedMotion() ? 160 : opts.exitMs ?? 720;
    const view = el("div", "pk-theme pks-root");
    applyTheme(view, opts.theme);
    view.style.setProperty("--pks-exit", `${exitMs}ms`);
    view.setAttribute("data-tauri-drag-region", "");
    const card = el("div", "pks-card");
    card.setAttribute("data-tauri-drag-region", "");
    // head: logo + name + version
    const head = el("div", "pks-head");
    head.setAttribute("data-tauri-drag-region", "");
    const logo = el("div", "pks-logo-wrap");
    logo.innerHTML = logoSvg(60, "pks-logo");
    const text = el("div", "pks-text");
    text.setAttribute("data-tauri-drag-region", "");
    const name = el("div", "pks-name", opts.productName);
    const meta = el("div", "pks-meta");
    const ver = el("span", "pks-version");
    ver.hidden = true;
    meta.append(ver);
    if (opts.tagline)
        meta.append(el("span", "pks-tagline", opts.tagline));
    text.append(name, meta);
    head.append(logo, text);
    // failure panel
    const fail = el("div", "pks-fail");
    fail.setAttribute("role", "alert");
    fail.hidden = true;
    const failTitle = el("div", "pks-fail-title");
    const failHint = el("div", "pks-fail-hint", tx.failedHint);
    const failDetail = el("pre", "pks-fail-detail");
    const failActions = el("div", "pks-actions");
    fail.append(failTitle, failHint, failDetail, failActions);
    // footer: status, segmented real progress, slow notice
    const foot = el("div", "pks-foot");
    const status = el("div", "pks-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const msg = el("span", "pks-msg", tx.starting);
    const count = el("span", "pks-count");
    status.append(msg, count);
    const segs = el("div", "pks-segs");
    const note = el("div", "pks-note");
    const noteText = el("span", "pks-note-text");
    const noteActions = el("div", "pks-actions pks-actions-small");
    note.append(noteText, noteActions);
    note.hidden = true;
    const warn = el("div", "pks-warn");
    warn.hidden = true;
    foot.append(status, segs, note, warn);
    if (opts.byline)
        foot.append(el("div", "pks-byline", opts.byline));
    card.append(head, fail, foot);
    view.append(card);
    root.append(view);
    let snap = null;
    let receivedAt = 0;
    let exiting = false;
    let alive = true;
    let failKey = "";
    let slowKey = "";
    let tick = 0;
    const pressAction = (b, id) => {
        b.disabled = true;
        bridge.action(id).catch(() => { b.disabled = false; });
    };
    const actionButtons = (box, actions, small = false) => {
        box.replaceChildren(...actions.map((a) => {
            const b = el("button", `pks-btn${a.primary ? " pks-btn-primary" : ""}${small ? " pks-btn-small" : ""}`, a.label);
            b.type = "button";
            b.dataset.action = a.id;
            b.onclick = () => pressAction(b, a.id);
            return b;
        }));
    };
    const renderSlow = () => {
        if (!snap || !snap.slow || snap.failure || snap.complete) {
            note.hidden = true;
            return;
        }
        const s = Math.round(((snap.stepElapsedMs ?? 0) + (Date.now() - receivedAt)) / 1000);
        noteText.textContent = tx.slow.replace("{s}", String(s));
        const key = snap.slowActions.map((a) => a.id).join(",") + "|" + snap.current;
        if (key !== slowKey) {
            slowKey = key;
            actionButtons(noteActions, snap.slowActions, true);
        }
        note.hidden = false;
    };
    const render = () => {
        if (!snap)
            return;
        const s = snap;
        const version = opts.version ?? s.version;
        if (version) {
            ver.textContent = version.startsWith("v") ? version : `v${version}`;
            ver.hidden = false;
        }
        msg.textContent = s.message || tx.starting;
        const finished = s.steps.filter((x) => x.state !== "pending" && x.state !== "running").length;
        count.textContent = s.steps.length ? `${Math.min(finished, s.steps.length)}/${s.steps.length}` : "";
        // one segment per real step; colour = real state
        if (segs.children.length !== s.steps.length) {
            segs.replaceChildren(...s.steps.map(() => el("span", "pks-seg")));
        }
        s.steps.forEach((st, i) => {
            const seg = segs.children[i];
            seg.dataset.state = st.state;
            seg.title = st.label + (st.detail ? `：${st.detail}` : "") + (st.ms != null ? `（${st.ms} ms）` : "");
        });
        view.classList.toggle("pks-failed", !!s.failure);
        view.classList.toggle("pks-is-slow", s.slow && !s.failure);
        if (s.failure) {
            const f = s.failure;
            const key = f.title + "\n" + f.detail + "\n" + f.actions.map((a) => a.id).join(",");
            if (key !== failKey) {
                failKey = key;
                failTitle.textContent = f.title;
                failDetail.textContent = f.detail;
                failDetail.hidden = !f.detail;
                actionButtons(failActions, f.actions);
                const copy = el("button", "pks-btn pks-btn-ghost", tx.copy);
                copy.type = "button";
                copy.onclick = () => {
                    const t = `${s.appName} ${s.version}\n${f.title}\n${f.detail}`;
                    navigator.clipboard?.writeText(t).then(() => { copy.textContent = tx.copied; }).catch(() => { });
                };
                failActions.prepend(copy);
                failActions.querySelector(".pks-btn-primary")?.focus();
            }
            fail.hidden = false;
        }
        else {
            failKey = "";
            fail.hidden = true;
        }
        if (s.warnings.length && !s.failure) {
            warn.textContent = `${tx.warnings.replace("{n}", String(s.warnings.length))}：${s.warnings[s.warnings.length - 1]}`;
            warn.title = s.warnings.join("\n");
            warn.hidden = false;
        }
        else
            warn.hidden = true;
        renderSlow();
        if (s.complete)
            exit();
    };
    const exit = () => {
        if (exiting)
            return;
        exiting = true;
        view.classList.add("pks-exiting");
        // The main window appears underneath *now*; the animation only decorates the hand-off.
        bridge.revealMain().catch(() => { });
        window.setTimeout(() => bridge.close().catch(() => { }), exitMs + 40);
    };
    const accept = (s) => {
        if (!alive || (snap && s.seq < snap.seq))
            return; // stale reply / event
        if (snap?.complete)
            s.complete = true;
        snap = s;
        receivedAt = Date.now();
        render();
    };
    const unsubs = [bridge.onStatus(accept), bridge.onComplete(() => { if (snap)
            snap.complete = true; exit(); })];
    bridge.status().then(accept).catch(() => { });
    tick = window.setInterval(renderSlow, 1000);
    // First paint done → the backend may show the window (avoids any blank frame).
    window.setTimeout(() => bridge.shown().catch(() => { }), 0);
    return () => {
        alive = false;
        window.clearInterval(tick);
        unsubs.forEach((u) => u.then((f) => f()).catch(() => { }));
        view.remove();
    };
}
/**
 * Lives in the main window. Painted (logo on the app background) while the window is still
 * hidden, so the first visible frame continues the splash. On reveal the wedges stretch to the
 * window corners and fade, uncovering the app. It never blocks input (pointer-events: none) and
 * removes itself afterwards.
 */
export function mountReveal(root = document.body, opts = {}) {
    const bridge = createBridge(opts.transport);
    const dur = reducedMotion() ? 180 : opts.durationMs ?? 900;
    const ov = el("div", "pk-theme pkr-overlay");
    applyTheme(ov, opts.theme);
    ov.setAttribute("aria-hidden", "true");
    ov.style.setProperty("--pkr-dur", `${dur}ms`);
    if (opts.background)
        ov.style.setProperty("--pk-reveal-bg", opts.background);
    ov.innerHTML = logoSvg(120, "pkr-logo");
    root.append(ov);
    let played = false;
    let timer = 0;
    const play = () => {
        if (played)
            return;
        played = true;
        // next frame, so the "hold" state is committed before transitions start
        requestAnimationFrame(() => ov.classList.add("pkr-play"));
        timer = window.setTimeout(() => ov.remove(), dur + 80);
    };
    const un = bridge.onReveal(play);
    // Mounted after the hand-off already happened (e.g. page reload): play right away.
    bridge.status().then((s) => s.complete && window.setTimeout(play, 300)).catch(() => play());
    // Became visible without the event (fallback path): play anyway.
    const onVis = () => document.visibilityState === "visible" && window.setTimeout(play, 50);
    document.addEventListener("visibilitychange", onVis);
    return () => {
        un.then((f) => f()).catch(() => { });
        document.removeEventListener("visibilitychange", onVis);
        window.clearTimeout(timer);
        ov.remove();
    };
}
