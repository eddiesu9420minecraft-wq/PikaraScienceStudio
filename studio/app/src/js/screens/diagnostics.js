// Diagnostics — developer / troubleshooting tools kept apart from everyday work: environment doctor, live
// resources, background threads (watchdog), database schema + backups, app paths, Git history / rollback.
import { t } from '../i18n.js';
import { h, mount, btn, toast, toastError, loading, errorBox, dot, fmtBytes, openPath, copyBtn } from '../ui.js';
import { call, hasTauri, errText } from '../api.js';
import { store, on, monitorHistory } from '../store.js';
import { tabbed, card, pathLine } from '../v03/common.js';
import doctor from './doctor.js';
import monitor from './monitor.js';
import rollback from './rollback.js';

export default {
  id: 'diagnostics', title: '診斷', icon: 'pulse',
  async render(ctx) {
    await tabbed(ctx, t('診斷'), [
      { id: 'system', title: '系統狀態', render: (el) => systemTab(el, ctx) },
      { id: 'gpu', title: 'GPU 實際使用', render: (el) => gpuTab(el, ctx) },
      { id: 'doctor', title: '環境檢查', screen: doctor },
      { id: 'monitor', title: '資源監控', screen: monitor },
      { id: 'history', title: 'Git 版本與回滾', screen: rollback },
    ]);
  },
};

async function systemTab(el, ctx) {
  if (!hasTauri) return mount(el, h('div.page', h('div.caption.muted', t('未連接 Studio 後端'))));
  mount(el, h('div.page', loading(4)));
  let info, dbi, pipe = null;
  try { [info, dbi] = await Promise.all([call('app_info'), call('db_info')]); } catch (e) { return mount(el, h('div.page', errorBox(e, () => ctx.rerender()))); }
  // the project's pipeline scripts vs. the ones this build carries (read-only)
  if (store.projectId) { try { pipe = await call('pipeline_status', { projectId: store.projectId }); } catch (e) { pipe = { error: errText(e) }; } }
  const threads = h('div');
  const paintThreads = () => {
    const last = monitorHistory[monitorHistory.length - 1];
    const th = (last && last.threads) || {};
    mount(threads, Object.keys(th).length ? h('div.col', { style: { gap: '8px' } }, Object.entries(th).map(([n, v]) => h('div.row', dot(v.stalled ? 'fail' : 'ok'), h('b', { style: { width: '120px' } }, n),
      h('span.grow.caption.muted', `${t('最後心跳')} ${v.ageSec}s · ${v.doing || '—'}${v.panics ? ' · ' + t('已攔截 {n} 次錯誤', { n: v.panics }) : ''}`)))) : h('div.caption.muted', t('等待取樣…')));
  };
  paintThreads();
  ctx.cleanup(on('monitor', paintThreads));
  const backupBtn = btn(t('立即備份資料庫'), { small: true, onClick: async () => {
    try { const r = await call('db_backup'); toast(t('已備份並驗證：{x}', { x: r.backup }), 'ok'); ctx.rerender(); } catch (e) { toastError(e, t('備份')); }
  } });
  mount(el, h('div.page', { style: { paddingTop: '20px' } },
    h('div.grid2', { style: { alignItems: 'start' } },
      card(t('背景執行緒'), threads, { actions: [h('span.caption.muted', t('Watchdog'))] }),
      card(t('Studio'), h('dl.kv',
        h('dt', t('版本')), h('dd', info.version),
        h('dt', t('Git Commit')), h('dd.mono.selectable', info.gitCommit || '—'),
        h('dt', t('介面指紋')), h('dd.mono.selectable', (info.frontendSha256 || '').slice(0, 12) || '—'),
        h('dt', t('製作腳本（內建）')), h('dd.mono.selectable', info.pipelineBundle ? `${info.pipelineBundle} · ${info.pipelineFiles} ${t('個檔案')}` : '—'),
        h('dt', t('製作腳本（目前專案）')), h('dd', pipeLine(pipe, info)),
        h('dt', t('佇列排程')), h('dd', info.schedulerActive ? t('由這個視窗執行') : t('由另一個 Studio 程式執行（這裡只能檢視）')),
        h('dt', t('資料夾')), h('dd', pathLine(info.dataDir)),
        h('dt', t('紀錄')), h('dd', pathLine(info.logsDir)),
        h('dt', t('Watchdog 紀錄')), h('dd', pathLine(`${info.logsDir}\\studio-watchdog.log`))),
        { actions: [btn(t('開啟紀錄資料夾'), { small: true, onClick: () => call('open_app_dir', { which: 'logs' }).catch((e) => toastError(e, t('開啟紀錄資料夾'))) })] })),
    card(t('資料庫'), h('div.col',
      h('dl.kv', h('dt', t('結構版本')), h('dd', `v${dbi.schemaVersion}${dbi.schemaVersion === dbi.latest ? '' : ' → v' + dbi.latest}`),
        h('dt', t('位置')), h('dd', pathLine(dbi.path))),
      h('div.caption.muted', t('結構變更前會自動備份並驗證；還原請關閉 Studio 後執行：PikaraScienceStudio.exe --cli db-restore --from <備份檔>')),
      dbi.backups.length ? h('div.col', { style: { gap: '6px' } }, dbi.backups.slice(0, 8).map((b) => h('div.row', h('div.grow', pathLine(b.path)), h('span.caption.muted', fmtBytes(b.bytes)), copyBtn(`"${info.exePath}" --cli db-restore --from "${b.path}"`, t('還原指令'))))) : h('div.caption.muted', t('還沒有備份'))),
      { actions: [backupBtn] })));
}

