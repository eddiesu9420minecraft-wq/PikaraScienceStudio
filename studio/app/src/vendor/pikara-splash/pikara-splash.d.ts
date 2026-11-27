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
export type StepState = "pending" | "running" | "done" | "warn" | "failed" | "skipped";
export interface StepView {
    id: string;
    label: string;
    state: StepState;
    detail: string | null;
    ms: number | null;
}
export interface SplashAction {
    id: string;
    label: string;
    primary: boolean;
}
export interface SplashFailure {
    step: string | null;
    title: string;
    detail: string;
    actions: SplashAction[];
}
export interface SplashTimings {
    startedUnixMs: number;
    shownMs: number | null;
    backendDoneMs: number | null;
    frontendReadyMs: number | null;
    completeMs: number | null;
    revealedMs: number | null;
}
export interface SplashSnapshot {
    seq: number;
    appName: string;
    version: string;
    steps: StepView[];
    current: string | null;
    message: string;
    stepElapsedMs: number | null;
    slow: boolean;
    slowActions: SplashAction[];
    failure: SplashFailure | null;
    warnings: string[];
    backendDone: boolean;
    frontendReady: boolean;
    complete: boolean;
    timings: SplashTimings;
    testHooks: string | null;
}
/** How the frontend talks to Tauri. React/bundler apps pass `@tauri-apps/api`; others use the global. */
export interface Transport {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}
export type Theme = "light" | "dark" | "system";
/** Transport over `window.__TAURI__` (apps with `withGlobalTauri: true`). */
export declare function globalTransport(): Transport;
export declare const EVENTS: {
    readonly status: "pikara-splash://status";
    readonly complete: "pikara-splash://complete";
    readonly reveal: "pikara-splash://reveal";
};
export declare function createBridge(t?: Transport): {
    status: () => Promise<SplashSnapshot>;
    /** Splash page painted: the backend may now show the (still hidden) splash window. */
    shown: () => Promise<void>;
    revealMain: () => Promise<void>;
    close: () => Promise<void>;
    /** Main window rendered with its initial data. */
    mainReady: () => Promise<void>;
    /** Resolves once backend initialization finished. */
    waitReady: () => Promise<void>;
    action: (id: string) => Promise<void>;
    onStatus: (cb: (s: SplashSnapshot) => void) => Promise<() => void>;
    onComplete: (cb: () => void) => Promise<() => void>;
    onReveal: (cb: () => void) => Promise<() => void>;
};
export type SplashBridge = ReturnType<typeof createBridge>;
/**
 * The original Pikara geometric mark: four gold corner wedges framing a central diamond.
 * Pieces carry `data-piece` so the transitions can move them independently.
 */
export declare const LOGO_PIECES: ReadonlyArray<readonly [piece: string, d: string]>;
export declare const LOGO_GRADIENT: readonly ["#FFD25A", "#E39B00"];
export declare function logoSvg(size?: number, cls?: string): string;
export interface SplashOptions {
    /** Product name, e.g. "Create Your World." */
    productName: string;
    /** Overrides the version reported by the backend (tauri.conf.json `version`). */
    version?: string;
    tagline?: string;
    byline?: string;
    theme?: Theme;
    /** Exit animation length (ms). The main window is revealed when the exit *starts*. */
    exitMs?: number;
    transport?: Transport;
    /** UI strings (default: Traditional Chinese). */
    text?: Partial<typeof TEXT>;
}
declare const TEXT: {
    starting: string;
    slow: string;
    copy: string;
    copied: string;
    warnings: string;
    failedHint: string;
};
/** Render the splash into `root` and drive the hand-off. Returns a cleanup function. */
export declare function mountSplash(root: HTMLElement, opts: SplashOptions): () => void;
export interface RevealOptions {
    durationMs?: number;
    /** Overlay colour; should equal the main window's background. Default: theme surface. */
    background?: string;
    theme?: Theme;
    transport?: Transport;
}
/**
 * Lives in the main window. Painted (logo on the app background) while the window is still
 * hidden, so the first visible frame continues the splash. On reveal the wedges stretch to the
 * window corners and fade, uncovering the app. It never blocks input (pointer-events: none) and
 * removes itself afterwards.
 */
export declare function mountReveal(root?: HTMLElement, opts?: RevealOptions): () => void;
export {};
