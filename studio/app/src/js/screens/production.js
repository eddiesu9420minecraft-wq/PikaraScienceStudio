// 4. Production — one-click pipelines and single steps; forms are built from job_kinds.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, seg, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, field, tag, toggle } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject, store, on } from '../store.js';

const PIPELINES = ['youtube_15x', 'bilibili'];
const HIDDEN = new Set(['claude', 'doctor_fix']);
const STEP_ORDER = ['make_cn', 'voiceover_tw', 'voiceover_cn', 'timeline', 'mix', 'render', 'qa', 'custom'];
const formState = {}; // kind -> params (persist while app is open)

export default {
  id: 'production', title: '製作', icon: 'film',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['job_kinds', 'job_enqueue']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    ctx.toolbar(t('製作'), p.name, [btn(t('前往佇列'), { icon: 'queue', onClick: () => ctx.go('queue') })]);
    mount(ctx.content, h('div.page', loading(6)));
    let kinds, ext = null;
    try { kinds = await call('job_kinds'); } catch (e) { if (ctx.alive()) mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); return; }
    try { ext = await call('gpu_external_status'); } catch {}
    if (!ctx.alive()) return;
    new Production(ctx, p, kinds, ext).mount();
  },
};

class Production {
  constructor(ctx, p, kinds, ext) { Object.assign(this, { ctx, p, kinds, ext }); }
  kind(k) { return this.kinds.find((x) => x.kind === k); }

  mount() {
    this.gpuBanner = h('div');
    const pipes = PIPELINES.map((k) => this.kind(k)).filter(Boolean);
    const steps = this.kinds.filter((k) => !PIPELINES.includes(k.kind) && !HIDDEN.has(k.kind) && !k.kind.startsWith('voiceover'))
      .sort((a, b) => idx(a.kind) - idx(b.kind));
    mount(this.ctx.content, h('div.page',
      this.gpuBanner,
      h('section.section', h('div.section-head', h('h2.title2', t('一鍵製作')), h('span.caption.muted', t('整條管線依序執行；GPU 步驟會等待 GPU 租約。'))),
        pipes.length ? h('div.grid2', pipes.map((k) => this.card(k, true))) : h('div.banner.warn', icon('alert'), h('div.grow', t('後端沒有提供一鍵管線（youtube_15x／bilibili）。')))),
      h('section.section', h('div.section-head', h('h2.title2', t('配音'))), this.voiceCard()),
      h('section.section', h('div.section-head', h('h2.title2', t('單一步驟'))), h('div.grid2', { style: { alignItems: 'start' } }, steps.map((k) => this.card(k, false))))));
    this.paintGpu();
    this.ctx.cleanup(on('queue', (q) => { if (q && q.external) { this.ext = q.external; this.paintGpu(); } }));
  }

  paintGpu() {
    const q = store.queue; const e = this.ext;
    const kids = [];
    if (e && e.busy) kids.push(h('div.banner.warn', icon('alert'), h('div.grow', h('div', { style: { fontWeight: 600 } }, t('GPU 目前被外部程式使用')),
      h('div.muted', (e.reasons || []).join('；') || ''), e.vramUsedMiB != null ? h('div.muted.num', `VRAM ${e.vramUsedMiB} MiB`) : null,
      h('div.muted', t('GPU 工作會停在「等待資源」，直到 GPU 空出來才開始。')))));
    if (q && q.gpuHolder) kids.push(h('div.banner.info', icon('info'), h('div.grow', t('GPU 租約由工作 {id} 持有。', { id: String(q.gpuHolder).slice(0, 8) }))));
    if (q && q.enabled === false) kids.push(h('div.banner.warn', icon('pause'), h('div.grow', t('佇列已暫停：新工作會排隊但不會開始。可以在「佇列」頁啟用。'))));
    this.gpuBanner.hidden = !kids.length;
    mount(this.gpuBanner, h('div.col', kids));
  }

