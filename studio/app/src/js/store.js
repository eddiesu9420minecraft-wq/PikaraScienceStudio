// Global app state: current project, cached project list, shared event bus.
import { call, listen } from './api.js';

const bus = new EventTarget();
export const store = {
  projects: null,        // Project[] | null (null = not loaded / not available)
  projectId: localStorage.getItem('projectId') || null,
  queue: null,           // last QueueStatus
  assetAllowed: {},      // projectId -> bool
};

export function on(name, fn) { const f = (e) => fn(e.detail); bus.addEventListener(name, f); return () => bus.removeEventListener(name, f); }
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }

export function currentProject() {
  return (store.projects || []).find((p) => p.id === store.projectId) || null;
}
export function setProject(id) {
  store.projectId = id;
  if (id) localStorage.setItem('projectId', id); else localStorage.removeItem('projectId');
  emit('project', currentProject());
}

export async function refreshProjects() {
  const list = await call('project_list');
  store.projects = list || [];
  if (!store.projects.find((p) => p.id === store.projectId)) {
    store.projectId = store.projects[0] ? store.projects[0].id : null;
    if (store.projectId) localStorage.setItem('projectId', store.projectId);
  }
  emit('projects', store.projects);
  emit('project', currentProject());
  return store.projects;
}

// asset protocol scope must include the project root before convertFileSrc works
export async function ensureAssets(projectId) {
  if (!projectId) return false;
  if (store.assetAllowed[projectId]) return true;
  const r = await call('asset_url_allowed', { projectId });
  store.assetAllowed[projectId] = !!(r && r.allowed);
  return store.assetAllowed[projectId];
}

// forward backend events onto the bus once
let wired = false;
export function wireEvents() {
  if (wired) return; wired = true;
  listen('job://update', (j) => emit('job', j));
  listen('job://log', (ev) => emit('joblog', ev));
  listen('queue://status', (q) => { store.queue = q; emit('queue', q); });
  listen('monitor://sample', (s) => pushSample(s));
  listen('production://update', (p) => emit('production', p));
  listen('production://event', (e) => emit('pevent', e));
}

// Monitor ring buffer (last 5 min), filled from boot so the chart has history when opened.
export const monitorHistory = [];
const KEEP_MS = 5 * 60 * 1000;
export function pushSample(s) {
  if (!s || typeof s.ts !== 'number') return;
  const last = monitorHistory[monitorHistory.length - 1];
  if (last && last.ts >= s.ts) return;
  monitorHistory.push(s);
  while (monitorHistory.length && monitorHistory[0].ts < s.ts - KEEP_MS) monitorHistory.shift();
  emit('monitor', s);
}
