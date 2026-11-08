// Stock notification events. Imported by ledger.js, so both the API and the worker define them.
import { defineEvent } from '../../core/notify/catalog.js';

defineEvent('stock.low', {
  recipients: ['operations'],
  channels: ['in_app', 'email'],
  templates: {
    in_app: { body: '{name} is running low: {free} free (reorder at {reorderLevel}).' },
    email: {
      subject: 'Running low: {name}',
      body: '{name} is running low: {free} free (reorder at {reorderLevel}).',
    },
  },
});
