// 0. Autonomous Production — the main screen: fill in a topic, press 開始製作, watch it run.
// Backend: auto_defaults / auto_start / auto_list / auto_events / auto_control (+ production://update, production://event).
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, seg, toggle, field, tag, progress, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, fmtDur, fmtTime, fmtNum } from '../ui.js';
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
    const set = (k) => (v) => { c[k] = v; this.saveDraft(); };
    const topic = h('textarea.textarea', { rows: 3, placeholder: t('例如：為什麼手機充電會發熱？鋰電池裡發生了什麼事'), 'aria-label': t('主題') });
    topic.value = c.topic || '';
    topic.addEventListener('input', () => { c.topic = topic.value; this.saveDraft(); });

    const minVal = h('span.val', `${c.minutes}`);
    const minutes = h('input', { type: 'range', min: '0.5', max: '20', step: '0.5', value: c.minutes, 'aria-label': t('影片長度（分鐘）') });
    minutes.addEventListener('input', () => { c.minutes = Number(minutes.value); minVal.textContent = `${c.minutes}`; this.saveDraft(); });

    const style = seg([
      { value: 'ai', label: t('AI 動畫（Claude 撰寫畫面）') },
      { value: 'generic', label: t('通用樣板（較快）') },
    ], c.style, set('style'), { aria: t('畫面風格') });

    const text = (k, ph) => { const el = h('input.input', { value: c[k] || '', placeholder: ph || '' }); el.addEventListener('input', () => { c[k] = el.value; this.saveDraft(); }); return el; };
    const num = (k, min, max) => { const el = h('input.input.num', { type: 'number', min, max, value: c[k] }); el.addEventListener('change', () => { c[k] = Math.max(min, Math.min(max, Number(el.value) || min)); el.value = c[k]; this.saveDraft(); }); return el; };

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
      h('summary.panel-body', { style: { cursor: 'default' } }, h('span.headline', t('更多選項')), h('span.caption.muted', { style: { marginLeft: '12px' } }, t('語氣、觀眾、檢查項目、重試與時間上限、Claude 計費'))),
      h('div.panel-body.col', { style: { paddingTop: 0 } },
        h('div.grid2', field(t('語氣'), text('tone')), field(t('觀眾'), text('audience'))),
        field(t('補充說明（希望涵蓋的重點、要避免的內容、指定資料來源…）'), (() => { const el = h('textarea.textarea', { rows: 2 }); el.value = c.notes || ''; el.addEventListener('input', () => { c.notes = el.value; this.saveDraft(); }); return el; })()),
        h('div.row.wrap', { style: { gap: '20px' } },
          toggle(t('封面'), c.thumbnail, set('thumbnail')), toggle(t('上架資訊'), c.publishInfo, set('publishInfo')),
          toggle(t('畫面 AI 審查'), c.visualReview, set('visualReview')), toggle(t('發音檢查（Whisper）'), c.pronunciationCheck, set('pronunciationCheck'))),
        field(t('繁中語速（字／秒；空白 = 配音員自然語速，約 3.6）'), (() => { const el = h('input.input.num', { type: 'number', min: '2.5', max: '7', step: '0.1', value: c.twCps ?? '', placeholder: '3.6' }); el.addEventListener('change', () => { c.twCps = el.value === '' ? null : Math.max(2.5, Math.min(7, Number(el.value))); el.value = c.twCps ?? ''; this.saveDraft(); }); return el; })(),
          h('div.caption.muted', t('簡中版固定約每秒 5.4 字（大陸配音）。音色由專案的參考人聲決定（tools/CosyVoice/reference），更換請使用明確授權的聲音。'))),
        h('div.grid3', field(t('每個階段最多嘗試'), num('maxAttempts', 1, 10)), field(t('總時間上限（分鐘）'), num('maxMinutes', 10, 1440)), field(t('Claude 每次最多回合'), num('maxTurns', 10, 400))),
        field(t('AI 提供者'), agentSeg), agentBox,
        h('div', { hidden: c.agent !== 'claude' || null, dataset: { claudeOnly: '1' } }, field(t('Claude 計費方式'), billing), budgetBox)));

    const start = btn(t('開始製作'), { kind: 'primary', icon: 'play', onClick: () => this.start(start) });
    mount(this.formEl, h('div.panel.panel-body.col',
      field(t('主題'), topic),
      h('div.grid2', { style: { alignItems: 'end' } },
        field(t('影片長度（分鐘，實際長度由旁白決定）'), h('div.slider', minutes, minVal)),
        field(t('畫面風格'), style)),
      h('div.row.wrap', { style: { gap: '20px' } },
        h('span.caption.muted', t('輸出')),
        toggle(t('繁中正式版'), true, () => {}, { disabled: true, title: t('一定會產生') }),
        toggle(t('YouTube 1.5×（繁中）'), c.youtube, set('youtube')),
        toggle(t('Bilibili（簡中、大陸用語、大陸配音）'), c.bilibili, set('bilibili'))),
      more,
      h('div.row', h('div.caption.muted.grow', t('集數會自動分配（不會覆蓋既有集數）；所有修改在隔離的 git 工作樹進行，全部檢查通過才合併。不會自動上傳或發布。')), start)));
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
    if (!c.topic || c.topic.trim().length < 2) { toast(t('請輸入主題'), 'warn'); return; }
    if (c.billing === 'api' && !(c.budgetUsd > 0)) { toast(t('API 付費模式必須設定美元上限'), 'warn'); return; }
    const ok = await confirmSheet({
      title: t('開始自動製作'),
      text: t('Studio 會依序執行所有階段，可能需要數十分鐘到數小時，期間會使用 GPU。你可以隨時暫停或停止。'),
      detail: [
        `${t('主題')}：${c.topic}`, `${t('長度')}：${c.minutes} ${t('分鐘')}`, `${t('畫面')}：${c.style === 'ai' ? t('AI 動畫') : t('通用樣板')}`,
        `${t('輸出')}：${[t('繁中正式版'), c.youtube && 'YouTube 1.5×', c.bilibili && 'Bilibili zh-CN'].filter(Boolean).join('、')}`,
        c.agent === 'claude' ? `Claude：${c.billing === 'api' ? t('API 付費，每次上限 ${x}', { x: c.budgetUsd }) : t('訂閱（已登入的 Claude Code，不設美元上限）')}` : `${t('AI 提供者')}：${c.agent === 'doubao' ? t('豆包 CLI') : t('外部 Agent（豆包工作）')}`,
      ].join('\n'),
      confirmLabel: t('開始製作'),
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const prod = await call('auto_start', { projectId: this.p.id, config: c });
      toast(t('已開始：{ep}', { ep: prod.episode.toUpperCase() }), 'ok');
      this.cfg.topic = ''; this.saveDraft(); this.paintForm();
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
      out.length ? h('div.col', { style: { gap: '6px' } }, h('span.headline', t('成品（在專案資料夾）')),
        h('div.row.wrap', out.map((f) => btn(f, { small: true, icon: /\.mp4$/.test(f) ? 'play' : 'external', onClick: () => call('open_path', { projectId: this.p.id, path: f, reveal: false }).catch((e) => toastError(e, t('開啟'))) }))),
        h('div.caption.muted', t('發布請自行到各平台手動上傳；上架文字在 {f}。', { f: `${x.episode.toUpperCase()}_PUBLISH_METADATA.md` }))) : null,
      h('dl.kv',
        h('dt', t('集數')), h('dd', x.episode.toUpperCase()),
        h('dt', t('工作樹')), h('dd.mono', x.worktree ? `.studio/worktrees/${x.worktree}（${x.branch}）` : t('已清除')),
        h('dt', t('已執行')), h('dd', `${fmtDur(x.activeMs / 1000)}（${t('上限 {m} 分鐘', { m: x.config.maxMinutes })}）`),
        h('dt', 'Claude'), h('dd', `${x.claudeRuns} ${t('次')}・${x.config.billing === 'api' ? t('API 付費（每次上限 ${b}）', { b: x.config.budgetUsd }) : t('訂閱')}・${t('模型等價估算 ${c}', { c: fmtNum(x.claudeCostUsd, 2) })}`),
        h('dt', ''), h('dd.caption.muted', x.config.billing === 'api' ? t('API 模式下估算值接近實際計費，以 Anthropic Console 為準。') : t('訂閱模式不依此金額扣款；這只是 Claude Code 回報的等價模型成本，用來了解用量。'))),
      h('div.col', { style: { gap: '6px' } }, h('div.row', h('span.headline.grow', t('活動紀錄')), btn(t('前往佇列'), { small: true, icon: 'queue', onClick: () => { if (x.jobId) sessionStorage.setItem('queue.select', x.jobId); this.ctx.go('queue'); } })),
        h('div.auto-log.mono.selectable', { dataset: { log: x.id } }, (this.logs[x.id] || []).slice(-300).map((e) => logLine(e)))),
    ];
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
