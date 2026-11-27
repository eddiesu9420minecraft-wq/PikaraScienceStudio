// 新影片：只負責建立影片與初始設定（v0.3.2）。製作進度與控制在「製作狀態」，建立後自動前往。
// 區塊：基本資訊 → 影片內容與製作要求 → 章節與內容限制 → 敘事與擬人化角色 → 配音與動畫 → 素材 → 進階設定（預設收合）。
// 後端：auto_defaults／auto_start（hold = 稍後開始）／auto_update_config（編輯尚未開始的影片）／asset_probe／pick_files。
import { t } from '../i18n.js';
import { call, hasTauri, listen } from '../api.js';
import { h, mount, btn, seg, toggle, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, fmtBytes, basename } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject } from '../store.js';
import { pageHead } from '../v03/common.js';

const DRAFT_KEY = 'auto.draft';
const LANG = { 'zh-TW': '僅繁體中文', 'zh-CN': '僅簡體中文', both: '繁體＋簡體中文', en: '英文' };
const MODES = [
  { value: 'auto', title: '全自主', desc: 'AI 研究主題並撰寫腳本；下方的內容與要求是方向。', rec: true },
  { value: 'guided', title: '指導', desc: 'AI 必須遵循你的內容、章節與限制，Studio 會自動檢查。' },
  { value: 'script', title: '自訂腳本', desc: '你的腳本逐字成為旁白；AI 只加動畫錨點與念法。' },
];
const NARRATIVES = [
  { value: 'auto', title: '自動判斷', desc: 'AI 依主題判斷是否適合擬人化，適合時自動設計角色與對白。', rec: true },
  { value: 'personified', title: '擬人化科普', desc: '一定使用角色：技術概念變成有個性的角色，用對話與互動解釋原理。' },
  { value: 'plain', title: '一般旁白', desc: '不使用角色，由旁白直接解說。' },
];
const STYLES = [
  { value: 'ai', title: 'AI 動畫（2D＋3D）', desc: 'AI 為每一幕撰寫專屬動畫，品質與 EP01 相同。', rec: true },
  { value: 'generic', title: '通用樣板', desc: '以關鍵詞卡片呈現，製作較快，畫面較簡單。' },
];
const ASSET_KINDS = [['text', '文字'], ['pdf', 'PDF'], ['image', '圖片／截圖'], ['video', '影片素材'], ['recording', '操作錄影'], ['music', '背景音樂'], ['script', '自訂腳本'], ['reference', '參考文件']];
const AVATAR = ['var(--ice)', 'var(--amber)', 'var(--mint)', 'var(--danger-c)', 'var(--ice-deep)', 'var(--amber-deep)'];

export default {
  id: 'create', title: '新影片', icon: 'sparkle',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['auto_start'])));
    if (!p) return mount(ctx.content, h('div.page', needProject()));
    mount(ctx.content, h('div.page', loading(6)));
    let defs, claude, editing = null;
    const editId = ctx.query.get('edit');
    try {
      defs = await call('auto_defaults', { projectId: p.id });
      claude = await call('claude_detect').catch(() => null);
      if (editId) editing = await call('auto_get', { id: editId });
    } catch (e) { if (ctx.alive()) mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); return; }
    if (!ctx.alive()) return;
    if (editing && editing.status !== 'draft') { toast(t('這部影片已經開始製作，只能在「製作狀態」調整部分設定'), 'warn'); ctx.go(`status?id=${editing.id}`); return; }
    new CreateForm(ctx, p, defs, claude, editing).mount();
  },
};

class CreateForm {
  constructor(ctx, p, defs, claude, editing) {
    Object.assign(this, { ctx, p, defs, claude, editing });
    let draft = {};
    if (!editing) { try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch {} }
    this.c = { ...defs.config, ...(editing ? editing.config : draft) };
    const c = this.c;
    c.mode = c.mode || 'auto';
    c.language = c.language || (c.bilibili ? 'both' : 'zh-TW');
    c.assets = Array.isArray(c.assets) ? c.assets : [];
    c.chapters = Array.isArray(c.chapters) ? c.chapters : [];
    c.characters = Array.isArray(c.characters) ? c.characters : [];
    c.narrative = c.narrative || 'auto';
    this.voices = defs.voices || [];
  }

  save() { if (!this.editing) localStorage.setItem(DRAFT_KEY, JSON.stringify(this.c)); this.paintSummary(); }