function pipeLine(pipe, info) {
  if (!pipe) return h('span.caption.muted', t('未選擇專案'));
  if (pipe.error) return h('span.caption', pipe.error);
  const plan = pipe.plan || {};
  if (plan.skipped) return h('span.caption.muted', t('不是製作管線專案'));
  const pending = (plan.changed || []).length, kept = (plan.kept || []).length;
  const ver = pipe.projectBundle ? `${pipe.projectBundle}${pipe.projectStudioVersion ? ' · v' + pipe.projectStudioVersion : ''}` : t('尚未由 Studio 同步');
  const state = pending ? t('有 {n} 個待更新（下次啟動或開始製作時同步）', { n: pending }) : (pipe.projectBundle === info.pipelineBundle ? t('與內建一致') : t('已是最新'));
  return h('span', h('span.mono.selectable', ver), ' · ', h('span', { class: pending ? '' : 'caption muted' }, state), kept ? h('span.caption.muted', ' · ' + t('保留你修改過的 {n} 個', { n: kept })) : null);
}

// GPU actually used by each role — Windows GPU Engine / GPU Process Memory counters (same source as Task Manager),
// not the settings. UI = this window's WebView2 processes; render = Chromium of Remotion; AI = Python; encoder = ffmpeg.
const ROLE_LABEL = { ui: '介面（WebView2）', render: '影片渲染（Chromium）', ai: 'AI 推理（Python）', encoder: '影片編碼（ffmpeg）' };
async function gpuTab(el, ctx) {
  if (!hasTauri) return mount(el, h('div.page', h('div.caption.muted', t('未連接 Studio 後端'))));
  const body = h('div.col');
  const refresh = btn(t('重新量測'), { small: true, icon: 'refresh', onClick: () => measure() });
  mount(el, h('div.page', { style: { paddingTop: '20px' } }, body));
  ctx.toolbar(t('診斷'), t('GPU 實際使用'), [refresh]);
  async function measure() {
    mount(body, h('div.row.gap2', h('span.dot.running'), h('span.caption.muted', t('讀取 GPU Engine 效能計數器（約 1.5 秒）…'))));
    let info, u;
    try { [info, u] = await Promise.all([call('hw_info', { projectId: store.projectId }), call('hw_usage', { ms: 1500 })]); }
    catch (e) { return mount(body, errorBox(e, measure)); }
    if (!ctx.alive()) return;
    const name = (luid) => (u.adapters && u.adapters[luid]) || luid;
    const a = info.assignment;
    const want = { ui: a.ui, render: a.render, ai: a.ai };
    const launch = info.uiLaunch || {};
    const roles = (u.ok && u.roles) || {};
    mount(body,
      !u.ok ? h('div.banner.warn', h('div.grow', t('無法讀取 GPU 效能計數器：{x}', { x: u.error }))) : null,
      card(t('各工作實際使用的 GPU'), h('div.col', { style: { gap: '12px' } },
        ['ui', 'render', 'ai', 'encoder'].map((r) => {
          const rows = roles[r] || [];
          const expected = want[r] && want[r].gpuName;
          const used = rows.filter((x) => x.utilPct > 0.05 || x.dedicatedMiB > 1).sort((p, q) => q.utilPct - p.utilPct);
          // where the role's GPU resources live (dedicated memory) decides "consistent"; for the UI, load on the GPU that
          // drives the screen is the cross-adapter copy Windows needs to display a window drawn on another GPU
          const byMem = [...used].sort((p, q) => q.dedicatedMiB - p.dedicatedMiB || q.utilPct - p.utilPct);
          const ok = expected && byMem.length ? byMem[0].luid === want[r].luid : null;
          const display = (info.snapshot.gpus || []).find((g) => g.displayOutputs > 0);
          const copyNote = r === 'ui' && ok && display && display.luid !== want[r].luid && used.some((x) => x.luid === display.luid)
            ? h('div.caption.muted', t('螢幕接在 {d}：在 {u} 畫好的介面要跨 GPU 複製到 {d} 才能顯示，所以 {d} 上有少量介面負載（硬體接線決定）。', { d: display.name, u: expected })) : null;
          return h('div.col', { style: { gap: '4px' } },
            h('div.row.wrap', h('b', t(ROLE_LABEL[r])), expected ? h('span.caption.muted', t('分配：{x}', { x: expected })) : null,
              ok === true ? h('span.tag.ok', t('一致')) : ok === false ? h('span.tag.warn', t('與分配不同')) : null),
            copyNote,
            used.length ? used.map((x) => h('div.caption', `${name(x.luid)} · ${t('使用率 {p}%', { p: x.utilPct })} · ${t('專用記憶體 {m} MiB', { m: x.dedicatedMiB })} · ${Object.entries(x.engines).filter(([, v]) => v > 0.05).map(([k, v]) => `${k} ${v.toFixed(1)}%`).join('、') || t('閒置')} · PID ${x.pids.join(',')}`))
              : h('div.caption.muted', r === 'ui' ? t('介面目前沒有 GPU 負載') : t('目前沒有這類程序在使用 GPU')));
        }))),
      card(t('每張 GPU 的負載（各程序合計；共用的記憶體會在每個使用它的程序各算一次）'), h('div.col', { style: { gap: '6px' } }, (u.perAdapter || []).filter((x) => x.name).map((x) => h('div.row', h('b.grow', x.name), h('span.caption.muted', t('使用率 {p}%・專用記憶體 {m} MiB', { p: x.utilPct, m: x.dedicatedMiB })))))),
      card(t('介面 GPU（本次啟動）'), h('dl.kv',
        h('dt', t('分配')), h('dd', launch.choice ? `${launch.choice.gpuName || launch.choice.target}（${t(launch.choice.reason || '')}）` : '—'),
        h('dt', t('已套用')), h('dd', launch.applied ? t('是（WebView2 啟動參數）') : t('否：{x}', { x: t(launch.reason || '使用 WebView2 預設 GPU') })),
        h('dt', t('參數')), h('dd', pathLine(launch.args || '—')))));
  }
  await measure();
}
