// Thin wrapper around the Tauri 2 global API (withGlobalTauri). No bundler.
// Every screen goes through call()/listen(); a missing runtime or an unregistered
// command surfaces as NotReady so the UI can show "backend not ready" instead of data.

const T = window.__TAURI__;
export const hasTauri = !!(T && T.core && typeof T.core.invoke === 'function');

export class NotReady extends Error {
  constructor(cmd, detail) {
    super(`backend not ready: ${cmd}`);
    this.name = 'NotReady';
    this.cmd = cmd;
    this.detail = detail || '';
  }
}

export class ApiError extends Error {
  constructor(cmd, message, raw) {
    super(message);
    this.name = 'ApiError';
    this.cmd = cmd;
    this.raw = raw;
    // structured errors from the core: { code, message, ... }
    if (raw && typeof raw === 'object') {
      this.code = raw.code || raw.kind || null;
      this.data = raw;
    }
  }
}

export function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object') return e.message || e.error || JSON.stringify(e);
  return String(e);
}

const NOT_FOUND = /(command\s+\S+\s+not\s+found|not found|unknown command|isn't registered|is not registered|no such command)/i;

const log = [];
export const callLog = log;

export async function call(cmd, args = {}) {
  if (!hasTauri) throw new NotReady(cmd, 'window.__TAURI__ unavailable (not running inside the Tauri app)');
  const t0 = performance.now();
  try {
    const r = await T.core.invoke(cmd, args);
    log.push({ cmd, ok: true, ms: Math.round(performance.now() - t0) });
    if (log.length > 200) log.shift();
    return r;
  } catch (e) {
    const msg = errText(e);
    log.push({ cmd, ok: false, msg, ms: Math.round(performance.now() - t0) });
    if (log.length > 200) log.shift();
    if (NOT_FOUND.test(msg) && new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(msg)) throw new NotReady(cmd, msg);
    if (/command .* not found/i.test(msg)) throw new NotReady(cmd, msg);
    throw new ApiError(cmd, msg, e);
  }
}

// Subscribe to a backend event. Returns an unlisten function (sync handle; real unlisten resolves later).
export function listen(event, cb) {
  if (!hasTauri || !T.event || !T.event.listen) return () => {};
  let un = null, dead = false;
  T.event.listen(event, (ev) => { if (!dead) cb(ev.payload, ev); })
    .then((f) => { un = f; if (dead) f(); })
    .catch(() => {});
  return () => { dead = true; if (un) un(); };
}

export function fileSrc(path) {
  if (!path) return '';
  if (hasTauri && T.core.convertFileSrc) return T.core.convertFileSrc(path);
  return '';
}

// Tauri Channel for streamed command output (if the core uses Channel<T> params).
export function channel(onMessage) {
  if (!hasTauri || !T.core.Channel) return null;
  const ch = new T.core.Channel();
  ch.onmessage = onMessage;
  return ch;
}

export const tauri = T;
