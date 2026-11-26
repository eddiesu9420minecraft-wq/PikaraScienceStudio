// Live monitor for one production (v0.2.1). Everything shown comes from the backend command auto_monitor:
// the running job and its log, render FPS / frames / ETA parsed from render.mjs's own output, the latest AI run's
// text and tool calls, research sources, file changes in the worktree, the script, key frames, generated voice,
// videos and the error / fix history. Nothing is simulated; empty sections say so.
import { t } from '../i18n.js';
import { call, fileSrc } from '../api.js';
import { h, mount, btn, progress, fmtDur, fmtNum, fmtBytes, toast, toastError, basename } from '../ui.js';
import { ensureAssets } from '../store.js';

const TABS = [
  ['live', '即時輸出'], ['tools', '工具呼叫'], ['render', '渲染'], ['sources', '研究來源'], ['changes', '檔案變更'],
  ['script', '腳本'], ['board', '分鏡'], ['voice', '配音試聽'], ['video', '動畫預覽'], ['history', '錯誤與修復'],
];

export class LiveMonitor {
  constructor(prod, projectId) {
    this.prod = prod;
    this.projectId = projectId;
    this.tab = sessionStorage.getItem('automon.tab') || 'live';
    this.data = null;
    this.el = h('div.automon');
    this.timer = null;
    this.busy = false;
    this.err = null;
  }

  mountInto(parent) {
    parent.appendChild(this.el);
    ensureAssets(this.projectId).catch(() => {});
    this.refresh();
    const active = () => ['running', 'queued', 'waiting_agent', 'paused', 'paused_limit'].includes(this.prod.status);
    this.timer = setInterval(() => { if (!document.body.contains(this.el)) return this.stop(); if (active() || this.tab === 'video') this.refresh(); }, 2000);
    return this;
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  update(prod) { this.prod = prod; }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try { this.data = await call('auto_monitor', { id: this.prod.id }); this.err = null; }
    catch (e) { this.err = String(e && e.message || e); }
    finally { this.busy = false; }
    this.paint();
  }