  // ---------------------------------------------------------------- small builders
  fld(label, control, { help, opt, id } = {}) {
    return h('div.fld', { dataset: id ? { field: id } : null }, h('label.lbl', label, opt ? h('span.opt', t('選填')) : null), control, help ? h('div.help', help) : null);
  }
  text(k, ph, opts = {}) {
    const el = h(`input.input${opts.lg ? '.lg' : ''}`, { value: this.c[k] || '', placeholder: ph || '', 'aria-label': opts.aria || ph || k, maxlength: opts.max || null });
    el.addEventListener('input', () => { this.c[k] = el.value; this.save(); });
    return el;
  }
  area(k, rows, ph, aria) {
    const el = h('textarea.textarea', { rows, placeholder: ph || '', 'aria-label': aria || k });
    el.value = this.c[k] || '';
    el.addEventListener('input', () => { this.c[k] = el.value; this.save(); });
    return el;
  }
  num(k, min, max, { step = 1, ph = '', nullable = false } = {}) {
    const el = h('input.input.num', { type: 'number', min, max, step, value: this.c[k] ?? '', placeholder: ph, 'aria-label': k });
    el.addEventListener('change', () => {
      if (nullable && el.value === '') this.c[k] = null;
      else { this.c[k] = Math.max(min, Math.min(max, Number(el.value) || min)); el.value = this.c[k]; }
      this.save();
    });
    return el;
  }
  choices(list, value, onPick, aria) {
    const wrap = h('div.choices', { role: 'radiogroup', 'aria-label': aria });
    const paint = (v) => wrap.querySelectorAll('.choice').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
    for (const o of list) {
      wrap.appendChild(h('button.choice', { type: 'button', role: 'radio', dataset: { value: o.value }, 'aria-checked': String(o.value === value),
        onclick: () => { paint(o.value); onPick(o.value); } },
      h('span.ct', t(o.title), o.rec ? h('span.badge-rec', t('預設')) : null), h('span.cd', t(o.desc))));
    }
    return wrap;
  }
  section(n, title, desc, body, opts = {}) {
    return h('section.card', { id: `sec-${n}`, 'aria-labelledby': `sec-${n}-t` },
      h('div.sec-head', h('span.sec-num', String(n)), h('div.grow', h('div.t', { id: `sec-${n}-t` }, title), desc ? h('div.d', desc) : null), opts.right ? h('div.right', opts.right) : null),
      h('div.sec-body', body));
  }

  // ---------------------------------------------------------------- page
  mount() {
    const ed = this.editing;
    this.ctx.toolbar(ed ? t('編輯影片設定') : t('新影片'), ed ? `${ed.episode.toUpperCase()} · ${t('尚未開始')}` : this.p.name, []);
    this.summaryEl = h('div.card.summary');
    const banner = this.claude && this.claude.found || this.c.agent !== 'claude' ? null
      : h('div.banner.warn', icon('alert'), h('div.grow', h('div', { style: { fontWeight: 600 } }, t('找不到 Claude Code')),
        h('div.muted', t('自動製作使用你電腦上已登入的官方 Claude Code CLI。請先安裝 Claude Code，在終端機執行 claude 並登入；Studio 不會要求或保存 API Key、帳號或密碼。'))));
    mount(this.ctx.content, h('div.page.flow',
      pageHead(ed ? t('編輯影片設定') : t('新影片'), ed ? t('這部影片尚未開始製作，所有設定都可以修改。') : t('設定影片的主題與內容，按「開始製作」後到「製作狀態」追蹤進度與控制製作。')),
      banner,
      h('div.create-layout',
        h('div.create-main', this.basics(), this.content(), this.limits(), this.narrative(), this.voiceAnim(), this.assets(), this.advanced()),
        h('aside.create-side', { 'aria-label': t('摘要') }, this.summaryEl))));
    this.paintSummary();
    if (!this.dropWired) {
      this.dropWired = true;
      this.ctx.cleanup(listen('tauri://drag-drop', (e) => { const paths = (e && e.paths) || []; if (paths.length && document.body.contains(this.summaryEl)) this.addAssets(paths); }));
    }
  }

