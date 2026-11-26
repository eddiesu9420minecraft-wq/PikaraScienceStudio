// Editor — one episode's workspace: every stage (status, files, last completed, actions) straight from the Rust
// backend (workspace_get), narration lines with inline edit, re-voice (one / several / whole language) and
// re-render (remux / affected scenes / full) with a plan shown before anything runs.
import { t } from '../i18n.js';
import { h, mount, btn, toast, toastError, loading, errorBox, sheet, seg, toggle, field, fmtTime, openPath, busy, notReady, needProject } from '../ui.js';
import { icon } from '../icons.js';
import { call, hasTauri } from '../api.js';
import { on } from '../store.js';
import { tabbed, epPicker, episodes, resolveSel, select, needEpisode, statusPill, card, popupMenu, audioFor, pathLine, fmtSecs } from '../v03/common.js';
import script from './script.js';
import prompt from './prompt.js';
import production from './production.js';

export default {
  id: 'editor', title: '單集編輯', icon: 'pen',
  async render(ctx) {
    await tabbed(ctx, t('單集編輯'), [
      { id: 'workspace', title: '工作區', render: (el) => workspaceTab(el, ctx) },
      { id: 'script', title: '完整腳本', screen: script },
      { id: 'prompt', title: '提示詞', screen: prompt },
      { id: 'production', title: '單步工具', screen: production },
    ]);
  },
};

async function workspaceTab(el, ctx) {
  if (!hasTauri) return mount(el, h('div.page', notReady(['workspace_get', 'episode_list'])));
  if (!ctx.projectId) return mount(el, h('div.page', needProject()));
  mount(el, h('div.page', loading(6)));
  let list;
  try { list = await episodes(true); } catch (e) { return mount(el, h('div.page', errorBox(e, () => ctx.rerender()))); }
  const cur = resolveSel(list);
  if (!cur) return mount(el, needEpisode(ctx));
  select(cur.episode, cur.locale);
  const state = { ws: null, selected: new Set() };
  const body = h('div.col', { style: { gap: '20px' } });
  const picker = epPicker(list, cur, (e, l) => { select(e, l); ctx.rerender(); });
  const revoiceBtn = btn(t('重新配音'), { icon: 'mic', onClick: () => revoiceSheet(ctx, cur, state, [...state.selected]) });
  const rerenderBtn = btn(t('重新渲染'), { kind: 'primary', icon: 'rerender', onClick: () => rerenderSheet(ctx, cur, state) });
  ctx.toolbar(t('單集編輯'), `${cur.episode.toUpperCase()} · ${cur.locale}`, [
    btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => load() }), revoiceBtn, rerenderBtn,
  ]);
  mount(el, h('div.page', { style: { paddingTop: '20px' } }, h('div.row.wrap', { style: { justifyContent: 'space-between' } }, picker), body));

  async function load() {
    try {
      state.ws = await call('workspace_get', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale });
    } catch (e) { return mount(body, errorBox(e, load)); }
    if (!ctx.alive()) return;
    paint();
  }
  function paint() {
    const ws = state.ws;
    const st = Object.fromEntries(ws.stages.map((s) => [s.id, s]));
    const dirty = ['voice', 'timeline', 'mix', 'video'].filter((k) => st[k] && ['stale', 'missing'].includes(st[k].status));
    mount(body,
      dirty.length ? h('div.banner.warn', icon('alert'), h('div.grow',
        h('div', { style: { fontWeight: 600 } }, st.voice.status === 'stale' || st.voice.status === 'missing' ? t('有句子的文字改過但還沒重新配音') : t('配音或腳本已更新，影片還是舊的')),
        h('div.caption', t('需要更新：{x}。重新配音只會處理這些句子；重新渲染會沿用沒有改變的畫面。', { x: dirty.map((k) => t(st[k].title)).join('、') }))),
      st.voice.status === 'stale' || st.voice.status === 'missing'
        ? btn(t('重新配音已修改的句子'), { small: true, kind: 'primary', onClick: () => revoiceSheet(ctx, cur, state, st.voice.lines.filter((l) => l.state !== 'ok').map((l) => l.id)) })
        : btn(t('重新渲染'), { small: true, kind: 'primary', onClick: () => rerenderSheet(ctx, cur, state) })) : null,
      h('div.stages', ws.stages.map((s) => stageCard(ctx, cur, state, s))),
      linesCard(ctx, cur, state),
      h('div.grid2', outputCard(ctx, cur, st.video), historyCard(ws.history)),
    );
  }
  state.reload = load;
  ctx.cleanup(on('job', (j) => {
    if (!j || !['succeeded', 'failed', 'canceled'].includes(j.status)) return;
    const p = j.params || {};
    if ((p.episode || p.seq) === cur.episode) load();
  }));
  await load();
}

