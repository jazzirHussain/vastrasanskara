import { Notification } from '../models.js';

/** The bell in the app: a message is delivered as soon as it is stored. */
export function createInAppAdapter() {
  return {
    channel: 'in_app',
    provider: 'in_app',
    capabilities: { attachments: false, templatesOnly: false },
    async send({ to, text, event, vars, branchId }) {
      const doc = await Notification.create({
        branchId,
        userId: to,
        event,
        message: text,
        link: vars?.link ?? null,
      });
      return { providerMessageId: String(doc._id), status: 'delivered' };
    },
  };
}
