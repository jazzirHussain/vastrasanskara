import { DOC_TYPES, PREFIX_FIELD, formatDocumentNumber } from '@vs/shared/billing.js';
import { financialYear, istDate, istTime } from '@vs/shared/fy.js';
import { IMPORT_KINDS } from '@vs/shared';
import { clock } from '../../clock.js';
import { lastBackup } from '../../core/backup/backup.js';
import { businessRule } from '../../core/errors.js';
import { peekNextNumber } from '../../core/numbering.js';
import { getAdapter } from '../../core/notify/adapters/registry.js';
import { renderEmail } from '../../core/notify/emailLayout.js';
import { logger } from '../../logger.js';
import { latestIntegrityCheck } from '../billing/service.js';
import { getBranch } from '../branches/service.js';
import { garmentTypesWithoutItem } from '../catalog/service.js';
import { importSummary } from '../imports/service.js';
import { readSettings, saveSettings } from '../settings/service.js';
import { listUsers } from '../users/service.js';

const BACKUP_FRESH_MS = 7 * 60 * 60 * 1000;

const check = (key, label, status, detail, link = null) => ({ key, label, status, detail, link });

function businessCheck(branch) {
  const required = [
    ['Legal name', branch.legalName],
    ['GSTIN', branch.gstin],
    ['Address', branch.address?.line1],
    ['City', branch.address?.city],
    ['PIN code', branch.address?.pincode],
    ['Phone', branch.phone],
  ];
  const missing = required.filter(([, value]) => !value).map(([label]) => label);
  const label = 'Business details on bills';
  if (missing.length) return check('business', label, 'todo', `Missing: ${missing.join(', ')}`, '/settings');
  if (!branch.logoKey) return check('business', label, 'warning', 'Add your logo so it shows on bills', '/settings');
  return check('business', label, 'done', 'All set', '/settings');
}

/** Each GST series this year: its prefix, the next number it will give and whether it has started. */
async function numbering(branchId, branch, settings, fyCode) {
  const types = await Promise.all(
    DOC_TYPES.map(async (type) => {
      const start = settings.numberSeries[`${type}:${fyCode}`] ?? 1;
      const { next, used } = await peekNextNumber(branchId, type, fyCode, start);
      return { type, prefix: branch.prefixes[PREFIX_FIELD[type]], start, next, used };
    }),
  );
  return { fy: fyCode, types };
}

function numbersCheck(settings, fyCode, series) {
  const invoice = series.types.find((t) => t.type === 'invoice');
  const confirmed = settings.goLive.numbersConfirmedFy === fyCode;
  return check(
    'numbers',
    'Bill numbers',
    confirmed ? 'done' : 'todo',
    confirmed ? `Next bill: ${formatDocumentNumber(invoice.prefix, fyCode, invoice.next)}` : 'Say where this year’s bill numbers start',
    '/go-live#numbers',
  );
}

async function priceListCheck(branchId, settings) {
  const missing = await garmentTypesWithoutItem(branchId);
  const labels = missing.map((key) => settings.garmentTypes.find((t) => t.key === key)?.label ?? key);
  return missing.length
    ? check('price_list', 'Price list', 'todo', `No price for: ${labels.join(', ')}`, '/catalog')
    : check('price_list', 'Price list', 'done', 'Every garment type has a price', '/catalog');
}

async function staffCheck(branchId) {
  const active = (await listUsers(branchId)).filter((u) => u.active);
  const has = (role) => active.some((u) => u.roles.includes(role));
  const missing = [!has('operations') && 'front-office (operations)', !has('designer') && 'designer'].filter(Boolean);
  return missing.length
    ? check('staff', 'Staff accounts', 'todo', `Add at least one ${missing.join(' and one ')} user`, '/users')
    : check('staff', 'Staff accounts', 'done', `${active.length} people can sign in`, '/users');
}

async function importsCheck(branchId) {
  const summary = await importSummary(branchId);
  const label = 'Old records brought in';
  const customers = summary.customers;
  if (customers.lastRun?.status !== 'done' && customers.added === 0) {
    return check('imports', label, 'todo', 'Bring in your customers first', '/imports');
  }
  const notRun = IMPORT_KINDS.filter((k) => k.kind !== 'customers' && !summary[k.kind].lastRun).map((k) => k.label);
  return notRun.length
    ? check('imports', label, 'warning', `Not brought in: ${notRun.join(', ')}`, '/imports')
    : check('imports', label, 'done', 'All kinds brought in', '/imports');
}

