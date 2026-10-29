import mongoose from 'mongoose';
import { DEFAULT_SETTINGS, settingsPatchSchema, settingsSchema } from '@vs/shared/schemas/settings.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule } from '../../core/errors.js';
import { holdSeries } from '../../core/numbering.js';
import { parseOrThrow } from '../../core/validate.js';
import { Settings } from './model.js';

// Defaults fill in keys added after a branch's settings were first saved.
const withDefaults = (values) => structuredClone({ ...DEFAULT_SETTINGS, ...values });

/** The branch's settings, creating the defaults on first read. */
export async function getSettings(branchId, session) {
  const doc = await Settings.findOneAndUpdate(
    { branchId },
    { $setOnInsert: { branchId, values: structuredClone(DEFAULT_SETTINGS) } },
    { upsert: true, new: true, session },
  ).lean();
  return withDefaults(doc.values);
}

/** The branch's settings without creating anything (defaults when none are saved). */
export async function readSettings(branchId, session) {
  if (!mongoose.isValidObjectId(branchId)) return withDefaults({});
  const doc = await Settings.findOne({ branchId }).session(session ?? null).lean();
  return withDefaults(doc?.values ?? {});
}

// Once a series has given out a number in a year, moving its start would leave a gap or
// repeat a number, so its start is fixed (removing it would restart it at 1).
async function assertSeriesStartsFixed(branchId, before, after, session) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] === after[key]) continue;
    const [docType, fyCode] = key.split(':');
    if (await holdSeries(branchId, docType, fyCode, session)) {
      throw businessRule('SERIES_IN_USE', 'This number series has already been used this year', { key });
    }
  }
}

/**
 * Replaces the given top-level settings, validates the merged result, and saves it with an
 * audit entry in one transaction.
 */
export function updateSettings(branchId, patch, actor) {
  const changes = parseOrThrow(settingsPatchSchema, patch);
  return withTransaction(async (session) => {
    await getSettings(branchId, session);
    const doc = await Settings.findOne({ branchId }).session(session);
    const before = withDefaults(doc.values);
    const after = parseOrThrow(settingsSchema, { ...before, ...changes });
    await assertSeriesStartsFixed(branchId, before.numberSeries, after.numberSeries, session);

    doc.values = after;
    doc.markModified('values');
    doc.updatedBy = actor.userId;
    await doc.save({ session });
    await recordAudit(
      { branchId, entityType: 'settings', entityId: branchId, action: 'update', before, after, actor },
      session,
    );
    return after;
  });
}
