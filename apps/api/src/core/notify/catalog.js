import { NotificationRule } from './models.js';

export { registerRecipientResolver } from './recipients.js';

// Which recipient address each channel uses.
export const CHANNEL_ADDRESS = Object.freeze({ email: 'email', whatsapp: 'phone', sms: 'phone', in_app: 'in_app' });

const events = new Map();

export function defineEvent(name, { recipients, channels, fallback = null, templates }) {
  events.set(name, { name, recipients, channels, fallback, templates });
}

export function getEventDefinition(name) {
  const definition = events.get(name);
  if (!definition) throw new Error(`Unknown notification event: ${name}`);
  return definition;
}

/** The branch's rule for an event if one is saved, else the event's defaults. */
export async function getRule(branchId, event, session) {
  const definition = getEventDefinition(event);
  const saved = await NotificationRule.findOne({ branchId, event }).session(session ?? null).lean();
  if (saved) return saved;
  const { recipients, channels, fallback } = definition;
  return { recipients, channels, fallback, enabled: true };
}

const DEFAULT_QUIET = { start: '21:00', end: '09:00' };

/** Client quiet hours per channel. Task 17 replaces this fallback with the settings lookup. */
export async function getQuietHours() {
  return { email: DEFAULT_QUIET, whatsapp: DEFAULT_QUIET, sms: DEFAULT_QUIET, in_app: null };
}

const SYSTEM_TEMPLATES = (subject, body) => ({ in_app: { body }, email: { subject, body } });

defineEvent('auth.password_reset', {
  recipients: ['user'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'Reset your password',
      body: 'Hello {userName},\n\nUse this link to set a new password. It expires in {expiresInMinutes} minutes:\n{resetUrl}\n\nIf you did not ask for this, ignore this email.',
    },
  },
});
defineEvent('system.backup_failed', {
  recipients: ['owner'],
  channels: ['in_app', 'email'],
  templates: SYSTEM_TEMPLATES('Backup failed', 'The scheduled backup failed: {error}'),
});
defineEvent('system.storage_warning', {
  recipients: ['owner'],
  channels: ['in_app', 'email'],
  templates: SYSTEM_TEMPLATES(
    'Database storage is filling up',
    'Database storage is at {percent}% of the plan limit ({usedMb} MB of {limitMb} MB).',
  ),
});
defineEvent('system.job_failed', {
  recipients: ['owner'],
  channels: ['in_app', 'email'],
  templates: SYSTEM_TEMPLATES('Background job failed', 'The background job "{job}" failed: {error}'),
});
