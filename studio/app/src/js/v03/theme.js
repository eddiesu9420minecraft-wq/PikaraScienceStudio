// Theme preference: light | dark | system (follows Windows). Applied as <html data-theme="light|dark">.
const KEY = 'ui.theme';
const subs = new Set();
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePref() { return localStorage.getItem(KEY) || 'system'; }
export function effectiveTheme(pref = getThemePref()) {
  return pref === 'dark' || (pref === 'system' && mq && mq.matches) ? 'dark' : 'light';
}
function apply() {
  document.documentElement.dataset.theme = effectiveTheme();
  subs.forEach((f) => f(getThemePref(), effectiveTheme()));
}
export function setTheme(pref) {
  localStorage.setItem(KEY, ['light', 'dark', 'system'].includes(pref) ? pref : 'system');
  apply();
}
/** Force a theme for the screenshot tour without changing the saved preference. */
export function forceTheme(theme) { document.documentElement.dataset.theme = theme; }
export function onThemeChange(f) { subs.add(f); return () => subs.delete(f); }
if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (getThemePref() === 'system') apply(); });
