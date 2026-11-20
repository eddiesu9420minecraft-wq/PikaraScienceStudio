// 8. Preview & Publish — video player, ffprobe metadata, thumbnails, PUBLISH_METADATA.md with copy buttons.
// Manual publishing only: this screen contains no upload code path.
import { t } from '../i18n.js';
import { call, hasTauri, fileSrc } from '../api.js';
import { h, mount, btn, seg, empty, loading, errorBox, notReady, needProject, toast, toastError, tag, fmtBytes, fmtDur, fmtTime, copyText, basename } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject, ensureAssets } from '../store.js';

const ui = { selected: null, platform: 'youtube' };

export default {
  id: 'publish', title: '預覽與發佈', icon: 'publish',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['outputs_list', 'publish_metadata', 'asset_url_allowed']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    const pre = sessionStorage.getItem('publish.select'); if (pre) { ui.selected = pre; sessionStorage.removeItem('publish.select'); }
    const platSeg = seg([{ value: 'youtube', label: 'YouTube' }, { value: 'bilibili', label: t('B站') }, { value: 'all', label: t('全部') }], ui.platform, (v) => { ui.platform = v; paintMeta(); paintThumbs(); }, { aria: t('平台') });
    ctx.toolbar(t('預覽與發佈'), p.name, [platSeg, btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => ctx.rerender() })]);

    const listBox = h('div.panel', { style: { overflow: 'auto' } });
    const player = h('div.col');
    const metaBox = h('div.col');
    const thumbs = h('div.col');
    mount(ctx.content, h('div.page',
      h('div.banner.info', icon('info'), h('div.grow', h('b', t('只能人工發佈。')), ' ', t('Studio 沒有任何上傳功能；請在 YouTube Studio／B站創作中心自行上傳，下方的文字可以直接複製。'))),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: '24px', alignItems: 'start' } },
        h('section.section', h('div.section-head', h('h2.title2', t('影片'))), listBox),
        h('section.col', { style: { gap: '24px' } }, player, thumbs)),
      metaBox));

    mount(listBox, loading(4));
    let outs = [], meta = null, assetsOk = false;
    try { outs = await call('outputs_list', { projectId: p.id, probe: true }); }
    catch (e) { if (ctx.alive()) mount(listBox, errorBox(e, () => ctx.rerender())); }
    try { assetsOk = await ensureAssets(p.id); } catch (e) { console.warn(e); }
    if (!ctx.alive()) return;
    const videos = outs.filter((o) => o.ext === 'mp4').sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    const pngs = outs.filter((o) => o.ext === 'png');
    const srts = outs.filter((o) => o.ext === 'srt');
    if (!ui.selected || !videos.find((v) => v.path === ui.selected)) ui.selected = (videos.find((v) => /YouTube/i.test(v.name)) || videos[0] || {}).path || null;

    const paintList = () => {
      if (!videos.length) { mount(listBox, empty(t('沒有影片'), t('專案根目錄與 out/ 裡沒有 mp4。'), 'film')); return; }
      mount(listBox, h('div.list', { role: 'listbox', 'aria-label': t('影片') }, videos.map((v) => {
        const sel = v.path === ui.selected;
        const pr = v.probe;
        const row = h('div.list-row.clickable', { role: 'option', tabindex: '0', 'aria-selected': String(sel) },
          h('div.main-text', h('div.t', { title: v.name }, v.name),
            h('div.d.num', [pr ? `${pr.width}×${pr.height}` : null, pr && pr.fps ? `${round(pr.fps)}fps` : null, pr ? fmtDur(pr.durationS) : null, fmtBytes(v.size)].filter(Boolean).join(' · ')),
            h('div.d', fmtTime(v.mtime))));
        const pick = () => { ui.selected = v.path; paintList(); paintPlayer(); };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } if (e.key === 'ArrowDown' && row.nextElementSibling) row.nextElementSibling.focus(); if (e.key === 'ArrowUp' && row.previousElementSibling) row.previousElementSibling.focus(); });
        return row;
      })));
    };

    const paintPlayer = () => {
      const v = videos.find((x) => x.path === ui.selected);
      if (!v) { mount(player); return; }
      const pr = v.probe;
      const vid = h('video', { controls: true, preload: 'metadata', 'aria-label': v.name });
      const frame = h('div.video-frame', assetsOk ? vid : h('div.empty', icon('alert'), h('div.callout', t('資產協定未允許此專案路徑，無法播放。'))));
      if (assetsOk) {
        vid.src = fileSrc(v.path);
        vid.addEventListener('error', () => mount(frame, h('div.empty', icon('alert'), h('div.callout', t('無法播放此影片（{c}）。', { c: pr ? `${pr.vcodec}` : '?' })), h('div.caption.mono', v.path))));
      }
      const srt = srts.find((s) => basename(s.path).replace(/\.srt$/i, '') === basename(v.path).replace(/\.mp4$/i, ''));
      mount(player,
        h('div.row', h('h2.title2.grow.ellipsis', v.name),
          btn(t('在資料夾中顯示'), { icon: 'folder', onClick: () => call('open_path', { projectId: p.id, path: v.path, reveal: true }).catch((e) => toastError(e, t('開啟資料夾'))) }),
          btn(t('用預設播放器開啟'), { icon: 'external', onClick: () => call('open_path', { projectId: p.id, path: v.path }).catch((e) => toastError(e)) })),
        frame,
        h('div.panel.panel-body', pr ? h('dl.kv', { style: { gridTemplateColumns: 'max-content minmax(0,1fr) max-content minmax(0,1fr)' } },
          h('dt', t('解析度')), h('dd.num', `${pr.width}×${pr.height}`),
          h('dt', t('影格率')), h('dd.num', pr.fps ? `${round(pr.fps)} fps` : '—'),
          h('dt', t('長度')), h('dd.num', fmtDur(pr.durationS)),
          h('dt', t('大小')), h('dd.num', fmtBytes(pr.sizeBytes ?? v.size)),
          h('dt', t('視訊編碼')), h('dd.mono', pr.vcodec || '—'),
          h('dt', t('音訊編碼')), h('dd.mono', pr.acodec || h('span.warn-text', t('無音軌'))),
          h('dt', t('位元率')), h('dd.num', pr.bitRate ? `${(pr.bitRate / 1e6).toFixed(2)} Mb/s` : '—'),
          h('dt', t('字幕')), h('dd', srt ? h('span.mono', basename(srt.path)) : h('span.muted', t('找不到同名 .srt'))),
          h('dt', t('路徑')), h('dd.mono.caption', { style: { gridColumn: 'span 3' } }, v.path))
          : h('div.muted', t('沒有 ffprobe 資訊（ffprobe 不可用或檔案無法讀取）。'))));
    };

    const paintThumbs = () => {
      const list = pngs.filter((x) => /thumb/i.test(x.name)).filter((x) => ui.platform === 'all' || (ui.platform === 'youtube' ? !/bilibili/i.test(x.name) : /bilibili/i.test(x.name)));
      if (!list.length) { mount(thumbs, h('section.section', h('div.section-head', h('h2.title2', t('縮圖'))), h('div.caption.muted', t('沒有符合的縮圖（檔名含 Thumbnail 的 png）。')))); return; }
      mount(thumbs, h('section.section', h('div.section-head', h('h2.title2', t('縮圖'))),
        h('div.grid3', list.map((x) => h('figure.col', { style: { margin: 0, gap: '8px' } },
          assetsOk ? h('img.thumb-lg', { src: fileSrc(x.path), alt: x.name, loading: 'lazy' }) : h('div.thumb-lg'),
          h('figcaption.row', h('span.caption.ellipsis.grow', { title: x.path }, x.name), h('span.caption.muted.num', fmtBytes(x.size)),
            btn('', { small: true, icon: 'folder', aria: t('在資料夾中顯示'), onClick: () => call('open_path', { projectId: p.id, path: x.path, reveal: true }).catch((e) => toastError(e)) })))))));
    };

    const paintMeta = () => {
      if (meta == null) return;
      if (meta.error) { mount(metaBox, errorBox(meta.error)); return; }
      if (!meta.exists) { mount(metaBox, h('div.panel', empty(t('找不到 PUBLISH_METADATA.md'), t('在專案根目錄建立 PUBLISH_METADATA.md 後，這裡會顯示各平台的標題、說明與標籤。'), 'script'))); return; }
      const secs = pickSections(meta.sections || [], ui.platform);
      mount(metaBox, h('section.section',
        h('div.section-head', h('h2.title2', t('平台中繼資料')), h('span.caption.mono.muted.ellipsis', meta.path),
          btn(t('開啟檔案'), { small: true, icon: 'external', onClick: () => call('open_path', { projectId: p.id, path: meta.path }).catch((e) => toastError(e)) })),
        secs.length ? secs.map((s) => sectionView(s)) : h('div.caption.muted', t('這個平台沒有對應的段落。'))));
    };

    paintList(); paintPlayer(); paintThumbs();
    mount(metaBox, loading(4));
    try { meta = await call('publish_metadata', { projectId: p.id }); } catch (e) { meta = { error: e }; }
    if (ctx.alive()) paintMeta();
  },
};