  paint() {
    const keepScroll = this.el.querySelector('.automon-body');
    const atBottom = keepScroll ? keepScroll.scrollTop + keepScroll.clientHeight >= keepScroll.scrollHeight - 30 : true;
    const prevTop = keepScroll ? keepScroll.scrollTop : 0;
    const d = this.data;
    const tabs = h('div.seg.automon-tabs', TABS.map(([id, label]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(this.tab === id) }, t(label), badge(d, id));
      b.addEventListener('click', () => { this.tab = id; sessionStorage.setItem('automon.tab', id); this.paint(); });
      return b;
    }));
    const body = h('div.automon-body');
    mount(this.el, h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', gap: '8px' } }, h('span.headline', t('即時工作監控')), this.summary()), tabs, body);
    if (this.err) { mount(body, h('div.caption.fail-text', this.err)); return; }
    if (!d) { mount(body, h('div.caption.muted', t('讀取中…'))); return; }
    mount(body, this[`p_${this.tab}`]());
    const nb = this.el.querySelector('.automon-body');
    if (['live', 'tools', 'history'].includes(this.tab) && atBottom) nb.scrollTop = nb.scrollHeight; else nb.scrollTop = prevTop;
  }

  summary() {
    const d = this.data;
    if (!d || !d.job) return h('span.caption.muted', d ? t('目前沒有執行中的工作') : '');
    const j = d.job;
    const r = d.render;
    const bits = [`${j.label}`, j.status === 'running' && j.progressText ? j.progressText : t(j.status)];
    if (r && r.phase === 'render' && r.fps) bits.push(`${fmtNum(r.fps, 1)} fps`, r.etaSec != null ? t('剩餘約 {d}', { d: fmtDur(r.etaSec) }) : '');
    return h('span.caption.muted.ellipsis', { style: { maxWidth: '60%' } }, bits.filter(Boolean).join('・'));
  }

  // ---------------------------------------------------------------- tabs
  p_live() {
    const d = this.data;
    const ai = d.ai || {};
    const lines = (ai.lines || []).filter((l) => l.kind !== 'log' || l.level === 'error');
    const job = d.job;
    return h('div.col', { style: { gap: '8px' } },
      ai.job ? h('div.caption.muted', `${t('最近一次 AI 執行')}：${ai.job.label}（${t(ai.job.status)}${ai.job.progressText ? '・' + ai.job.progressText : ''}）`) : h('div.caption.muted', t('這次製作還沒有 AI 執行紀錄')),
      lines.length ? h('div.auto-log.mono.selectable', lines.slice(-250).map((l) => h('div', { class: `auto-log-line ${l.kind === 'toolError' || l.level === 'error' ? 'error' : l.kind === 'tool' ? 'tool' : l.kind === 'text' ? 'say' : ''}` }, l.line))) : null,
      job && job.kind !== 'claude_in' && job.kind !== 'agent_cli' ? h('div.col', { style: { gap: '4px' } },
        h('div.caption.muted', `${t('目前的工作')}：${job.label}${job.steps && job.steps.length ? `（${t('步驟 {a}/{b}', { a: Math.min(job.step + 1, job.steps.length), b: job.steps.length })}：${job.steps[job.step] || ''}）` : ''}`),
        progress(job.status === 'running' ? job.progress : null),
        h('div.auto-log.mono.selectable', (d.jobLines || []).slice(-120).map((l) => h('div', { class: `auto-log-line ${l.level}` }, l.line)))) : null);
  }

  p_tools() {
    const lines = ((this.data.ai || {}).lines || []).filter((l) => ['tool', 'result', 'toolError'].includes(l.kind));
    if (!lines.length) return h('div.caption.muted', t('最近一次 AI 執行沒有工具呼叫紀錄'));
    return h('div.auto-log.mono.selectable', lines.slice(-300).map((l) => h('div', { class: `auto-log-line ${l.kind === 'toolError' ? 'error' : l.kind === 'tool' ? 'tool' : 'muted'}` }, l.line)));
  }

  p_render() {
    const r = this.data.render;
    if (!r) return h('div.caption.muted', t('目前的工作不是渲染（渲染開始後這裡會顯示實際 FPS、已完成幀數與預計剩餘時間）'));
    const frac = r.totalFrames ? r.doneFrames / r.totalFrames : null;
    const kv = (k, v) => [h('dt', t(k)), h('dd', v == null || v === '' ? '—' : v)];
    return h('div.col', { style: { gap: '10px' } },
      h('div.row', h('span.headline.grow', `${r.comp}`), h('span.caption.muted', r.phase === 'encode' ? t('影片編碼中') : r.phase === 'done' ? t('完成') : t('渲染中'))),
      progress(r.phase === 'render' ? frac : r.phase === 'done' ? 1 : null),
      h('dl.kv', ...kv('已完成幀數', `${fmtNum(r.doneFrames)} / ${fmtNum(r.totalFrames)}（${fmtNum(frac * 100, 1)}%）`),
        ...kv('沿用快取的幀', fmtNum(r.cachedFrames)),
        ...kv('最近一段 FPS', r.fps != null ? `${fmtNum(r.fps, 1)} fps` : null), ...kv('平均 FPS', r.avgFps != null ? `${fmtNum(r.avgFps, 1)} fps` : null),
        ...kv('並行數（自動調整）', r.concurrency), ...kv('預計剩餘', r.etaSec != null ? fmtDur(r.etaSec) : null),
        ...kv('區段', `${r.chunksDone} / ${r.chunks}`), ...kv('GPU 平均／VRAM 峰值／溫度', `${fmtNum(r.gpuAvg, 0, '%')}／${fmtNum(r.vramPeakMiB, 0)} MiB／${fmtNum(r.maxTempC, 0, '°C')}`)),
      r.sceneCache ? h('div.caption.muted', r.sceneCache) : null,
      h('div.caption.muted', t('FPS 與幀數來自渲染程式每完成一段（約 1800 幀）的實測紀錄；剩餘時間＝剩餘幀數 ÷ 最近一段的 FPS。')));
  }

  p_sources() {
    const s = this.data.sources || [];
    if (!s.length) return h('div.caption.muted', t('還沒有資料來源（研究完成後會出現在 {f}）', { f: `${this.prod.episode.toUpperCase()}_SOURCES.md` }));
    return h('ol.automon-list', s.map((x) => h('li', h('div', x.title || x.url), h('div.caption.mono.muted.selectable', x.url))));
  }

  p_changes() {
    const c = this.data.changes || [];
    if (!c.length) return h('div.caption.muted', t('工作樹目前沒有變更'));
    const pending = c.filter((x) => !x.committed);
    const done = c.filter((x) => x.committed);
    const row = (x) => h('div.row.mono.caption', { style: { gap: '10px' } }, h('span', { style: { width: '42px' } }, x.committed ? `+${x.added}/-${x.removed}` : x.status), h('span.selectable', x.path));
    return h('div.col', { style: { gap: '8px' } },
      pending.length ? [h('div.caption.muted', t('尚未提交（目前步驟正在修改）')), ...pending.map(row)] : null,
      done.length ? [h('div.caption.muted', t('這次製作已提交的變更（各階段 checkpoint）')), ...done.map(row)] : null);
  }

  p_script() {
    const s = this.data.script;
    if (!s) return h('div.caption.muted', t('還沒有腳本'));
    return h('div.col', { style: { gap: '10px' } }, h('div.headline', s.title || ''),
      (s.scenes || []).map((sc) => h('div.col', { style: { gap: '2px' } }, h('div', { style: { fontWeight: 600 } }, `${sc.id}　${sc.title || ''}`),
        (sc.lines || []).map((l) => h('div.caption', h('span.muted.mono', `${l.id.split('-').pop()} `), l.subtitle, l.speak && l.speak !== l.subtitle ? h('span.muted', `　（念：${l.speak}）`) : null)))));
  }

  p_board() {
    const s = this.data.stills || [];
    const act = btn(t('產生低解析度預覽'), { small: true, icon: 'play', onClick: () => this.preview(act) });
    return h('div.col', { style: { gap: '8px' } },
      h('div.row', h('span.caption.muted.grow', t('關鍵幀來自畫面審查（1920×1080）或低解析度預覽（640×360）。')), act),
      s.length ? h('div.automon-grid', s.map((x) => h('figure', h('img', { src: fileSrc(x.path), loading: 'lazy', alt: x.name }), h('figcaption.caption.muted', `${x.kind === 'preview' ? t('預覽') : t('審查')} ${x.name.replace(/\.(png|jpe?g)$/, '').split('-').pop()}`)))) : h('div.caption.muted', t('還沒有關鍵幀')));
  }

  p_voice() {
    const v = this.data.voice || [];
    if (!v.length) return h('div.caption.muted', t('還沒有配音'));
    return h('div.col', { style: { gap: '6px' } }, v.map((x) => h('div.automon-voice',
      h('div.row', { style: { gap: '8px' } }, h('span.mono.caption', x.id), x.lang === 'zh-CN' ? h('span.tag', 'zh-CN') : null, h('span.caption.muted', `${fmtNum(x.duration, 1)} s`), x.cer != null ? h('span', { class: `caption ${x.cer > 0.15 ? 'warn-text' : 'muted'}` }, `CER ${fmtNum(x.cer, 3)}`) : null),
      h('div.caption', x.speak || ''), x.asr ? h('div.caption.muted', `${t('Whisper 聽到')}：${x.asr}`) : null,
      h('audio', { controls: true, preload: 'none', src: fileSrc(x.path) }))));
  }

  p_video() {
    const v = this.data.videos || [];
    const s = (this.data.stills || []).filter((x) => x.kind === 'preview');
    const act = btn(t('產生低解析度預覽'), { small: true, icon: 'play', onClick: () => this.preview(act) });
    return h('div.col', { style: { gap: '10px' } },
      h('div.row', h('span.caption.muted.grow', t('完成渲染的影片可直接播放；渲染前可先產生 12 張 640×360 的預覽幀檢查動畫。')), act),
      v.length ? v.map((x) => h('div.col', { style: { gap: '4px' } }, h('div.caption', `${x.name}（${fmtBytes(x.bytes)}）`), h('video', { controls: true, preload: 'metadata', src: fileSrc(x.path), style: { width: '100%', maxWidth: '720px', borderRadius: '8px' } }))) : h('div.caption.muted', t('還沒有渲染完成的影片')),
      s.length ? h('div.automon-grid', s.map((x) => h('img', { src: fileSrc(x.path), loading: 'lazy', alt: x.name }))) : null);
  }

  p_history() {
    const e = this.data.history || [];
    if (!e.length) return h('div.caption.muted', t('沒有錯誤或修復紀錄'));
    return h('div.auto-log.mono.selectable', e.map((x) => {
      const d = new Date(x.ts);
      const p = (n) => String(n).padStart(2, '0');
      return h('div', { class: `auto-log-line ${x.level}` }, h('span.muted', `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} [${x.stage}] `), x.line);
    }));
  }

  async preview(button) {
    button.disabled = true;
    try { const j = await call('auto_preview', { id: this.prod.id }); toast(t('已排入佇列：{l}', { l: j.label }), 'ok'); }
    catch (e) { toastError(e, t('預覽')); }
    finally { button.disabled = false; }
  }
}

function badge(d, id) {
  if (!d) return null;
  const n = { sources: (d.sources || []).length, changes: (d.changes || []).length, board: (d.stills || []).length, voice: (d.voice || []).length, video: (d.videos || []).length, history: (d.history || []).filter((x) => x.level === 'error').length }[id];
  return n ? h('span.automon-badge', String(n)) : null;
}

export { basename };
