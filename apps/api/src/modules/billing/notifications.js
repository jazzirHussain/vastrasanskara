// Billing notification events. Imported by billing/service.js and daily.js, so both the API and
// the worker define them. Client messages are plain and friendly and mention only what the
// client owes or paid.
import { defineEvent } from '../../core/notify/catalog.js';

const STAFF = (subject, body) => ({ in_app: { body }, email: { subject, body } });
const STAFF_CHANNELS = ['in_app', 'email'];

defineEvent('order.confirmed', {
  recipients: ['client'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'Thank you, your order {orderNo} is confirmed',
      body: 'Hello {customerName},\n\nThank you for your order {orderNo}. We have received {amount} (receipt {receiptNo}); your receipt is attached.\n\nYour pickup date is {pickupDate}.',
    },
  },
});
defineEvent('invoice.issued', {
  recipients: ['client'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'Your bill {invoiceNo}',
      body: 'Hello {customerName},\n\nYour bill {invoiceNo} for {amount} is attached.\n\nAmount to pay: {balance}. Please pay by {dueDate}.',
    },
  },
});
defineEvent('invoice.overdue', {
  recipients: ['client'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'A friendly reminder about bill {invoiceNo}',
      body: 'Hello {customerName},\n\nA gentle reminder: {balance} is still to be paid on your bill {invoiceNo}, which was due on {dueDate} ({days} days ago).\n\nPlease pay when you can. If you have already paid, thank you, and please ignore this message.',
    },
  },
});
defineEvent('invoice.overdue_digest', {
  recipients: ['operations'],
  channels: STAFF_CHANNELS,
  templates: STAFF('Bills overdue', '{count} bills are overdue, {total} in all:\n{list}'),
});
defineEvent('billing.collections_summary', {
  recipients: ['owner'],
  channels: STAFF_CHANNELS,
  templates: STAFF('Payments received on {day}', 'Payments on {day}: {total} in {count} receipts.\n{byMode}\nRefunds: {refunds}'),
});
