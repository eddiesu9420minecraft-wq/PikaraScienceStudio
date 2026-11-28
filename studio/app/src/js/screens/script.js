// 2. Script editor — narration.json (zh-TW) / src_cn narration.json (zh-CN).
// Edits the raw doc in place (key order preserved by the backend), validates via
// narration_validate, saves via narration_save (backend commits to git).
import { t } from '../i18n.js';
import { call, hasTauri, fileSrc } from '../api.js';
import { h, mount, btn, seg, empty, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, tag, field } from '../ui.js';
import { icon } from '../icons.js';
import { store, currentProject, ensureAssets, on } from '../store.js';
import { currentEpisode, setEpisode, newEpisodeSheet } from '../episodes.js';

const drafts = new Map(); // `${projectId}|${locale}` -> { file, doc, seqKey, dirtyIds:Set, selected }
let audio = null;

export default {
  id: 'script', title: '腳本', icon: 'script',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['narration_read', 'narration_validate', 'narration_save']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    const locale = sessionStorage.getItem('script.locale') || 'zh-TW';
    const key = `${p.id}|${locale}`;
    let st = drafts.get(key);

    mount(ctx.content, h('div.page', loading(6)));
    if (!st) {
      let file;
      try { file = await call('narration_read', { projectId: p.id, locale }); }
      catch (e) {
        if (!ctx.alive()) return;
        ctx.toolbar(t('腳本'), '', [localeSeg(ctx, locale)]);
        mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender())));
        return;
      }
      st = { file, doc: file.doc, seqKey: pickSeq(file, p.id), dirtyIds: new Set(), selected: null, validation: null, filter: '' };
      drafts.set(key, st);
    }
    if (!ctx.alive()) return;
    new Editor(ctx, p, locale, key, st).mount();
  },
};

function pickSeq(file, projectId) {
  const keys = Object.keys((file.doc && file.doc.sequences) || {});
  const saved = currentEpisode(projectId);
  if (saved && keys.includes(saved)) return saved;
  return keys.includes('ep01') ? 'ep01' : keys[keys.length - 1] || null;
}

function localeSeg(ctx, locale) {
  return seg([{ value: 'zh-TW', label: '繁 zh-TW' }, { value: 'zh-CN', label: '简 zh-CN' }], locale, (v) => {
    sessionStorage.setItem('script.locale', v); ctx.rerender();
  }, { aria: t('腳本語系') });
}

class Editor {
  constructor(ctx, p, locale, key, st) { Object.assign(this, { ctx, p, locale, key, st }); this.rowEls = new Map(); }

  get seq() { return this.st.doc.sequences[this.st.seqKey]; }
  get seqMeta() { return (this.st.file.sequences || []).find((s) => s.key === this.st.seqKey) || {}; }

