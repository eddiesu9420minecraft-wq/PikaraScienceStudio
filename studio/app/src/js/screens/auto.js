// 0. Autonomous Production — the main screen: fill in a topic, press 開始製作, watch it run.
// Backend: auto_defaults / auto_start / auto_list / auto_events / auto_control (+ production://update, production://event).
import { t } from '../i18n.js';
import { call, hasTauri, listen } from '../api.js';
import { h, mount, btn, seg, toggle, field, tag, progress, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, fmtDur, fmtTime, fmtNum, fmtBytes, basename } from '../ui.js';
import { LiveMonitor } from './automon.js';
import { icon } from '../icons.js';
import { currentProject, on, monitorHistory } from '../store.js';

const DRAFT_KEY = 'auto.draft';
const STATUS = {
  queued: ['排隊中', 'info'], running: ['製作中', 'info'], waiting_agent: ['等待 Agent', 'warn'], paused: ['已暫停', 'warn'], paused_limit: ['額度暫停', 'warn'],
  needs_merge: ['需要手動合併', 'warn'], succeeded: ['完成', 'ok'], failed: ['失敗', 'fail'], canceled: ['已停止', 'fail'],
};

export default {
  id: 'auto', title: '自動製作', icon: 'sparkle',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['auto_start', 'auto_list']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    ctx.toolbar(t('自動製作'), p.name, []);
    mount(ctx.content, h('div.page', loading(6)));
    let defs, list, claude;
    try {
      [defs, list] = await Promise.all([call('auto_defaults'), call('auto_list', { limit: 30 })]);
      claude = await call('claude_detect').catch(() => null);
    } catch (e) { if (ctx.alive()) mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); return; }
    if (!ctx.alive()) return;
    new Auto(ctx, p, defs, list, claude).mount();
  },
};

class Auto {
  constructor(ctx, p, defs, list, claude) {
    Object.assign(this, { ctx, p, defs, claude });
    this.list = (list || []).filter((x) => !x.projectId || x.projectId === p.id);
    let draft = {};
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch {}
    this.cfg = { ...defs.config, ...draft, topic: draft.topic || '' };
    this.open = new Set(this.list.filter((x) => ['running', 'queued', 'paused', 'paused_limit'].includes(x.status)).map((x) => x.id));
    this.jobs = {};   // jobId -> last job update
    this.logs = {};   // productionId -> events[]
  }

  saveDraft() { localStorage.setItem(DRAFT_KEY, JSON.stringify(this.cfg)); }

  mount() {
    this.formEl = h('div');
    this.listEl = h('div.col');
    this.resEl = h('div');
    mount(this.ctx.content, h('div.page',
      this.claudeBanner(),
      h('section.section', h('div.section-head', h('h2.title2', t('新的製作')), h('span.caption.muted', t('填寫主題後按「開始製作」，研究、劇本、動畫、配音、字幕、渲染、檢查、封面與上架資訊都會自動完成。'))), this.formEl),
      h('section.section', h('div.section-head', h('h2.title2', t('製作紀錄')), this.resEl), this.listEl)));
    this.paintForm();
    this.paintList();
    this.paintRes();
    this.ctx.cleanup(on('production', (x) => this.onProduction(x)));
    this.ctx.cleanup(on('pevent', (e) => this.onEvent(e)));
    this.ctx.cleanup(on('job', (j) => { if (j && this.list.some((x) => x.jobId === j.id)) { this.jobs[j.id] = j; this.paintJob(j); } }));
    this.ctx.cleanup(on('monitor', () => this.paintRes()));
    for (const id of this.open) this.loadEvents(id);
  }

  claudeBanner() {
    if (this.claude && this.claude.found) return null;
    return h('div.banner.warn', icon('alert'), h('div.grow',
      h('div', { style: { fontWeight: 600 } }, t('找不到 Claude Code')),
      h('div.muted', t('自動製作使用你電腦上已登入的官方 Claude Code CLI。請先安裝 Claude Code，在終端機執行 claude 並登入你的帳號；Studio 不會要求或保存 API Key、帳號或密碼。'))));
  }