  // 1 ----------------------------------------------------------------
  basics() {
    const c = this.c;
    const topic = this.text('topic', t('例如：GPU 為什麼不能取代 CPU？'), { lg: true, aria: t('影片主題'), max: 300 });
    const scriptBox = h('div');
    const paintMode = () => {
      mount(scriptBox, c.mode === 'script' ? this.fld(t('完整腳本'), this.area('scriptText', 12, t('# 集名\n\n## 第一章\n第一句。第二句。\n\n## 第二章\n…'), t('完整腳本')),
        { help: t('Markdown：# 集名、## 章節，每段依句號切成字幕。也可以在「素材」匯入 TXT／Markdown 腳本。') }) : null);
      if (this.scriptSlot) mount(this.scriptSlot, scriptBox);
    };
    const mode = this.choices(MODES, c.mode, (v) => { c.mode = v; this.save(); paintMode(); }, t('製作模式'));
    paintMode();
    const langInfo = h('div.help');
    const ytBox = h('div');
    const paintLang = () => {
      mount(langInfo, t({
        'zh-TW': '繁體中文正式版（台灣配音）。',
        'zh-CN': '直接以簡體中文腳本、大陸用語與大陸配音製作 Bilibili 版，不會先做繁體版。',
        both: '先做繁體中文正式版，再轉成簡體中文（大陸用語、大陸配音）另外渲染 Bilibili 版。',
        en: '英文旁白、字幕與畫面文字。',
      }[c.language]));
      mount(ytBox, ['zh-TW', 'both'].includes(c.language) ? h('div.row-setting', h('div.grow', h('div.k', t('另做 YouTube 1.5× 版')), h('div.d', t('繁中版加速 1.5 倍，另外輸出影片與字幕。'))), toggle('', !!c.youtube, (v) => { c.youtube = v; this.save(); })) : null);
    };
    const lang = seg(Object.entries(LANG).map(([value, label]) => ({ value, label: t(label) })), c.language,
      (v) => { c.language = v; c.bilibili = v === 'zh-CN' || v === 'both'; this.save(); paintLang(); }, { aria: t('輸出語言') });
    paintLang();
    const minVal = h('span.val', `${c.minutes} ${t('分鐘')}`);
    const range = h('input', { type: 'range', min: '0.5', max: '20', step: '0.5', value: c.minutes, 'aria-label': t('影片長度（分鐘）') });
    range.addEventListener('input', () => { c.minutes = Number(range.value); minVal.textContent = `${c.minutes} ${t('分鐘')}`; this.save(); });
    this.scriptSlot = h('div');
    mount(this.scriptSlot, scriptBox);
    return this.section(1, t('基本資訊'), t('影片要講什麼、怎麼製作、輸出哪些語言版本。'), [
      this.fld(t('影片主題'), topic, { id: 'topic', help: t('一句話說明這部影片要回答的問題（2–300 字）。') }),
      this.fld(t('製作模式'), mode),
      this.fld(t('輸出語言'), h('div.col', { style: { gap: '8px' } }, h('div', lang), langInfo)),
      ytBox,
      this.fld(t('影片長度'), h('div.slider', range, minVal), { help: t('目標長度；實際長度由旁白決定。') }),
      h('div.row-setting', h('div.grow', h('div.k', t('Sandbox 測試')), h('div.d', t('使用 TEST 編號、成品放在 sandbox/，不合併到專案、不佔用正式集數。'))),
        toggle('', !!c.sandbox, (v) => { c.sandbox = v; this.save(); }, { title: t('Sandbox 測試') })),
    ]);
  }

  // 2 ----------------------------------------------------------------
  content() {
    const c = this.c;
    const ta = this.area('brief', 11, t('用 Markdown 寫下影片要講什麼、怎麼講，例如：\n## 重點\n- 用寄包裹比喻封包\n- 介紹 IP、DNS、TCP\n## 畫面\n- 用 3D 地球與光纖動畫\n- 使用我匯入的真實截圖'), t('影片內容與製作要求'));
    const prev = h('div.md-preview.big', { hidden: true });
    const tabs = seg([{ value: 'edit', label: t('編輯') }, { value: 'preview', label: t('預覽') }], 'edit', (v) => {
      ta.hidden = v === 'preview'; prev.hidden = v !== 'preview';
      if (v === 'preview') prev.innerHTML = mdToHtml(c.brief || '') || `<p class="muted">${t('（尚未填寫）')}</p>`;
    }, { aria: t('編輯或預覽') });
    return this.section(2, t('影片內容與製作要求'), t('支援 Markdown。這些要求會傳給研究、腳本、動畫、配音、檢查與上架資訊的每一個步驟。'),
      [h('div.col', { style: { gap: '10px' } }, ta, prev), this.scriptSlot], { right: tabs });
  }

