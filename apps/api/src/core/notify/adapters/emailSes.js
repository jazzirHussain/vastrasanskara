import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * Email through Amazon SES (v2 API). nodemailer builds the raw MIME message, so attachments
 * work; the SES MessageId is the provider id that delivery webhooks refer to.
 */
// `storage` is accepted for interface symmetry; deliverDue resolves attachments before send.
export function createSesEmailAdapter({ region, from, storage: _storage }) {
  const transport = nodemailer.createTransport({
    SES: { sesClient: new SESv2Client({ region }), SendEmailCommand },
  });
  return {
    channel: 'email',
    provider: 'ses',
    capabilities: { attachments: true, templatesOnly: false },
    async send({ to, subject, text, html, attachments = [] }) {
      const info = await transport.sendMail({ from, to, subject, text, html, attachments });
      return { providerMessageId: info.response, status: 'sent' };
    },
  };
}