  // ---------------------------------------------------------------- form
  paintForm() {
    const c = this.cfg;
    c.mode = c.mode || 'auto';
    c.language = c.language || (c.bilibili ? 'both' : 'zh-TW');
    c.assets = Array.isArray(c.assets) ? c.assets : [];
    const set = (k) => (v) => { c[k] = v; this.saveDraft(); };
    const area = (k, rows, ph, aria) => { const el = h('textarea.textarea', { rows, placeholder: ph || '', 'aria-label': aria || ph || k }); el.value = c[k] || ''; el.addEventListener('input', () => { c[k] = el.value; this.saveDraft(); }); return el; };
    const text = (k, ph) => { const el = h('input.input', { value: c[k] || '', placeholder: ph || '' }); el.addEventListener('input', () => { c[k] = el.value; this.saveDraft(); }); return el; };
    const num = (k, min, max) => { const el = h('input.input.num', { type: 'number', min, max, value: c[k] }); el.addEventListener('change', () => { c[k] = Math.max(min, Math.min(max, Number(el.value) || min)); el.value = c[k]; this.saveDraft(); }); return el; };

    const topic = h('input.input', { value: c.topic || '', placeholder: t('例如：網際網路是如何運作的？'), 'aria-label': t('影片主題') });
    topic.addEventListener('input', () => { c.topic = topic.value; this.saveDraft(); });

    // production mode
    const modeInfo = h('div.caption.muted');
    const scriptBox = h('div');
    const paintMode = () => {
      mount(modeInfo, {
        auto: t('全自主：AI 自行研究主題並撰寫腳本；下方的內容與要求會當作方向。'),
        guided: t('指導：AI 必須遵循你提供的內容、章節、必須介紹與禁止出現的項目，Studio 會自動檢查章節名稱、禁止詞與關鍵詞，不符合時交給 AI 修正。'),
        script: t('自訂腳本：你的腳本就是旁白，逐字使用；AI 只能加動畫錨點、念法與標題，不得改寫內容（Studio 會逐字比對）。用「## 章節名稱」分章節；也可以匯入 TXT／Markdown 腳本素材。'),
      }[c.mode]);
      mount(scriptBox, c.mode === 'script' ? field(t('完整腳本（Markdown；# 集名、## 章節、每段文字會依句號切成字幕）'), area('scriptText', 12, '# 集名\n\n## 第一章\n第一句。第二句。\n\n## 第二章\n…', t('完整腳本'))) : null);
    };
    const mode = seg([
      { value: 'auto', label: t('全自主模式') },
      { value: 'guided', label: t('指導模式') },
      { value: 'script', label: t('自訂腳本模式') },
    ], c.mode, (v) => { c.mode = v; this.saveDraft(); paintMode(); }, { aria: t('製作模式') });
    paintMode();

    // brief (Markdown) with preview
    const brief = area('brief', 9, t('用 Markdown 寫下影片要講什麼、怎麼講，例如：\n## 重點\n- 用寄包裹比喻封包\n- 介紹 IP、DNS、TCP\n## 畫面\n- 用 3D 地球與光纖動畫\n- 使用我匯入的真實截圖'), t('影片內容與製作要求'));
    const briefPrev = h('div.md-preview', { hidden: true });
    const prevBtn = btn(t('預覽 Markdown'), { small: true, kind: 'plain', onClick: () => { briefPrev.hidden = !briefPrev.hidden; if (!briefPrev.hidden) briefPrev.innerHTML = mdToHtml(c.brief || ''); } });
    brief.addEventListener('input', () => { if (!briefPrev.hidden) briefPrev.innerHTML = mdToHtml(c.brief || ''); });
    const chapters = h('textarea.textarea', { rows: 4, placeholder: t('每行一個章節（依序），例如：\n什麼是封包\n路由器怎麼找路\nDNS：網路的電話簿'), 'aria-label': t('自訂章節') });
    chapters.value = (c.chapters || []).join('\n');
    chapters.addEventListener('input', () => { c.chapters = chapters.value.split('\n').map((s) => s.trim()).filter(Boolean); this.saveDraft(); });

    // output language
    const ytBox = h('span');
    const paintYt = () => mount(ytBox, ['zh-TW', 'both'].includes(c.language) ? toggle(t('另做 YouTube 1.5× 版（繁中）'), c.youtube, set('youtube')) : null);
    const lang = seg([
      { value: 'zh-TW', label: t('僅繁體中文') },
      { value: 'zh-CN', label: t('僅簡體中文') },
      { value: 'both', label: t('繁體＋簡體中文') },
      { value: 'en', label: t('英文') },
    ], c.language, (v) => { c.language = v; c.bilibili = v === 'zh-CN' || v === 'both'; this.saveDraft(); paintYt(); paintLangInfo(); }, { aria: t('輸出語言') });
    const langInfo = h('div.caption.muted');
    const paintLangInfo = () => mount(langInfo, {
      'zh-TW': t('繁中正式版（台灣配音）。'),
      'zh-CN': t('直接用簡體中文腳本、大陸用語、大陸配音製作 Bilibili 版；不會先渲染繁中版，也不做繁簡轉換。'),
      both: t('先做繁中正式版，再轉換為簡中（大陸用語、大陸配音）另外渲染 Bilibili 版。'),
      en: t('英文旁白、英文字幕與畫面文字（CosyVoice 以同一參考人聲跨語言合成，Whisper 以英文檢查發音）。'),
    }[c.language]);
    paintYt(); paintLangInfo();

    // material
    this.assetEl = h('div.col', { style: { gap: '6px' } });
    const pick = btn(t('選擇檔案…'), { small: true, icon: 'plus', onClick: async () => { try { const paths = await call('pick_files', { title: t('選擇要匯入的素材'), multi: true }); await this.addAssets(paths); } catch (e) { toastError(e, t('選擇檔案')); } } });
    const pathIn = h('input.input', { placeholder: t('或貼上檔案完整路徑後按 Enter；也可以把檔案拖曳到視窗中') });
    pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pathIn.value.trim()) { const v = pathIn.value.trim().replace(/^"|"$/g, ''); pathIn.value = ''; this.addAssets([v]); } });
    this.paintAssets();

    const lead = h('div.panel.panel-body.col',
      field(t('影片主題'), topic),
      field(t('製作模式'), mode, modeInfo),
      h('div.field', h('div.row', h('label.grow', t('影片內容與製作要求（支援 Markdown）')), prevBtn), brief, briefPrev),
      scriptBox,
      h('div.grid2', field(t('自訂影片章節（選填）'), chapters),
        h('div.col', { style: { gap: '8px' } }, field(t('必須介紹的內容（每行一項；短關鍵詞會自動檢查）'), area('mustInclude', 2, t('例如：IP 位址、DNS、TCP'))), field(t('禁止出現的內容（每行一項；會自動檢查）'), area('mustAvoid', 2, t('例如：政治議題、未經證實的數據'))))),
      h('div.grid2', field(t('開場'), text('opening', t('例如：用「你按下 Enter 後的 0.1 秒」開場'))), field(t('片尾'), text('ending', t('例如：總結三個重點，邀請訂閱')))),
      h('div.grid3', field(t('配音語氣'), text('voiceTone', t('例如：輕鬆、像朋友聊天'))), field(t('動畫風格（選填）'), text('animationStyle', t('留空＝以 EP01 為標準（2D 圖解＋3D 場景）'))), field(t('節奏'), text('pacing', t('例如：前 30 秒快節奏，之後穩定')))),
      h('div.field', h('label', t('素材（TXT、Markdown、PDF、圖片、影片、操作錄影、背景音樂、自訂腳本、參考文件）')), h('div.row', pick, h('div.grow', pathIn)), this.assetEl,
        h('div.caption.muted', t('素材會複製到這部影片的資料夾（projects/EPxx/assets），原檔不動。AI 會讀取素材清單：圖片與錄影會直接用在畫面中（不虛構介面），文字與 PDF 作為內容依據，背景音樂會取代自動配樂。'))),
      h('div.grid2', { style: { alignItems: 'end' } },
        field(t('影片長度（分鐘，實際長度由旁白決定）'), (() => { const v = h('span.val', `${c.minutes}`); const r = h('input', { type: 'range', min: '0.5', max: '20', step: '0.5', value: c.minutes, 'aria-label': t('影片長度（分鐘）') }); r.addEventListener('input', () => { c.minutes = Number(r.value); v.textContent = `${c.minutes}`; this.saveDraft(); }); return h('div.slider', r, v); })()),
        field(t('畫面風格'), seg([{ value: 'ai', label: t('AI 動畫（2D＋3D）') }, { value: 'generic', label: t('通用樣板（較快）') }], c.style, set('style'), { aria: t('畫面風格') }))),
      field(t('輸出語言'), lang, h('div.row.wrap', { style: { gap: '16px', marginTop: '4px' } }, langInfo, ytBox)),
      toggle(t('Sandbox 測試（使用 TEST 編號，成品放在 sandbox/，不合併到專案、不佔用正式集數）'), !!c.sandbox, set('sandbox')));

    const budgetBox = h('div');
    const paintBudget = () => mount(budgetBox, c.billing === 'api'
      ? h('div.col', { style: { gap: '6px' } },
        field(t('每次 Claude 執行的美元上限（必填）'), (() => { const el = h('input.input.num', { type: 'number', min: '0.5', max: '500', step: '0.5', value: c.budgetUsd ?? '' }); el.addEventListener('change', () => { c.budgetUsd = el.value === '' ? null : Number(el.value); this.saveDraft(); }); return el; })()),
        h('div.caption.muted', t('API 付費模式使用你自己設定在系統環境變數的 ANTHROPIC_API_KEY，依用量向你的 Anthropic 帳戶計費。Studio 不保存金鑰。')))
      : h('div.caption.muted', t('訂閱模式（預設）：使用已登入的 Claude Code，不設美元上限；Studio 會移除子程序的 API Key 環境變數，確保不會改走付費 API。達到訂閱用量上限時自動暫停並保存進度，不會切換到付費用量。')));
    paintBudget();
    const billing = seg([
      { value: 'subscription', label: t('Claude 訂閱（預設）') },
      { value: 'api', label: t('API 付費') },
    ], c.billing, (v) => { c.billing = v; this.saveDraft(); paintBudget(); }, { aria: t('Claude 計費方式') });

    const agentBox = h('div');
    const paintAgent = () => {
      const testBtn = btn(t('測試連線與能力'), { small: true, icon: 'check', onClick: () => this.testAgent(c.agent, testBtn, result) });
      const result = h('div.caption.selectable', { style: { whiteSpace: 'pre-wrap' } });
      const info = {
        claude: t('使用你電腦上已登入的官方 Claude Code CLI（預設）。'),
        doubao: t('使用豆包工作官方的豆包 CLI：npm install -g @bytedance/doubao-cli，再執行 doubao login 用豆包或飛書手機版掃碼。使用你的豆包帳號，不需要 API Key；Studio 不保存任何帳號資訊，也不影響 Claude 的登入。'),
        external: t('由外部 Agent（例如豆包工作桌面版＋Pikara Studio 技能）完成研究、劇本與修正：每到 AI 步驟，製作會停在「等待 Agent」，並在工作樹寫入任務說明；Agent 完成後以 Studio 命令列 agent-done 回報，Studio 接著做檢查、配音、渲染與 QA。'),
      }[c.agent];
      mount(agentBox, h('div.col', { style: { gap: '6px' } }, h('div.caption.muted', info),
        c.agent === 'doubao' ? field(t('模型（空白 = 豆包 CLI 預設 Auto）'), text('agentModel', 'Auto')) : null,
        c.agent !== 'external' ? h('div.row', testBtn, h('span.caption.muted', t('會實際讓 AI 在暫存資料夾寫一個檔案並執行一個命令，確認能讀寫程式碼與調用工具（約 1 分鐘）。'))) : null,
        result));
      const claudeOnly = this.formEl.querySelector('[data-claude-only]');
      if (claudeOnly) claudeOnly.hidden = c.agent !== 'claude';
    };
    const agentSeg = seg([
      { value: 'claude', label: 'Claude Code' },
      { value: 'doubao', label: t('豆包 CLI') },
      { value: 'external', label: t('外部 Agent（豆包工作）') },
    ], c.agent || 'claude', (v) => { c.agent = v; this.saveDraft(); paintAgent(); }, { aria: t('AI 提供者') });
    setTimeout(paintAgent, 0);
    const more = h('details.panel', { style: { padding: '0' } },
      h('summary.panel-body', { style: { cursor: 'default' } }, h('span.headline', t('更多選項')), h('span.caption.muted', { style: { marginLeft: '12px' } }, t('語氣、觀眾、資料來源、檢查項目、重試與時間上限、AI 提供者、Claude 計費'))),
      h('div.panel-body.col', { style: { paddingTop: 0 } },
        h('div.grid2', field(t('整體語氣'), text('tone')), field(t('觀眾'), text('audience'))),
        field(t('補充說明'), area('notes', 2)),
        h('div.grid2', field(t('最少資料來源數（空白 = 自訂腳本 0、其他 3）'), (() => { const el = h('input.input.num', { type: 'number', min: '0', max: '20', value: c.minSources ?? '', placeholder: c.mode === 'script' ? '0' : '3' }); el.addEventListener('change', () => { c.minSources = el.value === '' ? null : Math.max(0, Math.min(20, Number(el.value))); this.saveDraft(); }); return el; })()),
          field(t('繁中語速（字／秒；空白 = 自然語速約 3.6）'), (() => { const el = h('input.input.num', { type: 'number', min: '2.5', max: '7', step: '0.1', value: c.twCps ?? '', placeholder: '3.6' }); el.addEventListener('change', () => { c.twCps = el.value === '' ? null : Math.max(2.5, Math.min(7, Number(el.value))); el.value = c.twCps ?? ''; this.saveDraft(); }); return el; })())),
        h('div.row.wrap', { style: { gap: '20px' } },
          toggle(t('封面'), c.thumbnail, set('thumbnail')), toggle(t('上架資訊'), c.publishInfo, set('publishInfo')),
          toggle(t('畫面 AI 審查'), c.visualReview, set('visualReview')), toggle(t('發音檢查（Whisper）'), c.pronunciationCheck, set('pronunciationCheck'))),
        h('div.caption.muted', t('簡中使用大陸配音員的自然語速（約每秒 3.4 字）；語速倍率限制在 0.85–1.15，避免變速造成卡頓與吞字。音色由專案的參考人聲決定（tools/CosyVoice/reference），「配音語氣」影響用字與句型，不會改變音色。')),
        h('div.grid3', field(t('每個階段最多嘗試'), num('maxAttempts', 1, 10)), field(t('總時間上限（分鐘）'), num('maxMinutes', 10, 1440)), field(t('Claude 每次最多回合'), num('maxTurns', 10, 400))),
        field(t('AI 提供者'), agentSeg), agentBox,
        h('div', { hidden: c.agent !== 'claude' || null, dataset: { claudeOnly: '1' } }, field(t('Claude 計費方式'), billing), budgetBox)));

    const start = btn(t('開始製作'), { kind: 'primary', icon: 'play', onClick: () => this.start(start) });
    mount(this.formEl, h('div.col', { style: { gap: '12px' } }, lead, more,
      h('div.row', h('div.caption.muted.grow', t('集數自動分配（不覆蓋既有集數）；所有修改在隔離的 git 工作樹進行，全部檢查通過才合併。製作要求與素材會存進任務資料庫，傳給研究、腳本、動畫、配音、QA、修正與上架資訊每一個步驟。不會自動上傳或發布。')), start)));
    if (!this.dropWired) {
      this.dropWired = true;
      this.ctx.cleanup(listen('tauri://drag-drop', (e) => { const paths = (e && e.paths) || []; if (paths.length && document.body.contains(this.formEl)) this.addAssets(paths); }));
    }
  }

  addAssets(paths) {
    // one import at a time (Enter pressed twice quickly, or a drop while a probe is running)
    this.assetChain = (this.assetChain || Promise.resolve()).then(() => this.addAssetsNow(paths));
    return this.assetChain;
  }

  async addAssetsNow(paths) {
    if (!paths || !paths.length) return;
    try {
      const info = await call('asset_probe', { paths });
      const c = this.cfg;
      for (const a of info) {
        if (!a.exists) { toast(t('找不到檔案：{p}', { p: a.source }), 'warn'); continue; }
        if (!a.kind) { toast(t('不支援的格式：{p}', { p: basename(a.source) }), 'warn'); continue; }
        if (c.assets.some((x) => x.source === a.source)) continue;
        let kind = a.kind;
        if (kind === 'text' && c.mode === 'script' && !c.assets.some((x) => x.kind === 'script')) kind = 'script';
        c.assets.push({ source: a.source, kind, note: '', bytes: a.bytes });
      }
      this.saveDraft();
      this.paintAssets();
    } catch (e) { toastError(e, t('匯入素材')); }
  }

  paintAssets() {
    const c = this.cfg;
    if (!this.assetEl) return;
    if (!c.assets.length) { mount(this.assetEl, h('div.caption.muted', t('尚未加入素材'))); return; }
    const kinds = [['text', '文字'], ['pdf', 'PDF'], ['image', '圖片／截圖'], ['video', '影片素材'], ['recording', '操作錄影'], ['music', '背景音樂'], ['script', '自訂腳本'], ['reference', '參考文件']];
    mount(this.assetEl, c.assets.map((a, i) => {
      const sel = h('select.input', { style: { width: '140px' } }, kinds.map(([v, l]) => h('option', { value: v, selected: a.kind === v || null }, t(l))));
      sel.addEventListener('change', () => { a.kind = sel.value; this.saveDraft(); });
      const note = h('input.input', { value: a.note || '', placeholder: t('說明（例如：Studio 安裝畫面的真實截圖）') });
      note.addEventListener('input', () => { a.note = note.value; this.saveDraft(); });
      return h('div.row', { style: { gap: '8px' } }, h('span.caption.mono.ellipsis', { title: a.source, style: { width: '30%' } }, basename(a.source)), h('span.caption.muted', fmtBytes(a.bytes || 0)), sel, h('div.grow', note),
        btn('', { small: true, icon: 'x', kind: 'plain', title: t('移除'), onClick: () => { c.assets.splice(i, 1); this.saveDraft(); this.paintAssets(); } }));
    }));
  }

  async testAgent(provider, button, out) {
    button.disabled = true;
    mount(out, t('測試中…'));
    try {
      const r = await call('agent_check', { provider, deep: true });
      const cap = r.capability || {};
      const lines = [
        `${r.ok ? '✓' : '✗'} ${provider}${r.version ? '　' + r.version : ''}`,
        r.login ? `${t('登入')}：${r.login.ok ? t('已登入') : t('未登入')}` : null,
        r.capability ? `${t('寫入檔案')}：${cap.fileWritten ? '✓' : '✗'}　${t('執行命令')}：${cap.toolRan ? '✓' : '✗'}　${cap.seconds}s` : null,
        r.error || null,
      ].filter(Boolean);
      mount(out, h('span', { class: r.ok ? 'ok-text' : 'fail-text' }, lines.join('\n')));
    } catch (e) { mount(out, h('span.fail-text', String(e && e.message || e))); }
    finally { button.disabled = false; }
  }

  async start(button) {
    const c = { ...this.cfg };
    if (!c.topic || c.topic.trim().length < 2) { toast(t('請輸入影片主題'), 'warn'); return; }
    if (c.billing === 'api' && !(c.budgetUsd > 0)) { toast(t('API 付費模式必須設定美元上限'), 'warn'); return; }
    if (c.mode === 'script' && !(c.scriptText || '').trim() && !(c.assets || []).some((a) => a.kind === 'script')) { toast(t('自訂腳本模式需要完整腳本（貼上，或匯入自訂腳本素材）'), 'warn'); return; }
    const LANG = { 'zh-TW': t('僅繁體中文'), 'zh-CN': t('僅簡體中文'), both: t('繁體＋簡體中文'), en: t('英文') };
    const MODE = { auto: t('全自主模式'), guided: t('指導模式'), script: t('自訂腳本模式') };
    const outs = { 'zh-TW': [t('繁中正式版'), c.youtube && 'YouTube 1.5×'], 'zh-CN': [t('Bilibili 簡中版（直接製作，不渲染繁中）')], both: [t('繁中正式版'), c.youtube && 'YouTube 1.5×', 'Bilibili zh-CN'], en: [t('英文正式版')] }[c.language] || [];
    const ok = await confirmSheet({
      title: c.sandbox ? t('開始 Sandbox 測試') : t('開始自動製作'),
      text: t('Studio 會依序執行所有階段，可能需要數十分鐘到數小時，期間會使用 GPU。你可以隨時暫停或停止。'),
      detail: [
        `${t('主題')}：${c.topic}`, `${t('模式')}：${MODE[c.mode] || c.mode}`, `${t('輸出語言')}：${LANG[c.language] || c.language}`,
        `${t('長度')}：${c.minutes} ${t('分鐘')}`, `${t('畫面')}：${c.style === 'ai' ? t('AI 動畫') : t('通用樣板')}`,
        `${t('輸出')}：${outs.filter(Boolean).join('、')}`,
        (c.chapters || []).length ? `${t('章節')}：${c.chapters.join('、')}` : null,
        (c.assets || []).length ? `${t('素材')}：${c.assets.length} ${t('個')}` : null,
        c.sandbox ? t('Sandbox：TEST 編號、放在 sandbox/、不合併到專案') : null,
        c.agent === 'claude' ? `Claude：${c.billing === 'api' ? t('API 付費，每次上限 ${x}', { x: c.budgetUsd }) : t('訂閱（已登入的 Claude Code，不設美元上限）')}` : `${t('AI 提供者')}：${c.agent === 'doubao' ? t('豆包 CLI') : t('外部 Agent（豆包工作）')}`,
      ].filter(Boolean).join('\n'),
      confirmLabel: t('開始製作'),
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const cfg = { ...c, assets: (c.assets || []).map(({ source, kind, note }) => ({ source, kind, note })) };
      const prod = await call('auto_start', { projectId: this.p.id, config: cfg });
      toast(t('已開始：{ep}', { ep: prod.episode.toUpperCase() }), 'ok');
      // per-video content is cleared; style preferences stay
      Object.assign(this.cfg, { topic: '', brief: '', scriptText: '', chapters: [], mustInclude: '', mustAvoid: '', opening: '', ending: '', assets: [] });
      this.saveDraft(); this.paintForm();
      this.list.unshift(prod); this.open.add(prod.id); this.paintList();
    } catch (e) { toastError(e, t('開始製作')); }
    finally { button.disabled = false; }
  }

  // ---------------------------------------------------------------- list
  paintList() {
    if (!this.list.length) { mount(this.listEl, h('div.panel', h('div.empty', icon('sparkle'), h('div.headline', t('還沒有自動製作')), h('div.callout', t('在上方輸入主題並按「開始製作」。'))))); return; }
    this.cards = {};
    mount(this.listEl, this.list.map((x) => (this.cards[x.id] = this.card(x))));
  }

  card(x) {
    const [label, kind] = STATUS[x.status] || [x.status, ''];
    const el = h('div.panel', { dataset: { id: x.id } });
    const head = h('div.panel-head', { style: { cursor: 'default' } },
      h('span.tag.info', { style: { fontWeight: 700 } }, x.episode.toUpperCase()),
      h('div.grow.col', { style: { gap: '2px' } }, h('div.headline.ellipsis', x.config.topic), h('div.caption.muted', `${fmtTime(x.createdAt)}・${t('已執行 {d}', { d: fmtDur(x.activeMs / 1000) })}・Claude ${x.claudeRuns} ${t('次')}`)),
      tag(t(label), kind),
      this.actions(x));
    head.addEventListener('click', (e) => { if (e.target.closest('button')) return; this.open.has(x.id) ? this.open.delete(x.id) : this.open.add(x.id); this.repaint(x); if (this.open.has(x.id)) this.loadEvents(x.id); });
    const body = h('div.panel-body.col');
    if (this.open.has(x.id)) mount(body, this.detail(x));
    else mount(body, this.stageStrip(x));
    mount(el, head, body);
    return el;
  }

  actions(x) {
    const act = (a, label, opts = {}) => btn(t(label), { small: true, ...opts, onClick: () => this.control(x, a) });
    const b = [];
    if (['queued', 'running', 'waiting_agent'].includes(x.status)) b.push(act('pause', '暫停', { icon: 'pause' }));
    if (x.status === 'waiting_agent') b.push(btn(t('Agent 已完成'), { small: true, kind: 'primary', icon: 'check', onClick: () => this.agentDone(x) }));
    if (['paused', 'paused_limit', 'failed', 'needs_merge'].includes(x.status)) b.push(act('resume', x.status === 'failed' ? '重試這個階段' : '繼續', { icon: 'play', kind: 'primary' }));
    if (['queued', 'running', 'waiting_agent', 'paused', 'paused_limit', 'needs_merge'].includes(x.status)) b.push(act('stop', '停止', { icon: 'stop', kind: 'destructive' }));
    if (['failed', 'canceled'].includes(x.status) && x.worktree) b.push(act('discard', '捨棄（回復）', { icon: 'trash', kind: 'destructive' }));
    if (['succeeded', 'failed', 'canceled'].includes(x.status) && !x.worktree) b.push(act('remove', '移除紀錄', { icon: 'x' }));
    return h('div.row.gap2', b);
  }

  async agentDone(x) {
    const ok = await confirmSheet({ title: t('Agent 已完成這一步？'), text: t('Studio 會接著檢查 Agent 的成果（旁白驗證、資料來源、TypeScript 等），沒通過時會產生修正任務。'), confirmLabel: t('繼續製作') });
    if (!ok) return;
    try { this.onProduction(await call('agent_done', { id: x.id })); } catch (e) { toastError(e, t('操作失敗')); }
  }

  async control(x, action) {
    if (action === 'stop' && !(await confirmSheet({ title: t('停止製作'), text: t('正在執行的工作會被取消。專案本身不會有任何改變，工作樹會保留供檢視或捨棄。'), confirmLabel: t('停止'), destructive: true }))) return;
    if (action === 'discard' && !(await confirmSheet({ title: t('捨棄這次製作'), text: t('刪除隔離工作樹與分支（包含這次產生但尚未合併的旁白、程式與中間檔）。專案本身不受影響。'), confirmLabel: t('捨棄'), destructive: true }))) return;
    try {
      const r = await call('auto_control', { id: x.id, action });
      if (r && r.removed) { this.list = this.list.filter((y) => y.id !== x.id); this.paintList(); return; }
      this.onProduction(r);
    } catch (e) { toastError(e, t('操作失敗')); }
  }

  stageStrip(x) {
    return h('div.auto-stages', x.stages.filter((s) => s.status !== 'skipped').map((s) => {
      const cur = s.id === x.stage && ['running', 'queued'].includes(x.status);
      return h('div', { class: `auto-stage ${s.status}${cur ? ' current' : ''}`, title: `${s.label}${s.attempts > 1 ? `（${t('第 {n} 次', { n: s.attempts })}）` : ''}${s.note ? '\n' + s.note : ''}` },
        h('span.auto-dot'), h('span.caption', s.label.replace(/（.*）/, '')));
    }));
  }

  detail(x) {
    const job = x.jobId && this.jobs[x.jobId];
    const cur = x.stages.find((s) => s.id === x.stage);
    const msgKind = x.status === 'failed' || x.status === 'canceled' ? 'fail' : ['paused_limit', 'needs_merge', 'paused'].includes(x.status) ? 'warn' : 'ok';
    const out = (x.outputs || []);
    return [
      this.stageStrip(x),
      x.message ? h(`div.banner.${msgKind}`, icon(msgKind === 'ok' ? 'check' : 'alert'), h('div.grow.selectable', { style: { whiteSpace: 'pre-wrap' } }, x.message)) : null,
      ['running', 'queued'].includes(x.status) ? h('div.col', { style: { gap: '6px' }, dataset: { job: x.jobId || '' } },
        h('div.row', h('span.headline.grow', `${cur ? cur.label : x.stage}${x.attempt > 1 ? `・${t('第 {n} 次', { n: x.attempt })}` : ''}${x.mode === 'fix' ? `・${t('Claude 修正中')}` : ''}`), h('span.caption.muted.job-text', job ? (job.progressText || job.label) : '')),
        progress(job && job.status === 'running' ? job.progress : null)) : null,
      x.warnings && x.warnings.length ? h('div.banner.warn', icon('alert'), h('div.grow', h('div', { style: { fontWeight: 600 } }, t('{n} 項警告', { n: x.warnings.length })), x.warnings.map((w) => h('div.caption', w)))) : null,
      requirementsView(x.data && x.data.requirements),
      out.length ? h('div.col', { style: { gap: '6px' } }, h('span.headline', t('成品（在專案資料夾）')),
        h('div.row.wrap', out.map((f) => btn(f, { small: true, icon: /\.mp4$/.test(f) ? 'play' : 'external', onClick: () => call('open_path', { projectId: this.p.id, path: f, reveal: false }).catch((e) => toastError(e, t('開啟'))) }))),
        h('div.caption.muted', t('發布請自行到各平台手動上傳；上架文字在 {f}。', { f: `${x.episode.toUpperCase()}_PUBLISH_METADATA.md` }))) : null,
      this.monitorFor(x).el,
      h('dl.kv',
        h('dt', t('集數')), h('dd', x.episode.toUpperCase()),
        h('dt', t('模式')), h('dd', `${{ auto: t('全自主'), guided: t('指導'), script: t('自訂腳本') }[x.config.mode] || t('全自主')}・${{ 'zh-TW': t('僅繁中'), 'zh-CN': t('僅簡中'), both: t('繁＋簡'), en: t('英文') }[x.config.language] || (x.config.bilibili ? t('繁＋簡') : t('僅繁中'))}${x.config.sandbox ? '・Sandbox' : ''}${(x.config.assets || []).length ? `・${t('素材 {n} 個', { n: x.config.assets.length })}` : ''}`),
        h('dt', t('工作樹')), h('dd.mono', x.worktree ? `.studio/worktrees/${x.worktree}（${x.branch}）` : t('已清除')),
        h('dt', t('已執行')), h('dd', `${fmtDur(x.activeMs / 1000)}（${t('上限 {m} 分鐘', { m: x.config.maxMinutes })}）`),
        h('dt', 'Claude'), h('dd', `${x.claudeRuns} ${t('次')}・${x.config.billing === 'api' ? t('API 付費（每次上限 ${b}）', { b: x.config.budgetUsd }) : t('訂閱')}・${t('模型等價估算 ${c}', { c: fmtNum(x.claudeCostUsd, 2) })}`),
        h('dt', ''), h('dd.caption.muted', x.config.billing === 'api' ? t('API 模式下估算值接近實際計費，以 Anthropic Console 為準。') : t('訂閱模式不依此金額扣款；這只是 Claude Code 回報的等價模型成本，用來了解用量。'))),
      h('div.col', { style: { gap: '6px' } }, h('div.row', h('span.headline.grow', t('活動紀錄')), btn(t('前往佇列'), { small: true, icon: 'queue', onClick: () => { if (x.jobId) sessionStorage.setItem('queue.select', x.jobId); this.ctx.go('queue'); } })),
        h('div.auto-log.mono.selectable', { dataset: { log: x.id } }, (this.logs[x.id] || []).slice(-300).map((e) => logLine(e)))),
    ];
  }

  monitorFor(x) {
    this.monitors = this.monitors || {};
    let m = this.monitors[x.id];
    if (!m) { m = this.monitors[x.id] = new LiveMonitor(x, this.p.id); m.refresh(); m.timer = null; }
    m.update(x);
    if (!m.timer) {
      const active = () => ['running', 'queued', 'waiting_agent', 'paused', 'paused_limit'].includes(m.prod.status);
      m.timer = setInterval(() => { if (!document.body.contains(m.el)) { clearInterval(m.timer); m.timer = null; return; } if (active() || m.tab === 'video') m.refresh(); }, 2000);
    }
    return m;
  }

  repaint(x) {
    const old = this.cards && this.cards[x.id];
    const n = this.card(x);
    if (old && old.parentNode) old.replaceWith(n); else this.paintList();
    this.cards[x.id] = n;
    const log = n.querySelector('.auto-log'); if (log) log.scrollTop = log.scrollHeight;
  }

  onProduction(x) {
    if (!x || (x.projectId && x.projectId !== this.p.id)) return;
    const i = this.list.findIndex((y) => y.id === x.id);
    const prev = i >= 0 ? this.list[i] : null;
    if (i >= 0) this.list[i] = x; else { this.list.unshift(x); this.open.add(x.id); }
    if (prev && prev.status !== x.status && ['succeeded', 'failed', 'paused_limit', 'needs_merge'].includes(x.status)) {
      toast(`${x.episode.toUpperCase()}：${t((STATUS[x.status] || [x.status])[0])}`, x.status === 'succeeded' ? 'ok' : x.status === 'failed' ? 'fail' : 'warn');
    }
    if (i < 0) this.paintList(); else this.repaint(x);
  }

  onEvent(e) {
    if (!e || !e.id) return;
    const arr = this.logs[e.id] || (this.logs[e.id] = []);
    arr.push({ ts: Date.now(), level: e.level, stage: e.stage, line: e.line });
    const box = this.listEl.querySelector(`.auto-log[data-log="${e.id}"]`);
    if (box) { box.appendChild(logLine(arr[arr.length - 1])); box.scrollTop = box.scrollHeight; }
  }

  paintJob(j) {
    const box = this.listEl.querySelector(`[data-job="${j.id}"]`);
    if (!box) return;
    const txt = box.querySelector('.job-text'); if (txt) txt.textContent = j.progressText || j.label;
    const bar = box.querySelector('.progress');
    if (bar) bar.replaceWith(progress(j.status === 'running' ? j.progress : null));
  }

  async loadEvents(id) {
    try {
      const ev = await call('auto_events', { id, afterId: 0, limit: 2000 });
      this.logs[id] = ev;
      const x = this.list.find((y) => y.id === id); if (x) this.repaint(x);
    } catch {}
  }

  paintRes() {
    const s = monitorHistory[monitorHistory.length - 1];
    if (!s || !s.gpu) { mount(this.resEl); return; }
    const g = s.gpu;
    mount(this.resEl, h('div.row.caption.muted', { style: { gap: '14px' } },
      h('span', `GPU ${fmtNum(g.util, 0, '%')}`), h('span', `VRAM ${fmtNum(g.vramUsedMiB, 0)} / ${fmtNum(g.vramTotalMiB, 0)} MiB`),
      h('span', `${fmtNum(g.tempC, 0, '°C')}`), h('span', `CPU ${fmtNum(s.cpu && s.cpu.usage, 0, '%')}`),
      btn(t('監控'), { small: true, kind: 'plain', icon: 'gauge', onClick: () => this.ctx.go('monitor') })));
  }
}