  card(k, big) {
    const params = formState[k.kind] || (formState[k.kind] = defaults(k));
    const form = h('div.col', k.params.map((pd) => paramField(pd, params)));
    const enq = btn(t('加入佇列'), { kind: big ? 'primary' : '', icon: 'plus', onClick: () => this.enqueue(k, params, enq) });
    return h('div.panel.panel-body.col',
      h('div.row', h('div.headline.grow', k.label || k.kind), resTag(k.resource), h('span.mono.caption.muted', k.kind)),
      k.kind === 'make_cn' ? h('div.banner.warn', icon('alert'), h('div.grow', t('會從 src 重新產生整個 src_cn，覆寫 src_cn 的手動修改。'))) : null,
      k.kind === 'custom' ? h('div.caption.muted', t('在專案根目錄以 cmd /c 執行任意指令（進階）。')) : null,
      k.params.length ? form : h('div.caption.muted', t('不需要參數')),
      h('div.row', h('div.grow'), enq));
  }

  voiceCard() {
    const tw = this.kind('voiceover_tw'), cn = this.kind('voiceover_cn');
    const edge = this.kinds.find((k) => /edge/i.test(k.kind));
    if (!tw && !cn && !edge) return h('div.panel', notReady(['job_kinds: voiceover_tw', 'voiceover_cn']));
    const st = formState.__voice || (formState.__voice = { engine: 'cosy', locale: tw ? 'zh-TW' : 'zh-CN' });
    const body = h('div.col');
    const paint = () => {
      const k = st.engine === 'edge' ? edge : (st.locale === 'zh-CN' ? cn : tw);
      if (!k) { mount(body, h('div.caption.fail-text', t('後端沒有提供這個組合的配音工作。'))); return; }
      const params = formState[k.kind] || (formState[k.kind] = defaults(k));
      const enq = btn(t('加入佇列'), { kind: 'primary', icon: 'plus', onClick: () => this.enqueue(k, params, enq) });
      mount(body,
        h('div.row', h('div.headline.grow', k.label || k.kind), resTag(k.resource), h('span.mono.caption.muted', k.kind)),
        h('div.grid2', k.params.map((pd) => paramField(pd, params))),
        h('div.row', h('div.caption.muted.grow', st.engine === 'cosy' ? t('本機 CosyVoice 3：需要 GPU（約 2–3 GB VRAM），已產生的句子會自動跳過（除非勾選強制）。') : ''), enq));
    };
    const engines = seg([
      { value: 'cosy', label: t('本機 CosyVoice') },
      { value: 'edge', label: t('Edge-TTS（API）'), disabled: !edge, title: edge ? null : t('後端尚未提供 Edge-TTS 工作類型') },
    ], st.engine, (v) => { st.engine = v; paint(); }, { aria: t('配音引擎') });
    const locales = seg([
      { value: 'zh-TW', label: '繁 zh-TW', disabled: !tw }, { value: 'zh-CN', label: '简 zh-CN', disabled: !cn },
    ], st.locale, (v) => { st.locale = v; paint(); }, { aria: t('語系') });
    paint();
    return h('div.panel.panel-body.col',
      h('div.row.wrap', h('span.caption.muted', t('引擎')), engines, h('span.caption.muted', { style: { marginLeft: '16px' } }, t('語系')), locales,
        !edge ? h('span.caption.muted', t('Edge-TTS：後端尚未提供')) : null),
      h('hr.divider'), body);
  }