  // 3 ----------------------------------------------------------------
  limits() {
    const c = this.c;
    const chapters = h('textarea.textarea', { rows: 5, placeholder: t('每行一個章節（依序），例如：\n什麼是封包\n路由器怎麼找路\nDNS：網路的電話簿'), 'aria-label': t('自訂章節') });
    chapters.value = (c.chapters || []).join('\n');
    chapters.addEventListener('input', () => { c.chapters = chapters.value.split('\n').map((s) => s.trim()).filter(Boolean); this.save(); });
    return this.section(3, t('章節與內容限制'), t('全部選填。指導模式與自訂腳本模式會逐項自動檢查。'), [
      h('div.fld-grid',
        this.fld(t('自訂章節'), chapters, { opt: true, help: t('每行一章，每章就是影片的一幕。') }),
        h('div.col', { style: { gap: '20px' } },
          this.fld(t('必須介紹的內容'), this.area('mustInclude', 2, t('例如：IP 位址、DNS、TCP'), t('必須介紹的內容')), { opt: true, help: t('每行一項；短關鍵詞會自動檢查。') }),
          this.fld(t('禁止出現的內容'), this.area('mustAvoid', 2, t('例如：政治議題、未經證實的數據'), t('禁止出現的內容')), { opt: true, help: t('旁白、字幕、畫面與上架文字都不會出現。') }))),
      h('div.fld-grid',
        this.fld(t('開場'), this.text('opening', t('例如：用「你按下 Enter 後的 0.1 秒」開場')), { opt: true }),
        this.fld(t('片尾'), this.text('ending', t('例如：總結三個重點，邀請訂閱')), { opt: true })),
    ]);
  }

  // 4 ----------------------------------------------------------------
  narrative() {
    const c = this.c;
    this.charsEl = h('div');
    const paint = () => this.paintChars();
    const pick = this.choices(NARRATIVES, c.narrative, (v) => { c.narrative = v; this.save(); paint(); }, t('敘事方式'));
    paint();
    return this.section(4, t('敘事與擬人化角色'), t('把技術概念變成有個性的角色（例如 CPU 是精明的大廚、GPU 是上千個幫手），用對話、表情與互動解釋原理。'), [
      pick, this.charsEl,
    ]);
  }

  paintChars() {
    const c = this.c;
    if (c.narrative === 'plain') return mount(this.charsEl);
    const add = btn(t('新增角色'), { small: true, icon: 'plus', disabled: c.characters.length >= 6, why: t('最多 6 個角色'), onClick: () => { c.characters.push({ name: '', concept: '', look: '', personality: '', voice: '', pitch: 0 }); this.save(); this.paintChars(); } });
    const hint = c.characters.length
      ? t('AI 會沿用你設定的角色外觀、性格與人聲；空白的欄位由 AI 補上。')
      : c.narrative === 'auto' ? t('不需要設定：AI 會依主題自動判斷，適合時自行設計 2–4 個角色。想指定角色時再新增。') : t('不需要設定：AI 會自行設計 2–4 個角色。想指定角色時再新增。');
    mount(this.charsEl, h('div.col', { style: { gap: '12px' } },
      h('div.row', h('div.help.grow', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, hint), add),
      c.characters.length ? h('div.chars', c.characters.map((ch, i) => this.charCard(ch, i))) : null));
  }

  charCard(ch, i) {
    const set = (k) => (e) => { ch[k] = e.target.value; this.save(); if (k === 'name') av.textContent = (ch.name || ch.concept || '?').slice(0, 2); };
    const av = h('span.avatar', { style: { background: AVATAR[i % AVATAR.length] }, 'aria-hidden': 'true' }, (ch.name || ch.concept || '?').slice(0, 2));
    const inp = (k, ph, aria) => h('input.input', { value: ch[k] || '', placeholder: ph, 'aria-label': aria, oninput: set(k) });
    const voice = h('select.select', { 'aria-label': t('人聲'), onchange: set('voice') },
      h('option', { value: '', selected: !ch.voice || null }, t('旁白人聲')),
      this.voices.map((v) => h('option', { value: v, selected: ch.voice === v || null }, v)));
    const pv = h('span.val', fmtPitch(ch.pitch));
    const pr = h('input', { type: 'range', min: '-6', max: '6', step: '1', value: ch.pitch || 0, 'aria-label': t('音高') });
    pr.addEventListener('input', () => { ch.pitch = Number(pr.value); pv.textContent = fmtPitch(ch.pitch); this.save(); });
    return h('div.char',
      h('div.top', av, inp('name', t('角色名稱，例如：CPU 大廚'), t('角色名稱')),
        btn('', { small: true, icon: 'x', kind: 'plain', aria: t('移除角色'), onClick: () => { this.c.characters.splice(i, 1); this.save(); this.paintChars(); } })),
      this.fld(t('代表的概念'), inp('concept', t('例如：CPU'), t('代表的概念'))),
      this.fld(t('外觀'), inp('look', t('例如：冰藍色方形晶片、戴廚師帽'), t('外觀'))),
      this.fld(t('性格與說話方式'), inp('personality', t('例如：精明、愛吐槽、說話簡短'), t('性格與說話方式'))),
      h('div.fld-grid',
        this.fld(t('人聲'), voice, { help: this.voices.length ? null : t('專案沒有額外的參考人聲，以音高區分角色。') }),
        this.fld(t('音高'), h('div.pitch', pr, pv))));
  }