function round(x) { return Math.round(x * 100) / 100; }

// Keep the level-2 sections that match the platform (YouTube / Bilibili), with their sub-sections.
function pickSections(sections, platform) {
  if (platform === 'all') return sections.filter((s) => (s.content || '').trim() || s.level <= 2);
  const re = platform === 'youtube' ? /youtube|zh-tw/i : /bilibili|b站|zh-cn/i;
  const out = []; let on = false; let base = 99;
  for (const s of sections) {
    if (s.level <= 2) { on = re.test(s.title); base = s.level; if (on) out.push(s); continue; }
    if (on && s.level > base) out.push(s);
  }
  return out;
}

function sectionView(s) {
  return h('div.panel', h('div.panel-head', h('div', { class: s.level <= 2 ? 'headline' : 'callout', style: { flex: 1, fontWeight: 600 } }, s.title),
    (s.content || '').trim() ? btn(t('複製整段'), { small: true, icon: 'copy', onClick: () => copyText(s.content.trim(), s.title) }) : null),
    (s.content || '').trim() ? h('div.panel-body.col', { style: { gap: '12px' } }, blocks(s.content)) : null);
}

// Turn markdown-ish content into copyable blocks: fenced code, "**標籤**：…" fields, numbered options.
function blocks(md) {
  const out = []; const lines = md.replace(/\r/g, '').split('\n');
  let i = 0; let label = null;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const text = buf.join('\n');
      out.push(h('div.col', { style: { gap: '4px' } }, h('div.row', h('span.grow'), btn(t('複製'), { small: true, icon: 'copy', onClick: () => copyText(text, label || t('內容')) })),
        h('pre.code', { style: { maxHeight: '320px', margin: 0 } }, text)));
      label = null; continue;
    }
    const field = /^\*\*(.+?)\*\*[：:]\s*(.+)$/.exec(l);
    if (field && !/\*\*/.test(field[2])) {
      const v = field[2].trim();
      out.push(h('div.row', { style: { alignItems: 'flex-start' } }, h('span.caption.muted.nowrap', { style: { width: '72px', paddingTop: '4px' } }, field[1]),
        h('div.grow.selectable', { style: { overflowWrap: 'anywhere' } }, v), btn('', { small: true, icon: 'copy', aria: t('複製 {x}', { x: field[1] }), onClick: () => copyText(v.replace(/`/g, ''), field[1]) })));
      i++; continue;
    }
    const head = /^\*\*(.+?)\*\*(（.*）)?\s*$/.exec(l);
    if (head) { label = head[1]; out.push(h('div.caption', { style: { fontWeight: 600, color: 'var(--text-secondary)' } }, l.replace(/\*\*/g, ''))); i++; continue; }
    const num = /^\s*(\d+)\.\s+(.+)$/.exec(l);
    if (num) {
      const v = num[2].trim();
      out.push(h('div.row', { style: { alignItems: 'flex-start' } }, h('span.caption.muted.num', { style: { width: '20px', paddingTop: '2px' } }, num[1] + '.'),
        h('div.grow.selectable', { style: { overflowWrap: 'anywhere' } }, v), btn('', { small: true, icon: 'copy', aria: t('複製 {x}', { x: `${label || ''} ${num[1]}` }), onClick: () => copyText(v, `${label || ''} ${num[1]}`) })));
      i++; continue;
    }
    if (/^---+\s*$/.test(l) || !l.trim()) { i++; continue; }
    out.push(h('div.callout.selectable', { style: { overflowWrap: 'anywhere', color: /^>/.test(l) ? 'var(--text-secondary)' : null } }, l.replace(/^>\s?/, '').replace(/\*\*/g, '')));
    i++;
  }
  return out;
}
