import { readSettings } from '../../modules/settings/service.js';
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

/** Client quiet hours per channel from the branch settings (defaults if none are saved). */
export async function getQuietHours(branchId, session) {
  return (await readSettings(branchId, session)).quietHours;
}

/** Every defined event with its defaults (bootstrap saves them as the branch's rules). */
export function listEvents() {
  return [...events.values()];
}

const SYSTEM_TEMPLATES = (subject, body) => ({ in_app: { body }, email: { subject, body } });

defineEvent('auth.password_reset', {
  recipients: ['user'],
  channels: ['email'],
  templates: {
    email: {
      subject: 'Reset your password',
      body: 'Hello {name},\n\nUse this link to set your password. It expires in {expiresIn}:\n{resetUrl}\n\nIf you did not ask for this, you can ignore this email.',
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
    'Database storage is at {percent}% of the plan limit ({usedMb} MB of {quotaMb} MB).',
  ),
});
defineEvent('system.job_failed', {
  recipients: ['owner'],
  channels: ['in_app', 'email'],
  templates: SYSTEM_TEMPLATES('Background job failed', 'The background job "{job}" failed: {error}'),
});
