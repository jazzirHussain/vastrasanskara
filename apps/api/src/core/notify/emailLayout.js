import { escapeHtml } from './render.js';

/** Wraps a plain-text message body in the branch's simple email layout. */
export function renderEmail({ branch, subject, body }) {
  const signature = [branch.name, branch.phone].filter(Boolean).join(', ');
  const contact = [branch.phone, branch.email].filter(Boolean).map(escapeHtml).join(' · ');

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ee;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:20px 24px;border-bottom:1px solid #eee;font-size:20px;font-weight:bold;color:#7a3b2e;">${escapeHtml(branch.name)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6;">${escapeHtml(body).replace(/\r?\n/g, '<br>')}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#777;">${escapeHtml(branch.name)}${contact ? `<br>${contact}` : ''}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text: `${body}\n\n— ${signature}` };
}