  async enqueue(k, params, button) {
    const clean = {};
    for (const pd of k.params) {
      const v = params[pd.name];
      if (v === '' || v == null) { if (pd.required) { toast(t('缺少必填參數：{x}', { x: pd.name }), 'warn'); return; } continue; }
      clean[pd.name] = v;
    }
    const gpu = k.resource === 'gpu';
    const ext = this.ext;
    const ok = await confirmSheet({
      title: t('加入佇列：{x}', { x: k.label || k.kind }),
      text: gpu ? t('這是 GPU 工作，會等待 GPU 租約；GPU 被其他程式佔用時會停在「等待資源」。') : t('這是 {r} 工作，佇列有空位時就會開始。', { r: k.resource.toUpperCase() }),
      detail: JSON.stringify({ kind: k.kind, params: clean }, null, 2) + (gpu && ext && ext.busy ? `\n\n⚠ ${t('GPU 目前被外部程式使用')}：${(ext.reasons || []).join('；')}` : ''),
      confirmLabel: t('加入佇列'),
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const job = await call('job_enqueue', { projectId: this.p.id, kind: k.kind, params: clean });
      toast(t('已加入佇列：{x}', { x: job.label || job.kind }), 'ok', [{ label: t('查看'), onClick: () => { sessionStorage.setItem('queue.select', job.id); this.ctx.go('queue'); } }]);
    } catch (e) { toastError(e, t('加入佇列')); }
    finally { button.disabled = false; }
  }
}

function idx(k) { const i = STEP_ORDER.indexOf(k); return i < 0 ? 99 : i; }
function resTag(r) { return tag(String(r || 'cpu').toUpperCase(), r === 'gpu' ? 'warn' : r === 'net' ? 'info' : ''); }
function defaults(k) { const o = {}; for (const p of k.params || []) if (p.default !== undefined && p.default !== null) o[p.name] = p.default; return o; }

function paramField(pd, params) {
  const type = String(pd.type || 'string').toLowerCase();
  const label = `${pd.name}${pd.required ? ' *' : ''}`;
  const help = pd.help && !/^[\w.-]+(\s*(\/|或)\s*[\w.-]+)+$/.test(pd.help.trim()) ? h('div.caption.muted', pd.help) : null;
  if (type.startsWith('bool')) {
    return h('div.field', toggle(pd.name, !!params[pd.name], (v) => { params[pd.name] = v; }), help);
  }
  if (pd.name === 'speed' || pd.name === 'rate') { // speech-rate slider 0.5–2.0 step 0.05 (UI_DESIGN §5)
    const enabled = params[pd.name] != null;
    const range = h('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: params[pd.name] ?? 1, 'aria-label': pd.name, disabled: !enabled || null });
    const val = h('span.val', enabled ? Number(params[pd.name]).toFixed(2) : t('預設'));
    range.addEventListener('input', () => { params[pd.name] = Number(range.value); val.textContent = Number(range.value).toFixed(2); });
    const tg = toggle(t('覆寫語速'), enabled, (v) => { range.disabled = !v; if (v) { params[pd.name] = Number(range.value); val.textContent = Number(range.value).toFixed(2); } else { delete params[pd.name]; val.textContent = t('預設'); } });
    return h('div.field', h('label', label), h('div.slider', range, val), tg, help);
  }
  // help like "gpu / cpu / preview" or "src 或 src_cn" lists the accepted values → select
  const fromHelp = type === 'string' && pd.help && /^[\w.-]+(\s*(\/|或)\s*[\w.-]+)+$/.test(pd.help.trim()) ? pd.help.split(/\s*(?:\/|或)\s*/).map((s) => s.trim()) : null;
  if (Array.isArray(pd.options) || Array.isArray(pd.enum) || fromHelp) {
    const opts = pd.options || pd.enum || fromHelp;
    const sel = h('select.select', { 'aria-label': pd.name }, (pd.required ? [] : [h('option', { value: '' }, '—')]).concat(opts.map((o) => h('option', { value: o, selected: params[pd.name] === o ? true : null }, o))));
    sel.addEventListener('change', () => { params[pd.name] = sel.value || undefined; });
    return h('div.field', h('label', label), sel, help);
  }
  const isNum = /^(number|int|integer|float|f64|u32|i64)$/.test(type);
  const input = h('input.input', { type: isNum ? 'number' : 'text', step: isNum ? 'any' : null, value: params[pd.name] ?? '', 'aria-label': pd.name, placeholder: pd.default != null ? String(pd.default) : '', spellcheck: 'false' });
  input.addEventListener('input', () => { const v = input.value.trim(); params[pd.name] = v === '' ? undefined : isNum ? Number(v) : v; });
  return h('div.field', h('label', label), input, help);
}