  mount() {
    const { ctx, st } = this;
    this.saveBtn = btn(t('儲存'), { kind: 'primary', icon: 'save', kbd: 'Ctrl+S', onClick: () => this.save() });
    this.validateBtn = btn(t('驗證'), { icon: 'check', onClick: () => this.validate(true) });
    const seqSel = h('select.select', { 'aria-label': t('序列'), style: { width: '200px' } },
      Object.entries(st.doc.sequences || {}).map(([k, s]) => h('option', { value: k, selected: k === st.seqKey ? true : null }, `${k} — ${s.title || ''}`)));
    seqSel.addEventListener('change', () => { st.seqKey = seqSel.value; setEpisode(this.p.id, st.seqKey); st.selected = null; this.renderTable(); this.renderInspector(); this.updateHeader(); this.renderBanners(); });
    const reload = btn('', { icon: 'refresh', aria: t('從磁碟重新載入'), onClick: () => this.reload() });
    const newEp = btn(t('新增集數'), { icon: 'plus', onClick: () => this.newEpisode() });
    ctx.toolbar(t('腳本'), '', [localeSeg(ctx, this.locale), seqSel, newEp, reload, this.validateBtn, this.saveBtn]);

    this.search = h('input.input', { type: 'search', placeholder: t('搜尋句子、id 或錨點…'), 'aria-label': t('搜尋'), value: st.filter, style: { width: '260px' } });
    this.search.addEventListener('input', () => { st.filter = this.search.value; this.applyFilter(); });
    this.banners = h('div.col');
    this.summary = h('div.caption.muted.num');
    this.tableBox = h('div.panel.table-wrap');
    this.inspector = h('aside.inspector', { 'aria-label': t('檢閱器') });
    const pane = h('div.pane', h('div.page', this.banners,
      h('div.row', h('div.search', icon('search'), this.search), h('div.grow'), this.summary), this.tableBox));
    mount(ctx.content, h('div.split', pane, this.inspector));

    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); } };
    document.addEventListener('keydown', onKey);
    ctx.cleanup(() => document.removeEventListener('keydown', onKey));
    ctx.cleanup(() => { if (audio) audio.pause(); });
    ctx.cleanup(on('queue', () => this.renderBanners()));
    // re-fit auto-height cells when the table width changes (window resize, inspector)
    let lastW = 0, raf = 0;
    const ro = new ResizeObserver(() => {
      const w = this.tableBox.clientWidth; if (w === lastW) return; lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.rowEls.forEach((r) => { if (!r.tr.hidden) { fit(r.sub); fit(r.speak); } }));
    });
    ro.observe(this.tableBox);
    ctx.cleanup(() => ro.disconnect());

    this.renderBanners();
    this.renderTable();
    this.renderInspector();
    this.updateHeader();
    if (!st.validation) this.validate(false);
  }

  async newEpisode() {
    if (this.st.dirtyIds.size) { toast(t('請先儲存或重新載入目前的修改，再新增集數。'), 'warn'); return; }
    const existing = Object.keys(this.st.doc.sequences || {}).filter((k) => /^ep\d{2,3}$/.test(k)).map((id) => ({ id }));
    const r = await newEpisodeSheet(this.p.id, existing);
    if (!r) return;
    // the backend wrote and committed the file(s): drop cached drafts and reload with the new episode selected
    for (const k of [...drafts.keys()]) if (k.startsWith(`${this.p.id}|`)) drafts.delete(k);
    this.ctx.rerender();
  }

  updateHeader() {
    const dirty = this.st.dirtyIds.size > 0;
    document.getElementById('tb-title').textContent = t('單集編輯') + (dirty ? ' •' : ''); // 未儲存標記；標題與其他分頁一致
    const nLines = (this.seq.scenes || []).reduce((a, s) => a + (s.lines || []).length, 0);
    this.ctx.subtitle(`${this.st.file.path}`);
    const v = this.st.validation;
    mount(this.summary,
      t('{s} 幕・{n} 句', { s: (this.seq.scenes || []).length, n: nLines }),
      dirty ? h('span.warn-text', `・${t('{n} 句未儲存', { n: this.st.dirtyIds.size })}`) : null,
      v ? h('span', { class: v.errors.length ? 'fail-text' : 'ok-text' }, `・${v.errors.length ? t('{n} 個錯誤', { n: v.errors.length }) : t('驗證通過')}`) : null,
      v && v.warnings.length ? h('span.warn-text', `・${t('{n} 個警告', { n: v.warnings.length })}`) : null);
    this.saveBtn.disabled = !dirty;
  }

  renderBanners() {
    const b = [];
    const q = store.queue;
    const src = this.locale === 'zh-CN' ? 'src_cn' : 'src';
    const renders = q && (q.running || []).filter((j) => ['render', 'youtube_15x', 'bilibili', 'voiceover_tw', 'voiceover_cn', 'timeline'].includes(j.kind)
      && (j.kind === 'bilibili' ? src === 'src_cn' : (j.params && (j.params.src || 'src')) === src || j.kind.startsWith('voiceover')));
    if (renders && renders.length) b.push(h('div.banner.warn', icon('alert'), h('div.grow', t('製作中：{x}。修改會在下次執行時生效。', { x: renders.map((j) => j.label || j.kind).join('、') }))));
    if (this.locale === 'zh-CN') b.push(h('div.banner.info', icon('info'), h('div.grow', t('zh-CN 與 zh-TW 各自管理：make_cn 只會為還沒有簡體稿的集數轉換一份初稿；已存在的簡體集數不會被覆寫（除非在「製作」勾選重新轉換）。'))));
    if (this.seq && !(this.seq.scenes || []).some((sc) => (sc.lines || []).some((l) => l.anchors && Object.keys(l.anchors).length)))
      b.push(h('div.banner.info', icon('info'), h('div.grow', t('這一集還沒有錨點：沒有手工動畫的集數使用通用樣板，每個錨點會在念到該詞時變成一張關鍵詞卡片。'))));
    const v = this.st.validation;
    const general = v ? v.errors.filter((e) => e.seqKey === this.st.seqKey && !e.lineId) : [];
    if (general.length) b.push(h('div.banner.fail', icon('alert'), h('div.grow', general.map((e) => h('div', `${e.sceneId || ''} ${e.field || ''}：${e.message}`)))));
    const other = v ? v.errors.filter((e) => e.seqKey !== this.st.seqKey) : [];
    if (other.length) b.push(h('div.banner.fail', icon('alert'), h('div.grow', t('其他序列有 {n} 個錯誤（{k}），儲存前需要修正。', { n: other.length, k: [...new Set(other.map((e) => e.seqKey))].join('、') }))));
    mount(this.banners, b);
  }

  issuesFor(lineId) {
    const v = this.st.validation; if (!v) return { errors: [], warnings: [] };
    const m = (e) => e.seqKey === this.st.seqKey && e.lineId === lineId;
    return { errors: v.errors.filter(m), warnings: v.warnings.filter(m) };
  }

  renderTable() {
    const { st } = this;
    this.rowEls.clear();
    const tbody = h('tbody');
    for (const [si, scene] of (this.seq.scenes || []).entries()) {
      tbody.appendChild(h('tr.scene-row', { dataset: { scene: scene.id } }, h('td', { colspan: '6' },
        h('span.mono.muted', { style: { marginRight: '12px' } }, scene.id), scene.title || '', h('span.caption.muted', { style: { marginLeft: '12px', fontWeight: 400 } }, t('{n} 句', { n: (scene.lines || []).length })))));
      for (const [li, line] of (scene.lines || []).entries()) {
        const tr = this.lineRow(scene, line, si, li);
        tbody.appendChild(tr);
      }
    }
    mount(this.tableBox, h('table.table.script-table', { 'aria-label': t('句子') },
      h('colgroup', h('col.c-id'), h('col.c-sub'), h('col.c-speak'), h('col.c-anchor'), h('col.c-pause'), h('col.c-play')),
      h('thead', h('tr', h('th', 'ID'), h('th', t('字幕')), h('th', t('朗讀（空白＝同字幕）')), h('th', t('錨點')), h('th.num', t('停頓 s')), h('th', { 'aria-label': t('試聽') }, ''))),
      tbody));
    this.applyFilter();
  }

  lineRow(scene, line, si, li) {
    const tr = h('tr', { tabindex: '-1', dataset: { line: line.id }, 'aria-selected': String(this.st.selected === line.id) });
    const sub = autoTA(line.subtitle || '', t('字幕'));
    const speak = autoTA(line.speak ?? '', t('朗讀'), line.subtitle || '');
    const pause = h('input.input.num', { type: 'number', step: '0.01', min: '0', max: '10', value: line.pauseAfter ?? '', placeholder: String(this.st.doc.defaults?.pauseAfter ?? ''), 'aria-label': t('停頓秒數'), style: { width: '76px', height: '28px' } });
    sub.addEventListener('input', () => { this.setField(line, 'subtitle', sub.value); });
    speak.addEventListener('input', () => { this.setField(line, 'speak', speak.value.trim() === '' ? null : speak.value); });
    pause.addEventListener('input', () => {
      const v = pause.value.trim();
      this.setField(line, 'pauseAfter', v === '' ? null : Number(v));
    });
    for (const el of [sub, speak, pause]) el.addEventListener('focus', () => this.select(line.id, false));
    const anchors = h('td', { class: 'anchors-cell' }, this.anchorTags(line));
    const play = btn('', { small: true, icon: 'speaker', aria: t('播放此句現有音檔'), onClick: () => this.preview(line) });
    const errs = h('div.inline-errors', { role: 'status' });
    tr.append(h('td.line-key', line.id), h('td.sub', sub, errs), h('td.speak', speak), anchors, h('td.num', pause), h('td', play));
    tr.addEventListener('click', (e) => { if (!e.target.closest('textarea, input, button')) this.select(line.id, true); });
    this.rowEls.set(line.id, { tr, errs, anchors, sub, speak, pause, line });
    this.paintIssues(line.id);
    if (this.st.dirtyIds.has(line.id)) tr.classList.add('dirty');
    return tr;
  }

  anchorTags(line) {
    const a = line.anchors || {};
    const keys = Object.keys(a);
    if (!keys.length) return h('span.caption.muted', '—');
    return h('div.row.wrap', { style: { gap: '4px' } }, keys.map((k) => h('span.tag.anchor', { title: `${k} = 「${a[k]}」` }, `${k}·${a[k]}`)));
  }

  paintIssues(lineId) {
    const r = this.rowEls.get(lineId); if (!r) return;
    const { errors, warnings } = this.issuesFor(lineId);
    mount(r.errs, errors.map((e) => h('div', `${fieldName(e.field)}：${e.message}`)), warnings.map((e) => h('div.warn-text', `${fieldName(e.field)}：${e.message}`)));
    r.tr.classList.toggle('has-error', errors.length > 0);
    const bad = (f) => errors.some((e) => (e.field || '').startsWith(f));
    r.sub.classList.toggle('invalid', bad('subtitle'));
    r.speak.classList.toggle('invalid', bad('speak'));
    r.pause.classList.toggle('invalid', bad('pause'));
  }

  setField(line, fieldKey, value) {
    if (value === null || value === undefined || (typeof value === 'number' && isNaN(value))) {
      if (fieldKey === 'pauseAfter' && value !== null && isNaN(value)) line[fieldKey] = value; // keep invalid → validator reports
      else delete line[fieldKey];
    } else line[fieldKey] = value;
    this.markDirty(line.id);
    if (fieldKey === 'subtitle') { const r = this.rowEls.get(line.id); if (r) r.speak.placeholder = value; }
    if (this.st.selected === line.id && fieldKey !== 'anchors') this.syncInspector(fieldKey);
  }

  markDirty(id) {
    this.st.dirtyIds.add(id);
    const r = this.rowEls.get(id); if (r) r.tr.classList.add('dirty');
    this.updateHeader();
    clearTimeout(this.vTimer);
    this.vTimer = setTimeout(() => this.validate(false), 450);
  }

  async validate(explicit) {
    try {
      const v = await call('narration_validate', { doc: this.st.doc });
      this.st.validation = v;
      for (const id of this.rowEls.keys()) this.paintIssues(id);
      this.renderBanners(); this.updateHeader();
      if (this.st.selected) this.renderInspectorIssues();
      if (explicit) toast(v.errors.length ? t('有 {n} 個錯誤需要修正', { n: v.errors.length }) : t('驗證通過（{w} 個警告）', { w: v.warnings.length }), v.errors.length ? 'fail' : 'ok');
    } catch (e) { if (explicit) toastError(e, t('驗證')); else console.warn(e); }
  }

  applyFilter() {
    const f = (this.st.filter || '').trim().toLowerCase();
    let shown = 0;
    for (const [id, r] of this.rowEls) {
      const l = r.line;
      const hay = [id, l.subtitle, l.speak, ...Object.entries(l.anchors || {}).flat()].join(' ').toLowerCase();
      const ok = !f || hay.includes(f);
      const was = r.tr.hidden;
      r.tr.hidden = !ok; if (ok) shown++;
      if (ok && was) requestAnimationFrame(() => { fit(r.sub); fit(r.speak); });
    }
    this.tableBox.querySelectorAll('tr.scene-row').forEach((tr) => {
      let n = tr.nextElementSibling, any = false;
      while (n && !n.classList.contains('scene-row')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
      tr.hidden = !any && !!f;
    });
  }

  select(id, focusRow) {
    if (this.st.selected === id) return;
    const prev = this.rowEls.get(this.st.selected); if (prev) prev.tr.setAttribute('aria-selected', 'false');
    this.st.selected = id;
    const r = this.rowEls.get(id); if (r) { r.tr.setAttribute('aria-selected', 'true'); if (focusRow) r.sub.focus(); }
    this.renderInspector();
  }

  findLine(id) {
    for (const s of this.seq.scenes || []) for (const l of s.lines || []) if (l.id === id) return { scene: s, line: l };
    return null;
  }

  renderInspector() {
    const box = this.inspector;
    const found = this.st.selected && this.findLine(this.st.selected);
    if (!found) {
      mount(box, h('div.headline', t('檢閱器')), h('div.callout.muted', t('選取一句以編輯字幕、朗讀文字、停頓與錨點。')),
        h('hr.divider'), h('dl.kv',
          h('dt', t('檔案')), h('dd.mono', { style: { fontSize: '12px' } }, this.st.file.path),
          h('dt', 'SHA-256'), h('dd.mono', { style: { fontSize: '12px' } }, (this.st.file.sha256 || '').slice(0, 16) + '…'),
          h('dt', t('配音引擎')), h('dd', this.seqMeta.voiceEngine || this.seq.voiceEngine || t('未指定（edge）')),
          h('dt', t('預設停頓')), h('dd.num', `${this.st.doc.defaults?.pauseAfter ?? '—'} s`)));
      return;
    }
    const { scene, line } = found;
    const sub = h('textarea.textarea', { rows: '3', 'aria-label': t('字幕') }); sub.value = line.subtitle || '';
    const speak = h('textarea.textarea', { rows: '3', placeholder: line.subtitle || '', 'aria-label': t('朗讀') }); speak.value = line.speak ?? '';
    const pause = h('input.input.num', { type: 'number', step: '0.01', min: '0', max: '10', value: line.pauseAfter ?? '', placeholder: String(this.st.doc.defaults?.pauseAfter ?? ''), 'aria-label': t('停頓秒數') });
    const r = () => this.rowEls.get(line.id);
    sub.addEventListener('input', () => { this.setField(line, 'subtitle', sub.value); const x = r(); if (x) { x.sub.value = sub.value; fit(x.sub); } speak.placeholder = sub.value; });
    speak.addEventListener('input', () => { this.setField(line, 'speak', speak.value.trim() === '' ? null : speak.value); const x = r(); if (x) { x.speak.value = speak.value; fit(x.speak); } });
    pause.addEventListener('input', () => { const v = pause.value.trim(); this.setField(line, 'pauseAfter', v === '' ? null : Number(v)); const x = r(); if (x) x.pause.value = pause.value; });
    this.insp = { sub, speak, pause, line };

    const anchorsBox = h('div.col', { style: { gap: '8px' } });
    const renderAnchors = () => {
      const a = line.anchors || {};
      mount(anchorsBox, Object.keys(a).length ? Object.entries(a).map(([k, v]) => this.anchorEditor(line, k, v, renderAnchors)) : h('div.caption.muted', t('沒有錨點')),
        btn(t('新增錨點'), { small: true, icon: 'plus', onClick: () => {
          line.anchors = line.anchors || {};
          let n = 1; while (line.anchors[`anchor${n}`] !== undefined) n++;
          line.anchors[`anchor${n}`] = ''; this.anchorsChanged(line); renderAnchors();
          const inputs = anchorsBox.querySelectorAll('input'); if (inputs.length >= 2) inputs[inputs.length - 2].focus();
        } }));
    };
    renderAnchors();

    this.inspIssues = h('div.col', { style: { gap: '4px' } });
    const engineDir = this.audioPath(line);
    mount(box,
      h('div.row', h('div.headline.grow', t('句 {id}', { id: line.id })), tag(scene.id)),
      h('div.caption.muted', scene.title || ''),
      this.inspIssues,
      field(t('字幕'), sub),
      field(t('朗讀（空白＝同字幕）'), speak),
      field(t('停頓（秒，空白＝預設）'), pause),
      h('div.field', h('div.label', t('錨點（名稱 → 朗讀中的詞）')), anchorsBox),
      h('hr.divider'),
      h('div.field', h('div.label', t('試聽')), h('div.row', btn(t('播放現有音檔'), { icon: 'speaker', onClick: () => this.preview(line) }), btn('', { icon: 'stop', aria: t('停止'), onClick: () => audio && audio.pause() })),
        h('div.caption.muted.mono', { style: { overflowWrap: 'anywhere' } }, engineDir),
        h('div.caption.muted', t('播放的是上次產生的音檔；修改文字後需要在「製作」重新產生配音。'))));
    this.renderInspectorIssues();
  }

  anchorEditor(line, k, v, rerender) {
    const name = h('input.input.mono', { value: k, 'aria-label': t('錨點名稱'), style: { height: '28px' } });
    const val = h('input.input', { value: v, 'aria-label': t('錨點文字'), style: { height: '28px' } });
    let cur = k;
    name.addEventListener('change', () => {
      const nk = name.value.trim();
      if (!nk || nk === cur) { name.value = cur; return; }
      if (line.anchors[nk] !== undefined) { toast(t('錨點名稱重複：{x}', { x: nk }), 'warn'); name.value = cur; return; }
      // rename preserving order
      const next = {}; for (const [kk, vv] of Object.entries(line.anchors)) next[kk === cur ? nk : kk] = vv;
      line.anchors = next; cur = nk; this.anchorsChanged(line);
    });
    val.addEventListener('input', () => { line.anchors[cur] = val.value; this.anchorsChanged(line); });
    const del = btn('', { small: true, icon: 'x', aria: t('刪除錨點 {x}', { x: k }), onClick: () => { delete line.anchors[cur]; if (!Object.keys(line.anchors).length) delete line.anchors; this.anchorsChanged(line); rerender(); } });
    return h('div.anchor-row', name, val, del);
  }

  anchorsChanged(line) {
    const r = this.rowEls.get(line.id); if (r) mount(r.anchors, this.anchorTags(line));
    this.markDirty(line.id);
  }

  syncInspector(fieldKey) {
    const i = this.insp; if (!i) return;
    const l = i.line;
    if (fieldKey === 'subtitle' && document.activeElement !== i.sub) { i.sub.value = l.subtitle || ''; i.speak.placeholder = l.subtitle || ''; }
    if (fieldKey === 'speak' && document.activeElement !== i.speak) i.speak.value = l.speak ?? '';
    if (fieldKey === 'pauseAfter' && document.activeElement !== i.pause) i.pause.value = l.pauseAfter ?? '';
  }

  renderInspectorIssues() {
    if (!this.inspIssues || !this.st.selected) return;
    const { errors, warnings } = this.issuesFor(this.st.selected);
    mount(this.inspIssues, errors.map((e) => h('div.banner.fail', { style: { padding: '8px 12px' } }, h('div.grow', `${fieldName(e.field)}：${e.message}`))),
      warnings.map((e) => h('div.banner.warn', { style: { padding: '8px 12px' } }, h('div.grow', `${fieldName(e.field)}：${e.message}`))));
  }

  audioPath(line) {
    const eng = this.seqMeta.voiceEngine || this.seq.voiceEngine || 'edge';
    const dir = this.locale === 'zh-CN' ? 'voiceover_cosy_cn' : eng === 'cosyvoice' ? 'voiceover_cosy' : 'voiceover';
    return `${this.p.rootPath.replace(/[\\/]+$/, '')}\\public\\assets\\audio\\${dir}\\${this.st.seqKey}\\${line.id}.mp3`;
  }

  async preview(line) {
    const path = this.audioPath(line);
    try {
      const ok = await ensureAssets(this.p.id);
      if (!ok) { toast(t('資產協定未允許此專案路徑，無法播放。'), 'warn'); return; }
    } catch (e) { toastError(e, t('試聽')); return; }
    if (!audio) audio = new Audio();
    audio.pause();
    audio.src = fileSrc(path);
    audio.onerror = () => toast(t('找不到或無法播放音檔：{x}', { x: path }), 'warn');
    audio.play().catch(() => {});
  }

  async save() {
    const { st } = this;
    if (!st.dirtyIds.size) return;
    this.saveBtn.disabled = true;
    try {
      const v = await call('narration_validate', { doc: st.doc });
      st.validation = v; for (const id of this.rowEls.keys()) this.paintIssues(id); this.renderBanners();
      if (v.errors.length) { toast(t('有 {n} 個錯誤，無法儲存。', { n: v.errors.length }), 'fail'); const first = v.errors.find((e) => e.seqKey === st.seqKey && e.lineId); if (first) this.select(first.lineId, true); return; }
      const changed = [...st.dirtyIds];
      const message = `Studio: edit narration ${this.locale} ${st.seqKey} (${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', …' : ''})`;
      const r = await call('narration_save', { projectId: this.p.id, locale: this.locale, doc: st.doc, expectedSha256: st.file.sha256, message });
      const unchanged = r.sha256 === st.file.sha256;
      st.file.sha256 = r.sha256;
      st.dirtyIds.clear();
      this.rowEls.forEach((x) => x.tr.classList.remove('dirty'));
      if (unchanged && !r.commit) toast(t('內容與磁碟上相同，沒有寫入也沒有 commit。'), 'info');
      else if (r.commit) toast(t('已儲存並提交 {c}', { c: String(r.commit).slice(0, 7) }), 'ok');
      else toast(t('已儲存，但 git commit 失敗：{e}', { e: r.commitError || '—' }), 'warn');
    } catch (e) {
      if (/changed|sha|外部|modified/i.test(e.message || '')) {
        const reload = await confirmSheet({ title: t('檔案已在外部被修改'), text: t('磁碟上的 narration.json 在你開始編輯後被其他程式修改了。重新載入會捨棄目前未儲存的修改。'), detail: e.message, confirmLabel: t('重新載入'), destructive: true });
        if (reload) { drafts.delete(this.key); this.ctx.rerender(); }
      } else toastError(e, t('儲存'));
    } finally { this.updateHeader(); }
  }

  async reload() {
    if (this.st.dirtyIds.size) {
      const ok = await confirmSheet({ title: t('捨棄未儲存的修改？'), text: t('{n} 句有未儲存的修改，重新載入會捨棄它們。', { n: this.st.dirtyIds.size }), confirmLabel: t('捨棄並重新載入'), destructive: true });
      if (!ok) return;
    }
    drafts.delete(this.key); this.ctx.rerender();
  }
}

function fieldName(f) {
  const m = { subtitle: t('字幕'), speak: t('朗讀'), pauseAfter: t('停頓'), anchors: t('錨點'), id: 'ID' };
  if (!f) return t('句');
  const base = String(f).split(/[.[]/)[0];
  return m[base] ? (f.includes('.') ? `${m[base]} ${String(f).slice(base.length + 1)}` : m[base]) : f;
}

function autoTA(value, label, placeholder) {
  const ta = h('textarea.textarea', { rows: '1', 'aria-label': label, placeholder: placeholder || null, spellcheck: 'false',
    style: { minHeight: '28px', padding: '4px 8px', background: 'transparent', borderColor: 'transparent', resize: 'none', overflow: 'hidden' } });
  ta.value = value;
  ta.addEventListener('input', () => fit(ta));
  ta.addEventListener('focus', () => { ta.style.borderColor = ''; ta.style.background = ''; });
  ta.addEventListener('blur', () => { ta.style.borderColor = 'transparent'; ta.style.background = 'transparent'; });
  requestAnimationFrame(() => fit(ta));
  return ta;
}
function fit(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.max(28, ta.scrollHeight + 2)}px`; }
