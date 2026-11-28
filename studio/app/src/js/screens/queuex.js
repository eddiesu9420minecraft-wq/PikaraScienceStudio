// Queue — the job queue: jobs, logs, cancel / retry, unattended settings (one page, no tab bar).
import { t } from '../i18n.js';
import queue from './queue.js';

export default {
  id: 'queue', title: '任務佇列', icon: 'queue',
  async render(ctx) {
    await queue.render({ ...ctx, toolbar: (ti, s, actions) => ctx.toolbar(t('任務佇列'), s, actions) });
  },
};