function emailCheck(settings) {
  return settings.goLive.testEmailAt
    ? check('email', 'Email works', 'done', 'A test email was sent')
    : check('email', 'Email works', 'todo', 'Send yourself a test email');
}

async function backupCheck() {
  const last = await lastBackup();
  if (!last) return check('backup', 'Backups', 'todo', 'The first backup runs within 6 hours of going online');
  const when = `${istDate(last.at)} ${istTime(last.at)}`;
  return clock.now().getTime() - last.at.getTime() <= BACKUP_FRESH_MS
    ? check('backup', 'Backups', 'done', `Last backup ${when}`)
    : check('backup', 'Backups', 'warning', `The last backup was at ${when}; backups run every 6 hours`);
}

async function recordsCheck(branchId) {
  const run = await latestIntegrityCheck(branchId);
  const label = 'Records check';
  if (run?.status === 'done' && run.result?.ok) return check('records', label, 'done', 'Records checked and in order', '/accounts');
  if (run?.status === 'done') return check('records', label, 'todo', 'The last check found problems', '/accounts');
  return check('records', label, 'todo', 'Run “Check records” once', '/accounts');
}

/** The eight things to finish before staff start using the system, in order. */
export async function goLiveChecklist(branchId) {
  const fyCode = financialYear(clock.now()).code;
  const [branch, settings] = await Promise.all([getBranch(branchId), readSettings(branchId)]);
  const series = await numbering(branchId, branch, settings, fyCode);
  const checks = await Promise.all([
    businessCheck(branch),
    numbersCheck(settings, fyCode, series),
    priceListCheck(branchId, settings),
    staffCheck(branchId),
    importsCheck(branchId),
    emailCheck(settings),
    backupCheck(),
    recordsCheck(branchId),
  ]);
  return {
    checks,
    done: checks.filter((c) => c.status === 'done').length,
    total: checks.length,
    liveSince: settings.goLive.liveSince,
    numbering: series,
  };
}

/**
 * Sets where each GST series starts this year: the old book's last number + 1 (0 = this is the
 * first). A series that has already given out a number refuses a new start (SERIES_IN_USE).
 */
export async function confirmNumbers(branchId, { series }, actor) {
  const fyCode = financialYear(clock.now()).code;
  const settings = await readSettings(branchId);
  const numberSeries = { ...settings.numberSeries };
  for (const type of DOC_TYPES) numberSeries[`${type}:${fyCode}`] = series[type] + 1;
  await saveSettings(branchId, { numberSeries, goLive: { ...settings.goLive, numbersConfirmedFy: fyCode } }, actor);
  return goLiveChecklist(branchId);
}

/** Emails the signed-in admin to prove email works; remembers when it did. */
export async function sendTestEmail(branchId, actor) {
  const [branch, users] = await Promise.all([getBranch(branchId), listUsers(branchId)]);
  const me = users.find((u) => String(u._id) === String(actor.userId));
  const adapter = getAdapter('email');
  const subject = 'Your boutique system can send email';
  const body = 'This is a test from the go-live checklist. Bills, receipts and reminders will be sent the same way.';
  try {
    if (!adapter || !me) throw new Error('no email adapter or user');
    await adapter.send({
      to: me.email, ...renderEmail({ branch, subject, body }), subject, attachments: [], event: 'system.test_email', vars: {}, branchId,
    });
  } catch (err) {
    // The provider's message can quote the address; log only the kind of failure.
    logger.warn({ err: { name: err.name } }, 'go-live test email failed');
    throw businessRule('EMAIL_NOT_SENT', 'The email could not be sent. Check the email set-up step in the go-live guide.');
  }
  const settings = await readSettings(branchId);
  await saveSettings(branchId, { goLive: { ...settings.goLive, testEmailAt: clock.now().toISOString() } }, actor);
  return goLiveChecklist(branchId);
}

/** Records the day staff started using the system (once). */
export async function markLive(branchId, actor) {
  const settings = await readSettings(branchId);
  if (!settings.goLive.liveSince) {
    await saveSettings(branchId, { goLive: { ...settings.goLive, liveSince: istDate(clock.now()) } }, actor, { action: 'go_live' });
  }
  return goLiveChecklist(branchId);
}
