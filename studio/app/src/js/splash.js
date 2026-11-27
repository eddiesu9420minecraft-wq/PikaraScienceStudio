// Splash window (splash.html): the shared Pikara startup screen, vendored from
// CreateYourWorld/crates/pikara-splash. Deliberately tiny — none of the app's modules are loaded here.
import { mountSplash } from '../vendor/pikara-splash/pikara-splash.js';

const theme = ['light', 'dark', 'system'].includes(localStorage.getItem('ui.theme')) ? localStorage.getItem('ui.theme') : 'system';
const cn = localStorage.getItem('ui.lang') === 'zh-CN';

mountSplash(document.getElementById('root'), {
  productName: 'Pikara Science Studio',
  tagline: cn ? '科普视频工作室' : '科普影片工作室',
  byline: '— by pikara™',
  theme,
});