function stageCard(ctx, cur, state, s) {
  const more = btn('', { icon: 'more', small: true, aria: t('更多操作') });
  more.addEventListener('click', () => popupMenu(more, [
    { label: t('開啟所在資料夾'), icon: 'folder', onClick: () => openPath(s.location) },
    s.id === 'script' && { label: t('編輯完整腳本'), icon: 'script', onClick: () => ctx.setTab('script') },
    s.id === 'voice' && { label: t('整個語言版本重新配音'), icon: 'mic', onClick: () => revoiceSheet(ctx, cur, state, []) },
    s.id === 'voice' && { label: t('到語音工作室試聽與比較'), icon: 'speaker', onClick: () => ctx.go('voice') },
    ['timeline', 'mix', 'video', 'animation'].includes(s.id) && { label: t('重新渲染…'), icon: 'rerender', onClick: () => rerenderSheet(ctx, cur, state) },
    s.id === 'video' && s.files && s.files[0] && { label: t('預覽與發佈'), icon: 'play', onClick: () => { sessionStorage.setItem('publish.select', s.files[0].path); ctx.go('projects/publish'); } },
    s.id === 'research' && { label: t('開啟研究資料夾'), icon: 'external', onClick: () => openPath(s.location) },
  ]));
  return h('div', { class: `stage ${s.status}`, dataset: { stage: s.id } },
    h('div.top', h('span.name', t(s.title)), statusPill(s.status), more),
    h('div.detail', t(s.detail || '')),
    h('div.meta', h('span', s.updatedAt ? fmtTime(s.updatedAt) : t('—')), h('span.loc', { title: s.location }, s.location || '')));
}

function linesCard(ctx, cur, state) {
  const voice = state.ws.stages.find((s) => s.id === 'voice');
  const lines = voice.lines || [];
  const count = h('span.caption.muted');
  const sync = () => { count.textContent = state.selected.size ? t('已選 {n} 句', { n: state.selected.size }) : t('{n} 句', { n: lines.length }); batch.disabled = !state.selected.size; };
  const batch = btn(t('重新配音所選'), { small: true, icon: 'mic', onClick: () => revoiceSheet(ctx, cur, state, [...state.selected]) });
  const rows = [];
  let scene = null;
  for (const l of lines) {
    if (l.scene !== scene) { scene = l.scene; rows.push(h('div.scene-head', l.scene)); }
    rows.push(lineRow(ctx, cur, state, l, sync));
  }
  const c = card(t('旁白'), h('div.lines', rows), { flush: true, actions: [count, batch] });
  setTimeout(sync, 0);
  return c;
}

function lineRow(ctx, cur, state, l, sync) {
  const cb = h('input', { type: 'checkbox', 'aria-label': t('選取 {x}', { x: l.id }), checked: state.selected.has(l.id) });
  cb.addEventListener('change', () => { if (cb.checked) state.selected.add(l.id); else state.selected.delete(l.id); sync(); });
  const txt = h('div.txt', h('div', l.subtitle), l.speak && l.speak !== l.subtitle ? h('div.speak', t('朗讀：{x}', { x: l.speak })) : null);
  const row = h('div.line', { dataset: { line: l.id } }, cb, h('div.lid', { title: l.id }, l.id), txt,
    h('div.acts',
      l.state !== 'ok' ? statusPill(l.state === 'missing' ? 'missing' : 'stale') : null,
      l.versions ? h('span.tag', { title: t('保留的舊版本數') }, `${l.versions} ${t('版')}`) : null,
      btn('', { small: true, icon: 'play', aria: t('試聽'), disabled: l.state === 'missing', onClick: async () => { mount(txt, h('div', l.subtitle), await audioFor(l.path)); txt.querySelector('audio').play().catch(() => {}); } }),
      btn('', { small: true, icon: 'pen', aria: t('修改這一句'), onClick: () => editLine() }),
      btn('', { small: true, icon: 'mic', aria: t('重新配音這一句'), onClick: () => revoiceSheet(ctx, cur, state, [l.id]) })));
  function editLine() {
    const sub = h('textarea.textarea', { rows: 2, 'aria-label': t('字幕') }); sub.value = l.subtitle;
    const sp = h('textarea.textarea', { rows: 1, 'aria-label': t('朗讀文字'), placeholder: t('（空白＝照字幕朗讀）') }); sp.value = l.speak !== l.subtitle ? l.speak : '';
    const save = btn(t('儲存'), { small: true, kind: 'primary', onClick: async () => {
      await busy(save, async () => {
        try {
          const r = await call('line_set', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, line: l.id, subtitle: sub.value, speak: sp.value });
          if (r.changed) {
            toast(t('已儲存 {x}（已提交到 Git）。這一句需要重新配音。', { x: l.id }), 'ok', [{ label: t('立即重新配音'), onClick: () => revoiceSheet(ctx, cur, state, [l.id]) }]);
          } else toast(t('沒有變更'), 'info');
          state.reload();
        } catch (e) { toastError(e, t('儲存')); }
      });
    } });
    mount(txt, h('div.edit', field(t('字幕'), sub), field(t('朗讀文字（選填）'), sp), h('div.row.gap2', save, btn(t('取消'), { small: true, onClick: () => state.reload() }))));
    sub.focus();
  }
  return row;
}