  // 5 ----------------------------------------------------------------
  voiceAnim() {
    const c = this.c;
    const custom = !!(c.animationStyle || '').trim();
    const styleIn = this.text('animationStyle', t('例如：手繪粉筆風、像素風'), { aria: t('自訂動畫風格') });
    const styleBox = h('div.col', { style: { gap: '8px' } });
    const paintStyle = (on) => mount(styleBox,
      h('div.row.wrap', { style: { gap: '12px' } }, h('span.default-chip', h('span.sw', { 'aria-hidden': 'true' }), t('EP01 經典黑黃科技風')),
        on ? null : h('span.caption.muted', t('預設，不需要選擇'))),
      on ? styleIn : null);
    paintStyle(custom);
    const customT = toggle(t('改用自訂風格'), custom, (v) => { if (!v) { c.animationStyle = ''; styleIn.value = ''; this.save(); } paintStyle(v); });
    return this.section(5, t('配音與動畫'), t('配音的語氣與節奏、畫面的製作方式與風格。'), [
      h('div.fld-grid',
        this.fld(t('配音語氣'), this.text('voiceTone', t('例如：輕鬆、像朋友聊天')), { opt: true, help: t('影響用字與句型；音色由參考人聲決定。') }),
        this.fld(t('節奏'), this.text('pacing', t('例如：前 30 秒快節奏，之後穩定')), { opt: true })),
      this.fld(t('畫面製作方式'), this.choices(STYLES, c.style || 'ai', (v) => { c.style = v; this.save(); }, t('畫面製作方式'))),
      this.fld(t('動畫風格'), styleBox, { help: customT }),
      this.fld(t('繁中語速'), h('div.row', this.num('twCps', 2.5, 7, { step: 0.1, ph: '3.6', nullable: true }), h('span.caption.muted', t('字／秒；空白＝自然語速（約 3.6）'))), { opt: true }),
    ]);
  }

