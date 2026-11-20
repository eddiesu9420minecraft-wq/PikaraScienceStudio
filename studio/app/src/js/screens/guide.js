// Guide — in-app tutorial (always reachable from the sidebar) + the first-launch walkthrough.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, sheet } from '../ui.js';
import { icon } from '../icons.js';
import { store } from '../store.js';

const SEEN_KEY = 'guide.seen.v2';

// Each step: what to do, where, and how to tell it worked. `go` = screen to open.
const STEPS = [
  { icon: 'doctor', title: '1. 檢查環境', go: 'doctor', body: [
    '開啟「環境」頁按「重新檢查」。紅色項目要先處理：Node.js、ffmpeg（含 ffprobe、NVENC）、Python 3.11、CosyVoice 3、Chrome Headless Shell、Claude Code。',
    '標示「可自動修復」的項目按「修復」；其他項目會顯示要執行的指令。系統層級設定（例如長路徑、睡眠）只提供說明，不會自動更改。',
  ] },
  { icon: 'terminal', title: '2. 登入 Claude Code', body: [
    '自動製作使用你電腦上的官方 Claude Code CLI。在終端機執行 claude，依畫面完成登入（Claude 訂閱帳號）。',
    'Studio 不會要求、也不會保存 API Key、帳號或密碼。預設以訂閱模式執行，不設美元上限；遇到用量上限會自動暫停並保存進度，不會改用付費 API。',
  ] },
  { icon: 'folder', title: '3. 加入專案資料夾', go: 'projects', body: [
    '在「專案」頁輸入影片專案資料夾的完整路徑（例如下載的 pipeline 資料夾），按「加入專案」。也可以從範本建立新專案（路徑可含中文與空白）。',
    '專案必須是 git 倉庫：每次自動製作都在隔離的 git 工作樹進行，全部檢查通過才合併。',
  ] },
  { icon: 'sparkle', title: '4. 自動製作', go: 'auto', body: [
    '在「自動製作」輸入主題、拖曳影片長度、選畫面風格（AI 動畫或通用樣板），勾選要輸出的版本（繁中正式版一定會產生，另可選 YouTube 1.5× 與 Bilibili 簡中），按「開始製作」。',
    '「更多選項」可以設定語氣、觀眾、補充說明、要執行的檢查、每個階段最多嘗試幾次、總時間上限與 Claude 計費方式。',
  ] },
  { icon: 'gauge', title: '5. 觀看進度、暫停或停止', go: 'auto', body: [
    '製作紀錄會顯示目前階段、進度條、即時活動紀錄、警告與資源使用。可隨時「暫停」（正在執行的工作會做完）、「繼續」或「停止」。',
    '失敗或停止時專案本身沒有任何改變；按「重試這個階段」從失敗處繼續，或按「捨棄（回復）」刪除這次的工作樹與分支。Studio 被關閉或當機後重新開啟，會自動接著做。',
  ] },
  { icon: 'publish', title: '6. 檢查成品並手動發布', go: 'publish', body: [
    '完成後會收到 Windows 通知。成品放在專案資料夾：<EP>_Final.mp4、<EP>_YouTube_zh-TW.mp4、<EP>_Bilibili_zh-CN.mp4、字幕 .srt、封面 PNG、<EP>_PUBLISH_METADATA.md（標題、說明、標籤）與 <EP>_SOURCES.md（資料來源）。',
    '請務必自己看過影片與資料來源再發布。Studio 沒有任何上傳程式碼，發布一律由你手動完成。',
  ] },
  { icon: 'wrench', title: '7. 進階模式', body: [
    '側欄下方打開「進階模式」可以使用單一步驟工具：劇本編輯、提示詞與 Claude 工作樹、單獨配音／時間軸／混音／渲染／QA、佇列與日誌、回滾。',
  ] },
];

export function stepView(s, go) {
  return h('div.panel.panel-body.col', { style: { gap: '8px' } },
    h('div.row', icon(s.icon), h('span.headline.grow', t(s.title)), s.go && go ? btn(t('前往'), { small: true, kind: 'plain', icon: 'external', onClick: () => go(s.go) }) : null),
    s.body.map((p) => h('div.callout', t(p))));
}

