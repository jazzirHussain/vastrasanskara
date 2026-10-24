// Production notification events. Imported by production/service.js, so both the API and the
// worker define them.
import { defineEvent, registerRecipientResolver } from '../../core/notify/catalog.js';
import { resolveRecipients } from '../../core/notify/recipients.js';
import { isActiveDesigner } from '../users/service.js';

// The order's designer (data.designerId), while they are an active designer of the branch.
registerRecipientResolver('designer', async ({ branchId, data, session }) =>
  data?.designerId && (await isActiveDesigner(branchId, data.designerId))
    ? resolveRecipients('user', { data: { userId: data.designerId }, session })
    : [],
);

const STAFF = (subject, body) => ({ in_app: { body }, email: { subject, body } });
const STAFF_CHANNELS = ['in_app', 'email'];

defineEvent('garment.fitting_reached', {
  recipients: ['designer', 'owner'],
  channels: STAFF_CHANNELS,
  templates: STAFF(
    'Ready for a fitting: {garmentNo}',
    '{description} for {customerName} ({garmentNo}) has reached Trials and fittings.',
  ),
});
defineEvent('qc.failed', {
  recipients: ['designer', 'owner'],
  channels: STAFF_CHANNELS,
  templates: STAFF(
    'Quality check failed: {garmentNo}',
    '{description} for {customerName} ({garmentNo}) failed {stage} and goes back to {reworkStage}. {remarks}',
  ),
});
defineEvent('garment.ready_for_pickup', {
  recipients: ['client'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'Your garment is ready for pickup',
      body: 'Hello {customerName},\n\nYour {description} (order {orderNo}) is ready. You can collect it from the boutique.',
    },
  },
});
defineEvent('stage.late_digest', {
  recipients: ['designer'],
  channels: STAFF_CHANNELS,
  templates: STAFF('Garments running late', '{count} of your garments are running late:\n{list}'),
});
defineEvent('pickup.at_risk', {
  recipients: ['owner', 'designer'],
  channels: STAFF_CHANNELS,
  templates: STAFF(
    'Pickup at risk: {orderNo}',
    'Order {orderNo} for {customerName} is due for pickup on {pickupDate}, but these garments are not nearly ready:\n{list}',
  ),
});
defineEvent('vendor.overdue', {
  recipients: ['designer', 'operations'],
  channels: STAFF_CHANNELS,
  templates: STAFF('Vendor work overdue', '{count} garments are past their vendor due-back date:\n{list}'),
});
defineEvent('garment.uncollected', {
  recipients: ['operations'],
  channels: STAFF_CHANNELS,
  templates: STAFF('Garments not collected', '{count} garments have been ready for more than {days} days:\n{list}'),
});
