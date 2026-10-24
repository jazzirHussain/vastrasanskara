import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

/** Development email: each message is written to `dir` as an .eml file you can open. */
export function createFileEmailAdapter({ dir, from }) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    channel: 'email',
    provider: 'file',
    capabilities: { attachments: true, templatesOnly: false },
    async send({ to, subject, text, html, attachments = [] }) {
      const info = await transport.sendMail({ from, to, subject, text, html, attachments });
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(path.join(dir, `${stamp}-${randomUUID().slice(0, 8)}.eml`), info.message);
      return { providerMessageId: info.messageId, status: 'sent' };
    },
  };
}