export default {
  id: 'guide', title: '使用教學', icon: 'info',
  async render(ctx) {
    ctx.toolbar(t('使用教學'), t('第一次使用請依序完成 1–4'), [btn(t('重新顯示快速導覽'), { small: true, onClick: () => showWelcome(ctx.go, true) })]);
    let version = '';
    if (hasTauri) { try { version = (await call('app_info')).version; } catch {} }
    mount(ctx.content, h('div.page.narrow',
      h('div.banner.info', icon('info'), h('div.grow',
        h('div', { style: { fontWeight: 600 } }, t('Pikara Science Studio {v}', { v: version ? 'v' + version : '' })),
        h('div.muted', t('完整的圖文教學在 docs/TUTORIAL.md，常見問題在 docs/FAQ.md（GitHub 倉庫）。')))),
      STEPS.map((s) => stepView(s, ctx.go)),
      h('div.panel.panel-body.col', { style: { gap: '8px' } },
        h('div.headline', t('常見問題')),
        faq('製作要多久？', '約 2 分鐘的影片，AI 動畫＋兩個平台版本，在 RTX 4050 筆電上約 1–2 小時；大部分時間是 Claude 撰寫與檢查、配音和渲染。'),
        faq('會花多少錢？', '訂閱模式使用你的 Claude 訂閱用量，Studio 不額外收費；畫面上的金額是 Claude Code 回報的模型等價估算，不是扣款。API 付費模式才會依用量計費，且必須設定每次上限。'),
        faq('出現「額度暫停」怎麼辦？', '代表 Claude 訂閱用量暫時用完。等額度恢復後按「繼續」，會從同一步接著做；Studio 不會自動改用付費方式。'),
        faq('出現「需要手動合併」？', '成品已經放到專案資料夾；只是原始碼（旁白、動畫程式）與你在製作期間的其他修改衝突。打開進階模式，在「提示詞」頁或用 git 合併分支 studio/auto/…。'),
        faq('電腦會睡眠嗎？', '佇列有工作時 Studio 會要求 Windows 保持喚醒；長時間無人值守建議把 Windows 睡眠設為「永不」，並接上電源。'))));
  },
};

function faq(q, a) { return h('details', h('summary.callout', { style: { fontWeight: 600, cursor: 'default' } }, t(q)), h('div.callout.muted', { style: { margin: '6px 0 4px 16px' } }, t(a))); }

/** First launch (or on demand): a short walkthrough sheet. */
export function showWelcome(go, force = false) {
  if (!force && localStorage.getItem(SEEN_KEY)) return;
  let i = 0;
  const body = h('div.col');
  const quick = [STEPS[0], STEPS[1], STEPS[2], STEPS[3]];
  const paint = () => mount(body,
    h('div.caption.muted', t('快速導覽 {a}/{b}', { a: i + 1, b: quick.length })),
    stepView(quick[i], null),
    h('div.row', h('div.grow'),
      i > 0 ? btn(t('上一步'), { small: true, onClick: () => { i--; paint(); } }) : null,
      i < quick.length - 1 ? btn(t('下一步'), { small: true, kind: 'primary', onClick: () => { i++; paint(); } }) : null));
  paint();
  sheet({
    title: t('歡迎使用 Pikara Science Studio'),
    body: [h('div.callout', t('輸入一個主題，Studio 會自動完成研究、劇本、動畫、配音、字幕、渲染、檢查與封面。先完成下面 4 個步驟：')), body],
    actions: [
      { label: t('查看完整教學'), onClick: () => { localStorage.setItem(SEEN_KEY, '1'); go('guide'); } },
      { label: t('開始使用'), kind: 'primary', onClick: () => { localStorage.setItem(SEEN_KEY, '1'); go(store.projects && store.projects.length ? 'auto' : 'projects'); } },
    ],
    onClose: () => localStorage.setItem(SEEN_KEY, '1'),
  });
}