function outputCard(ctx, cur, video) {
  const files = video.files || [];
  const vers = (video.versions || []).slice(0, 6);
  return card(t('目前的成品'), h('div.col',
    files.length ? h('div.col', { style: { gap: '4px' } }, h('div', { style: { fontWeight: 600 } }, files[0].name), pathLine(files[0].path), h('div.caption.muted', fmtTime(files[0].modifiedAt))) : h('div.caption.muted', t('還沒有成品')),
    vers.length ? h('div', h('div.caption.muted', { style: { margin: '8px 0 4px' } }, t('保留的版本')),
      h('div.versions', vers.map((v) => h('div.version', h('span.v', `v${String(v.version).padStart(3, '0')}`), h('div', { style: { minWidth: 0 } }, h('div.caption', t(v.meta && v.meta.reason ? v.meta.reason : '')), pathLine(v.path)),
        btn('', { small: true, icon: 'folder', aria: t('開啟資料夾'), onClick: () => openPath(v.path) }))))) : null));
}

function historyCard(hist) {
  const items = [
    ...(hist.commits || []).map((c) => ({ at: c.at, text: c.subject, kind: 'Git ' + c.commit })),
    ...(hist.versions || []).map((v) => ({ at: v.createdAt, text: `${v.item} v${v.version} · ${t(v.status === 'candidate' ? '候選' : '保留')}`, kind: v.status === 'candidate' ? t('候選版本') : t('版本') })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
  return card(t('歷史版本'), items.length ? h('div.col', { style: { gap: '6px' } }, items.map((i) => h('div.row', { style: { alignItems: 'flex-start' } },
    h('span.caption.muted.nowrap', { style: { width: '92px' } }, fmtTime(i.at)), h('div.grow', h('div.callout.ellipsis', { title: i.text }, i.text), h('div.caption.muted', i.kind))))) : h('div.caption.muted', t('還沒有紀錄')));
}

// ---------------------------------------------------------------- re-voice

export function revoiceSheet(ctx, cur, state, lines) {
  const all = !lines || !lines.length;
  const scope = all ? t('整個 {l} 版本（全部 {n} 句）', { l: cur.locale, n: (state.ws.stages.find((s) => s.id === 'voice').lines || []).length }) : lines.length === 1 ? t('單句：{x}', { x: lines[0] }) : t('{n} 句：{x}', { n: lines.length, x: lines.slice(0, 6).join('、') + (lines.length > 6 ? '…' : '') });
  const opts = { provider: 'cosyvoice', speedMode: 'default', speed: 1.0, targetCps: 4.4, ref: '', refText: '', review: false };
  const provider = h('select.select', { 'aria-label': t('TTS 引擎') }, h('option', { value: 'cosyvoice' }, 'CosyVoice 3（本機 GPU）'), h('option', { value: 'edge', disabled: true }, t('Edge TTS（v0.3 不支援重新配音）')));
  const ref = h('input.input', { placeholder: t('預設參考聲音（空白）'), 'aria-label': t('參考音訊') });
  const refText = h('input.input', { placeholder: t('自訂參考音訊的逐字稿'), 'aria-label': t('參考音訊逐字稿'), disabled: true });
  ref.addEventListener('input', () => { refText.disabled = !ref.value.trim(); });
  const speedBox = h('div.row.gap2');
  const speedSeg = seg([{ value: 'default', label: t('與其他句子相同') }, { value: 'speed', label: t('指定倍率') }, { value: 'cps', label: t('目標字/秒') }], 'default', (v) => { opts.speedMode = v; paintSpeed(); });
  const paintSpeed = () => mount(speedBox, opts.speedMode === 'speed'
    ? h('input.input.num', { type: 'number', min: '0.85', max: '1.15', step: '0.05', value: String(opts.speed), oninput: (e) => { opts.speed = Number(e.target.value); } })
    : opts.speedMode === 'cps' ? h('input.input.num', { type: 'number', min: '2', max: '6', step: '0.1', value: String(opts.targetCps), oninput: (e) => { opts.targetCps = Number(e.target.value); } }) : null);
  paintSpeed();
  sheet({
    title: t('重新配音'),
    body: [
      h('div.banner.info', icon('info'), h('div.grow', h('div', { style: { fontWeight: 600 } }, scope),
        h('div.caption', t('新音訊先產生為候選版本，通過驗證（文字一致、語音辨識錯誤率、長度）後才切換為目前版本；舊音訊保留在版本資料夾，可隨時還原。不會重新研究或改寫腳本，其他句子不受影響。')))),
      h('div.form-grid', field(t('TTS 引擎'), provider), field(t('語言'), h('input.input', { value: cur.locale, disabled: true })),
        field(t('參考音訊（選填）'), ref, h('div.caption.muted', t('public/user/… 或 tools/CosyVoice/reference…'))), field(t('參考音訊逐字稿'), refText)),
      field(t('目標語速'), h('div.row.gap2.wrap', speedSeg, speedBox)),
      toggle(t('不自動切換：產生後先到語音工作室試聽、A/B 比較再決定'), false, (v) => { opts.review = v; }),
      h('div.caption.muted', t('成品影片不會自動更新；配音完成後按「重新渲染」。')),
    ],
    actions: [
      { label: t('取消') },
      { label: t('開始重新配音'), kind: 'primary', onClick: async () => {
        const o = { provider: provider.value, review: opts.review };
        if (opts.speedMode === 'speed') o.speed = opts.speed;
        if (opts.speedMode === 'cps') o.targetCps = opts.targetCps;
        if (ref.value.trim()) { o.ref = ref.value.trim(); o.refText = refText.value.trim(); }
        try {
          const j = await call('revoice_start', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, lines: all ? [] : lines, options: o });
          toast(t('已加入佇列：{x}', { x: j.label }), 'ok', [{ label: t('查看'), onClick: () => { sessionStorage.setItem('queue.select', j.id); ctx.go('queue/jobs'); } }]);
        } catch (e) { toastError(e, t('重新配音')); return false; }
        return true;
      } },
    ],
  });
}

// ---------------------------------------------------------------- re-render

const MODES = [
  { value: 'remux', label: '僅重新混音和封裝', desc: '畫面全部沿用；適合只改了音量、配樂或編碼設定' },
  { value: 'affected', label: '重新渲染受影響片段', desc: '只渲染改變的場景；後面整段平移的場景直接沿用' },
  { value: 'full', label: '完整重新渲染', desc: '所有畫面重新渲染（最慢）' },
];

export function rerenderSheet(ctx, cur, state) {
  const p = { mode: 'affected', fps: 30, res: '1080p', encoder: 'auto', quality: 'standard', qa: true };
  const planBox = h('div.col', loading(3));
  let startBtn = null;
  let seq = 0;
  const replan = async () => {
    const my = ++seq;
    mount(planBox, h('div.row.gap2', h('span.dot.running'), h('span.caption.muted', t('計算計畫中（試算時間軸與可沿用的畫面，不會改任何檔案）…'))));
    if (startBtn) startBtn.disabled = true;
    try {
      const plan = await call('rerender_plan', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, params: p });
      if (my !== seq) return;
      mount(planBox, planView(plan));
      if (startBtn) startBtn.disabled = (plan.blockers || []).length > 0;
    } catch (e) { if (my === seq) mount(planBox, errorBox(e, replan)); }
  };
  const modeSeg = h('div.col', { style: { gap: '6px' } }, MODES.map((m) => {
    const r = h('input', { type: 'radio', name: 'rr-mode', value: m.value, checked: m.value === p.mode });
    r.addEventListener('change', () => { p.mode = m.value; replan(); });
    return h('label.row', { style: { alignItems: 'flex-start', gap: '8px' } }, r, h('div', h('div', { style: { fontWeight: 600 } }, t(m.label)), h('div.caption.muted', t(m.desc))));
  }));
  const enc = h('select.select', { 'aria-label': t('編碼器') }, [['auto', t('自動（實測可用的硬體編碼器）')], ['h264_nvenc', 'NVIDIA NVENC'], ['h264_amf', 'AMD AMF'], ['h264_qsv', 'Intel QSV'], ['libx264', t('CPU（libx264）')]]
    .map(([v, l]) => h('option', { value: v }, l)));
  enc.addEventListener('change', () => { p.encoder = enc.value; replan(); });
  const out = state.ws.stages.find((s) => s.id === 'video');
  const dlg = sheet({
    title: t('重新渲染 {e} · {l}', { e: cur.episode.toUpperCase(), l: cur.locale }),
    wide: true,
    body: [
      h('div.grid2', { style: { alignItems: 'start' } },
        h('div.col', field(t('模式'), modeSeg),
          h('div.form-grid',
            field(t('解析度'), seg([{ value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }], p.res, (v) => { p.res = v; replan(); })),
            field(t('FPS'), seg([{ value: 30, label: '30' }, { value: 60, label: '60' }], p.fps, (v) => { p.fps = v; replan(); })),
            field(t('畫面品質'), seg([{ value: 'high', label: t('高') }, { value: 'standard', label: t('標準') }, { value: 'draft', label: t('草稿') }], p.quality, (v) => { p.quality = v; replan(); })),
            field(t('編碼器'), enc)),
          toggle(t('切換前先跑品質檢查'), true, (v) => { p.qa = v; replan(); }),
          field(t('輸出位置'), h('div.col', { style: { gap: '2px' } }, pathLine(out.location), h('div.caption.muted', t('目前的成品會先保留到 output\\versions（硬連結），新影片通過檢查後才取代。'))))),
        h('div.col', h('div.headline', t('開始前確認')), planBox)),
    ],
    actions: [
      { label: t('取消') },
      { label: t('開始重新渲染'), kind: 'primary', onClick: async () => {
        try {
          const j = await call('rerender_start', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, params: p });
          toast(t('已加入佇列：{x}', { x: j.label }), 'ok', [{ label: t('查看'), onClick: () => { sessionStorage.setItem('queue.select', j.id); ctx.go('queue/jobs'); } }]);
        } catch (e) { toastError(e, t('重新渲染')); return false; }
        return true;
      } },
    ],
  });
  startBtn = dlg.el.querySelector('.sheet-foot .btn.primary');
  replan();
}

