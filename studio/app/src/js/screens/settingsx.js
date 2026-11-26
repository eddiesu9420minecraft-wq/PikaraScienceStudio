// Settings section: 一般（含開發者設定開關）／硬體與效能.
import { t } from '../i18n.js';
import { tabbed } from '../v03/common.js';
import general from './settings.js';
import hardware from './hardware.js';

export default {
  id: 'settings', title: '設定', icon: 'gear',
  async render(ctx) {
    await tabbed(ctx, t('設定'), [
      { id: 'general', title: '一般', screen: general },
      { id: 'hardware', title: '硬體與效能', screen: hardware },
    ]);
  },
};