function logLine(e) {
  const d = new Date(e.ts);
  const p = (n) => String(n).padStart(2, '0');
  return h('div', { class: `auto-log-line ${e.level}` }, h('span.muted', `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `), e.line);
}

// Minimal, safe Markdown preview (escaped first): headings, lists, bold, inline code, paragraphs.
function mdToHtml(src) {
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
    else if (li) { const tag = /\d/.test(li[1]) ? 'ol' : 'ul'; if (!list) { list = tag; out.push(`<${tag}>`); } out.push(`<li>${inline(li[2])}</li>`); }
    else if (l) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

// 製作要求檢查（資料研究與劇本階段）：每一項的狀態、預期與實際內容、原因。資料來自後端的結構化報告
// （content::requirements_report，已比對繁簡字、兩岸用語、同義詞、大小寫與標點）。
const REQ_STATUS = { pass: ['通過', 'ok'], warn: ['警告', 'warn'], fail: ['失敗', 'fail'] };
function requirementsView(r) {
  if (!r || !Array.isArray(r.items) || !r.items.length) return null;
  const order = { fail: 0, warn: 1, pass: 2 };
  const items = [...r.items].sort((a, b) => order[a.status] - order[b.status]);
  const shown = items.filter((i) => i.status !== 'pass');
  const passed = items.filter((i) => i.status === 'pass');
  const row = (i) => h('div.check-row', { dataset: { req: i.key } },
    h('span', { class: `dot ${REQ_STATUS[i.status][1]}` }),
    h('div', h('div.name', `${t(i.requirement)}`),
      h('div.detail', `${t('預期')}：${i.expected}`),
      h('div.detail', `${t('實際')}：${i.actual == null ? t('（沒有找到）') : i.actual}`),
      h('div.detail', `${t('原因')}：${t(i.reason)}`)),
    tag(t(REQ_STATUS[i.status][0]), REQ_STATUS[i.status][1]));
  return h('details.panel', { open: r.failed > 0 || r.warned > 0 ? true : null },
    h('summary.panel-head', h('span.headline.grow', t('製作要求檢查')),
      tag(`${t('通過')} ${r.passed}`, 'ok'), r.warned ? tag(`${t('警告')} ${r.warned}`, 'warn') : null, r.failed ? tag(`${t('失敗')} ${r.failed}`, 'fail') : null),
    h('div', shown.map(row),
      passed.length ? h('details', h('summary.caption.muted', { style: { padding: '8px 16px' } }, t('{n} 項已通過（點開查看比對方式）', { n: passed.length })), passed.map(row)) : null,
      (r.notes || []).length ? h('div.caption.muted', { style: { padding: '8px 16px' } }, r.notes.join('；')) : null));
}
