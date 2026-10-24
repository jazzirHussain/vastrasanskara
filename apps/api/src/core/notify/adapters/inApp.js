import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: String, required: true },
    message: { type: String, required: true },
    link: { type: String, default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const Notification =
  mongoose.models.Notification ?? mongoose.model('Notification', notificationSchema);

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
