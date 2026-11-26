// Queue — the job queue (v0.2 queue screen: jobs, logs, cancel / retry, unattended settings).
import { t } from '../i18n.js';
import { tabbed } from '../v03/common.js';
import queue from './queue.js';

export default {
  id: 'queue', title: '任務佇列', icon: 'queue',
  async render(ctx) {
    await tabbed(ctx, t('任務佇列'), [{ id: 'jobs', title: '工作', screen: queue }]);
  },
};
