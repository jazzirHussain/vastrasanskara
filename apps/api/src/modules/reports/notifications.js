// Report notification events. Imported by runner.js and jobs.js, so the API and the worker both
// define them.
import { defineEvent } from '../../core/notify/catalog.js';

const STAFF = (subject, body) => ({ in_app: { body }, email: { subject, body } });
const STAFF_CHANNELS = ['in_app', 'email'];

defineEvent('reports.gst_pack', {
  recipients: ['owner'],
  channels: STAFF_CHANNELS,
  templates: STAFF(
    'Your GST files for {month}',
    'Your GST files for {month} are ready: GSTR-1 and the GST summary with registers.\nAfter filing, lock {monthShort} in Accounts → Month locks.',
  ),
});

defineEvent('reports.gst_pack_failed', {
  recipients: ['owner'],
  channels: STAFF_CHANNELS,
  templates: STAFF('We could not prepare your GST files for {month}', 'We could not prepare your GST files for {month}. Open Reports to try again.'),
});