function planView(plan) {
  const f = plan.frames || {};
  const sc = f.scenes || [];
  const tot = sc.reduce((s, x) => s + (x.frames || 0), 0) || 1;
  return h('div.col', { style: { gap: '12px' } },
    (plan.blockers || []).map((b) => h('div.banner.fail', icon('alert'), h('div.grow', b))),
    (plan.warnings || []).map((w) => h('div.banner.warn', icon('alert'), h('div.grow.caption', w))),
    h('div', h('div.caption.muted', t('會重新執行')), h('ul.plan-list', (plan.run || []).map((r) => h('li.run', icon('play'), h('div', h('b', t(r.title)), ' — ', h('span.muted', r.why)))))),
    h('div', h('div.caption.muted', t('沿用（不重做）')), h('ul.plan-list', (plan.reuse || []).map((r) => h('li.reuse', icon('check'), h('div', h('b', t(r.what)), ' — ', h('span.muted', r.detail)))))),
    sc.length ? h('div.col', { style: { gap: '4px' } }, h('div.scenebar', { title: t('綠色＝沿用的場景；藍色＝重新渲染') }, sc.map((s) => h('span', { class: s.reuse ? 'r' : 'n', style: { flex: String(s.frames / tot) }, title: `${s.id}：${s.reason}` }))),
      h('div.caption.muted', t('場景：{a} 個沿用、{b} 個重新渲染', { a: sc.filter((s) => s.reuse).length, b: sc.filter((s) => !s.reuse).length }))) : null,
    h('dl.kv', h('dt', t('畫面')), h('dd', t('{c} / {t} 幀沿用，需渲染 {r} 幀', { c: f.cachedFrames ?? 0, t: f.totalFrames ?? '?', r: Math.max(0, (f.totalFrames || 0) - (plan.mode === 'full' ? 0 : (f.cachedFrames || 0))) })),
      h('dt', t('預估時間')), h('dd', fmtSecs(plan.estimate && plan.estimate.seconds)),
      h('dt', t('GPU 記憶體')), h('dd', plan.estimate && plan.estimate.vramPeakMiB ? `${plan.estimate.vramPeakMiB} MiB` : t('依上次報告，未知')),
      h('dt', t('依據')), h('dd.caption', plan.estimate ? plan.estimate.basedOn : '')),
    h('div', h('div.caption.muted', t('會產生或更新的檔案')), h('ul.plan-list', (plan.newFiles || []).map((x) => h('li.file', icon('save'), h('div', h('div.caption', x.note), pathLine(x.path)))))));
}
