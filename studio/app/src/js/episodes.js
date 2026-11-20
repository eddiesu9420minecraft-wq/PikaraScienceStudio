// Multi-episode helpers shared by Script editor, Production and Projects (API v1.2).
import { t } from './i18n.js';
import { call, NotReady } from './api.js';
import { h, sheet, field, toggle, toast, toastError } from './ui.js';

const KEY = (pid) => `episode.${pid}`;
export function currentEpisode(projectId) { return localStorage.getItem(KEY(projectId)) || 'ep01'; }
export function setEpisode(projectId, ep) { if (ep) localStorage.setItem(KEY(projectId), ep); }

export async function listEpisodes(projectId) {
  try { return await call('episode_list', { projectId }); } catch (e) { if (e instanceof NotReady) return null; throw e; }
}

// "New episode" sheet → episode_create. Resolves with the result (or null when cancelled).
export function newEpisodeSheet(projectId, existing = []) {
  return new Promise((resolve) => {
    const nums = existing.map((e) => Number(String(e.id || e).slice(2))).filter((n) => !isNaN(n));
    const next = `ep${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
    const title = h('input.input', { type: 'text', placeholder: t('例：什麼是 Token？'), 'aria-label': t('標題'), maxlength: '80' });
    const id = h('input.input.mono', { type: 'text', placeholder: next, 'aria-label': t('集數 id'), spellcheck: 'false', style: { width: '120px' } });
    const scene = h('input.input', { type: 'text', placeholder: t('開場'), 'aria-label': t('第一段標題') });
    const line = h('textarea.input', { rows: '2', placeholder: t('在這裡輸入第一句旁白。'), 'aria-label': t('第一句旁白') });
    const st = { cn: false };
    const err = h('div.fail-text.caption', { hidden: true, role: 'alert' });
    let result = null;
    sheet({
      title: t('新增集數'),
      body: [
        h('div.muted', t('在 narration.json 建立 sequences.<id>：一個段落、一句旁白的骨架，驗證後存檔並 git commit。之後在「劇本編輯」寫完整旁白。')),
        field(t('標題'), title), h('div.row', field(t('集數 id'), id), h('div.caption.muted', t('留空＝自動使用 {x}', { x: next }))),
        field(t('第一段標題'), scene), field(t('第一句旁白'), line),
        toggle(t('同時建立簡體 zh-CN 版本（否則之後由 make_cn 轉換）'), false, (v) => { st.cn = v; }),
        err,
      ],
      actions: [{ label: t('取消') }, {
        label: t('建立'), kind: 'primary', onClick: async () => {
          const tt = title.value.trim();
          if (!tt) { err.hidden = false; err.textContent = t('請輸入標題'); title.focus(); return false; }
          try {
            result = await call('episode_create', {
              projectId, title: tt, episodeId: id.value.trim() || null, sceneTitle: scene.value.trim() || null,
              firstLine: line.value.trim() || null, locales: st.cn ? ['zh-TW', 'zh-CN'] : ['zh-TW'],
            });
            setEpisode(projectId, result.episodeId);
            toast(t('已建立 {x}（{c}）', { x: result.episodeId, c: (result.files || []).map((f) => (f.commit || '').slice(0, 7)).filter(Boolean).join('、') || t('未提交') }), 'ok');
            return true;
          } catch (e) { err.hidden = false; err.textContent = e.message || String(e); return false; }
        },
      }],
      onClose: () => resolve(result),
    });
    setTimeout(() => title.focus(), 30);
  });
}

// "New project" sheet → project_create (template = the current project).
export function newProjectSheet(templateProjectId) {
  return new Promise((resolve) => {
    const dest = h('input.input.mono', { type: 'text', placeholder: 'D:\\影片\\我的 科普', 'aria-label': t('新專案資料夾'), spellcheck: 'false' });
    const title = h('input.input', { type: 'text', placeholder: t('第一集標題'), 'aria-label': t('標題') });
    const st = { link: true };
    const err = h('div.fail-text.caption', { hidden: true, role: 'alert' });
    let result = null;
    sheet({
      title: t('建立新專案'),
      body: [
        h('div.muted', t('從目前專案的管線範本（scripts、src、public/fonts、package.json…）建立新資料夾，內容重設為只有 ep01 的骨架，並 git init。路徑可以含中文與空白。')),
        field(t('新專案資料夾（完整路徑，資料夾需不存在或是空的）'), dest), field(t('標題'), title),
        toggle(t('連結共用的 CosyVoice（目錄連結，不複製 9 GB 模型）'), true, (v) => { st.link = v; }),
        err,
      ],
      actions: [{ label: t('取消') }, {
        label: t('建立'), kind: 'primary', onClick: async () => {
          if (!dest.value.trim() || !title.value.trim()) { err.hidden = false; err.textContent = t('請輸入資料夾與標題'); return false; }
          try {
            result = await call('project_create', { dest: dest.value.trim(), title: title.value.trim(), templateProjectId: templateProjectId || null, linkTools: st.link });
            toast(t('已建立新專案：{x}（{n} 個檔案）', { x: result.project.name, n: result.scaffold.files }), 'ok');
            return true;
          } catch (e) { err.hidden = false; err.textContent = e.message || String(e); return false; }
        },
      }],
      onClose: () => resolve(result),
    });
  }).catch((e) => { toastError(e); return null; });
}