  // 6 ----------------------------------------------------------------
  assets() {
    this.assetEl = h('div');
    const pick = btn(t('選擇檔案…'), { icon: 'plus', onClick: async () => { try { const paths = await call('pick_files', { title: t('選擇要匯入的素材'), multi: true }); await this.addAssets(paths); } catch (e) { toastError(e, t('選擇檔案')); } } });
    const pathIn = h('input.input', { placeholder: t('或貼上檔案完整路徑後按 Enter'), 'aria-label': t('素材路徑') });
    pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pathIn.value.trim()) { const v = pathIn.value.trim().replace(/^"|"$/g, ''); pathIn.value = ''; this.addAssets([v]); } });
    const drop = h('div.drop', icon('image'), h('div', t('把檔案拖曳到視窗中，或')), h('div.row', pick, h('div.grow', pathIn)),
      h('div.caption', t('TXT、Markdown、PDF、圖片、影片、操作錄影、背景音樂、自訂腳本、參考文件')));
    this.paintAssets();
    return this.section(6, t('素材'), t('素材會複製到這部影片的資料夾，原檔不動。圖片與錄影直接用在畫面中（不虛構介面），文字與 PDF 作為內容依據，背景音樂取代自動配樂。'), [drop, this.assetEl]);
  }

  paintAssets() {
    const c = this.c;
    if (!this.assetEl) return;
    if (!c.assets.length) { mount(this.assetEl); return; }
    mount(this.assetEl, h('div.asset-list', c.assets.map((a, i) => {
      const sel = h('select.select', { 'aria-label': t('素材類型') }, ASSET_KINDS.map(([v, l]) => h('option', { value: v, selected: a.kind === v || null }, t(l))));
      sel.addEventListener('change', () => { a.kind = sel.value; this.save(); });
      const note = h('input.input', { value: a.note || '', placeholder: t('說明（例如：安裝畫面的真實截圖）'), 'aria-label': t('素材說明') });
      note.addEventListener('input', () => { a.note = note.value; this.save(); });
      return h('div.asset', h('span.nm', { title: a.source }, basename(a.source)), h('span.sz', fmtBytes(a.bytes || 0)), sel, note,
        btn('', { small: true, icon: 'x', kind: 'plain', aria: t('移除'), onClick: () => { c.assets.splice(i, 1); this.save(); this.paintAssets(); } }));
    })));
    this.paintSummary();
  }

  addAssets(paths) {
    this.assetChain = (this.assetChain || Promise.resolve()).then(() => this.addAssetsNow(paths));
    return this.assetChain;
  }

  async addAssetsNow(paths) {
    if (!paths || !paths.length) return;
    if (this.editing) { toast(t('編輯尚未開始的影片時不能變更素材；請刪除後重新建立'), 'warn'); return; }
    try {
      const info = await call('asset_probe', { paths });
      const c = this.c;
      for (const a of info) {
        if (!a.exists) { toast(t('找不到檔案：{p}', { p: a.source }), 'warn'); continue; }
        if (!a.kind) { toast(t('不支援的格式：{p}', { p: basename(a.source) }), 'warn'); continue; }
        if (c.assets.some((x) => x.source === a.source)) continue;
        let kind = a.kind;
        if (kind === 'text' && c.mode === 'script' && !c.assets.some((x) => x.kind === 'script')) kind = 'script';
        c.assets.push({ source: a.source, kind, note: '', bytes: a.bytes });
      }
      this.save();
      this.paintAssets();
    } catch (e) { toastError(e, t('匯入素材')); }
  }

  // 7 ----------------------------------------------------------------
  advanced() {
    const c = this.c;
    const agentBox = h('div.col', { style: { gap: '12px' } });
    const paintAgent = () => {
      const result = h('div.caption.selectable', { style: { whiteSpace: 'pre-wrap' } });
      const testBtn = btn(t('測試連線與能力'), { small: true, icon: 'check', onClick: () => this.testAgent(c.agent, testBtn, result) });
      const info = t({
        claude: '使用你電腦上已登入的官方 Claude Code CLI（預設）。',
        doubao: '使用豆包工作官方的豆包 CLI（npm install -g @bytedance/doubao-cli，再執行 doubao login）。使用你的豆包帳號，不需要 API Key。',
        external: '由外部 Agent（例如豆包工作桌面版＋Pikara Studio 技能）完成 AI 步驟：製作會停在「等待 Agent」，Agent 完成後回報，Studio 接著檢查、配音、渲染。',
      }[c.agent || 'claude']);
      const billing = seg([{ value: 'subscription', label: t('Claude 訂閱（預設）') }, { value: 'api', label: t('API 付費') }], c.billing,
        (v) => { c.billing = v; this.save(); paintAgent(); }, { aria: t('Claude 計費方式') });
      mount(agentBox, h('div.help', info),
        c.agent === 'doubao' ? this.fld(t('模型'), this.text('agentModel', 'Auto'), { opt: true, help: t('空白＝豆包 CLI 預設') }) : null,
        c.agent !== 'external' ? h('div.row', testBtn, h('span.caption.muted', t('實際讓 AI 寫一個檔案並執行一個命令（約 1 分鐘）。'))) : null, result,
        (c.agent || 'claude') === 'claude' ? this.fld(t('Claude 計費方式'), billing, { help: c.billing === 'api'
          ? t('使用你自己設定的 ANTHROPIC_API_KEY，依用量計費；必須設定每次執行的美元上限。Studio 不保存金鑰。')
          : t('使用已登入的 Claude Code，不設美元上限；達到訂閱用量上限時自動暫停並保存進度，不會改走付費 API。') }) : null,
        (c.agent || 'claude') === 'claude' && c.billing === 'api' ? this.fld(t('每次執行的美元上限'), this.num('budgetUsd', 0.5, 500, { step: 0.5, nullable: true })) : null);
    };
    const agentSeg = seg([{ value: 'claude', label: 'Claude Code' }, { value: 'doubao', label: t('豆包 CLI') }, { value: 'external', label: t('外部 Agent') }], c.agent || 'claude',
      (v) => { c.agent = v; this.save(); paintAgent(); }, { aria: t('AI 提供者') });
    paintAgent();
    const sw = (k, label, d) => h('div.row-setting', h('div.grow', h('div.k', label), d ? h('div.d', d) : null), toggle('', !!c[k], (v) => { c[k] = v; this.save(); }, { title: label }));
    const body = h('div.sec-body',
      h('div.fld-grid',
        this.fld(t('整體語氣'), this.text('tone')), this.fld(t('觀眾'), this.text('audience')),
        h('div.span2', this.fld(t('補充說明'), this.area('notes', 2, '', t('補充說明')), { opt: true }))),
      h('div.fld-grid',
        sw('thumbnail', t('封面'), t('自動產生 YouTube／Bilibili 封面')), sw('publishInfo', t('上架資訊'), t('標題、說明、章節與標籤（只寫文字檔，不上傳）')),
        sw('visualReview', t('畫面 AI 審查'), t('關鍵幀檢查文字溢出、重疊與風格')), sw('pronunciationCheck', t('發音檢查（Whisper）'), t('念錯或吞字的句子自動修正'))),
      h('div.fld-grid.three',
        this.fld(t('每個階段最多嘗試'), this.num('maxAttempts', 1, 10), { help: t('次（含第一次）') }),
        this.fld(t('總時間上限'), this.num('maxMinutes', 10, 1440), { help: t('分鐘（暫停與等待 GPU 的時間不算）') }),
        this.fld(t('AI 每次最多回合'), this.num('maxTurns', 10, 400))),
      this.fld(t('最少資料來源數'), this.num('minSources', 0, 20, { ph: c.mode === 'script' ? '0' : '3', nullable: true }), { opt: true, help: t('空白＝自訂腳本 0、其他 3') }),
      this.fld(t('AI 提供者'), agentSeg), agentBox);
    return h('details.card.adv', { id: 'sec-7' },
      h('summary', h('div.sec-head', h('span.sec-num', '7'), h('div.grow', h('div.t', t('進階設定')), h('div.d', t('語氣與觀眾、輸出項目、重試與時間上限、AI 提供者與計費。一般不需要修改。'))),
        h('div.right', icon('chevron')))),
      body);
  }

  async testAgent(provider, button, out) {
    button.disabled = true;
    mount(out, t('測試中…'));
    try {
      const r = await call('agent_check', { provider: provider || 'claude', deep: true });
      const cap = r.capability || {};
      const lines = [`${r.ok ? '✓' : '✗'} ${provider}${r.version ? '　' + r.version : ''}`,
        r.login ? `${t('登入')}：${r.login.ok ? t('已登入') : t('未登入')}` : null,
        r.capability ? `${t('寫入檔案')}：${cap.fileWritten ? '✓' : '✗'}　${t('執行命令')}：${cap.toolRan ? '✓' : '✗'}　${cap.seconds}s` : null, r.error || null].filter(Boolean);
      mount(out, h('span', { class: r.ok ? 'ok-text' : 'fail-text' }, lines.join('\n')));
    } catch (e) { mount(out, h('span.fail-text', String((e && e.message) || e))); } finally { button.disabled = false; }
  }

  // ---------------------------------------------------------------- summary + start
  problems() {
    const c = this.c;
    const p = [];
    if (!c.topic || c.topic.trim().length < 2) p.push(t('填寫影片主題'));
    if (c.mode === 'script' && !(c.scriptText || '').trim() && !(c.assets || []).some((a) => a.kind === 'script')) p.push(t('自訂腳本模式需要完整腳本'));
    if ((c.agent || 'claude') === 'claude' && c.billing === 'api' && !(c.budgetUsd > 0)) p.push(t('API 付費模式需要美元上限'));
    return p;
  }

  outputs() {
    const c = this.c;
    return ({ 'zh-TW': [t('繁中正式版'), c.youtube && t('YouTube 1.5× 版')], 'zh-CN': [t('Bilibili 簡中版')], both: [t('繁中正式版'), c.youtube && t('YouTube 1.5× 版'), t('Bilibili 簡中版')], en: [t('英文正式版')] }[c.language] || [])
      .concat([c.thumbnail && t('封面'), c.publishInfo && t('上架資訊'), t('字幕（SRT）'), t('資料來源')]).filter(Boolean);
  }

  paintSummary() {
    if (!this.summaryEl) return;
    const c = this.c;
    const probs = this.problems();
    const nar = { auto: t('自動判斷'), personified: c.characters.length ? t('擬人化（{n} 個角色）', { n: c.characters.length }) : t('擬人化'), plain: t('一般旁白') }[c.narrative];
    const startBtn = btn(this.editing ? t('儲存並開始製作') : t('開始製作'), { kind: 'primary', icon: 'play', disabled: probs.length > 0, why: probs.join('、'), onClick: () => this.submit(false, startBtn) });
    const holdBtn = btn(this.editing ? t('只儲存設定') : t('建立，稍後開始'), { disabled: probs.length > 0, why: probs.join('、'), onClick: () => this.submit(true, holdBtn) });
    mount(this.summaryEl,
      h('div.st', t('摘要')),
      h('dl',
        h('dt', t('主題')), h('dd', c.topic ? c.topic : h('span.muted', t('（尚未填寫）'))),
        h('dt', t('模式')), h('dd', t((MODES.find((m) => m.value === c.mode) || MODES[0]).title)),
        h('dt', t('語言')), h('dd', t(LANG[c.language] || c.language)),
        h('dt', t('長度')), h('dd', `${c.minutes} ${t('分鐘')}`),
        h('dt', t('敘事')), h('dd', nar),
        h('dt', t('畫面')), h('dd', c.style === 'generic' ? t('通用樣板') : `${t('AI 動畫')}・${(c.animationStyle || '').trim() || t('EP01 經典黑黃科技風')}`),
        h('dt', t('素材')), h('dd', c.assets.length ? t('{n} 個', { n: c.assets.length }) : t('無')),
        c.sandbox ? [h('dt', 'Sandbox'), h('dd', t('TEST 編號，不合併'))] : null),
      h('div.col', { style: { gap: '6px' } }, h('div.caption.muted', t('會產生')), h('div.outs', this.outputs().map((o) => h('span', icon('check'), o)))),
      probs.length ? h('div.missing-list', probs.map((x) => h('span', `• ${x}`))) : null,
      startBtn, holdBtn,
      h('div.note', t('集數自動分配，不覆蓋既有集數；所有修改在隔離的 git 工作樹進行，全部檢查通過才合併。不會自動上傳或發布。')));
  }

  async submit(hold, button) {
    const c = { ...this.c };
    const probs = this.problems();
    if (probs.length) { toast(probs.join('、'), 'warn'); return; }
    if (!hold) {
      const ok = await confirmSheet({
        title: c.sandbox ? t('開始 Sandbox 測試') : t('開始製作'),
        text: t('Studio 會依序執行所有步驟，可能需要數十分鐘到數小時，期間會使用 GPU。可以隨時在「製作狀態」暫停、繼續或取消。'),
        detail: [`${t('主題')}：${c.topic}`, `${t('輸出')}：${this.outputs().join('、')}`,
          (c.agent || 'claude') === 'claude' ? `Claude：${c.billing === 'api' ? t('API 付費，每次上限 ${x}', { x: c.budgetUsd }) : t('訂閱（已登入的 Claude Code）')}` : `${t('AI 提供者')}：${c.agent}`].join('\n'),
        confirmLabel: t('開始製作'),
      });
      if (!ok) return;
    }
    button.disabled = true;
    try {
      let prod;
      if (this.editing) {
        prod = await call('auto_update_config', { id: this.editing.id, patch: { ...c, assets: undefined } });
        if (!hold) prod = await call('auto_control', { id: this.editing.id, action: 'start' });
        toast(hold ? t('已儲存設定') : t('已開始：{ep}', { ep: prod.episode.toUpperCase() }), 'ok');
      } else {
        const cfg = { ...c, assets: (c.assets || []).map(({ source, kind, note }) => ({ source, kind, note })) };
        prod = await call('auto_start', { projectId: this.p.id, config: cfg, hold });
        toast(hold ? t('已建立 {ep}，尚未開始', { ep: prod.episode.toUpperCase() }) : t('已開始：{ep}', { ep: prod.episode.toUpperCase() }), 'ok');
        // 每部影片的內容清空；風格偏好保留
        Object.assign(this.c, { topic: '', brief: '', scriptText: '', chapters: [], mustInclude: '', mustAvoid: '', opening: '', ending: '', assets: [], characters: [] });
        localStorage.setItem(DRAFT_KEY, JSON.stringify(this.c));
      }
      this.ctx.go(`status?id=${prod.id}`);
    } catch (e) { toastError(e, hold ? t('建立影片') : t('開始製作')); button.disabled = false; }
  }
}

function fmtPitch(v) { v = Number(v) || 0; return v === 0 ? t('原音高') : `${v > 0 ? '+' : ''}${v} ${t('半音')}`; }

// Minimal, safe Markdown preview (escaped first): headings, lists, bold, inline code, paragraphs.
export function mdToHtml(src) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const raw of String(src).split(/\r?\n/)) {
    const l = raw.trim();
    const m = /^(#{1,4})\s+(.*)$/.exec(l);
    const li = /^([-*+]|\d+[.、])\s+(.*)$/.exec(l);
    if (!li && list) { out.push(`</${list}>`); list = null; }
    if (m) out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
    else if (li) { const tg = /\d/.test(li[1]) ? 'ol' : 'ul'; if (!list) { list = tg; out.push(`<${tg}>`); } out.push(`<li>${inline(li[2])}</li>`); }
    else if (l) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}
