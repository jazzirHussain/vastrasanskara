import mongoose from 'mongoose';
import { DEFAULT_SETTINGS, settingsPatchSchema, settingsSchema } from '@vs/shared/schemas/settings.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule } from '../../core/errors.js';
import { holdSeries } from '../../core/numbering.js';
import { parseOrThrow } from '../../core/validate.js';
import { Settings } from './model.js';

// Defaults fill in keys added after a branch's settings were first saved (e.g. expenseCategories,
// required since M5, for settings stored before it).
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

// Expenses keep their category key for good, so a key is never removed (it can be hidden).
// A pure comparison of the two lists: settings never reads expenses.
function assertCategoriesKept(before = [], after = []) {
  const kept = new Set(after.map((c) => c.key));
  const removed = before.find((c) => !kept.has(c.key));
  if (removed) {
    throw businessRule('CATEGORY_REMOVED', 'Categories cannot be removed. Hide them instead.', { key: removed.key });
  }
}

/**
 * Replaces the given top-level settings, validates the merged result, and saves it with an
 * audit entry in one transaction.
 */
export function updateSettings(branchId, patch, actor) {
  return saveSettings(branchId, parseOrThrow(settingsPatchSchema, patch), actor);
}

/**
 * updateSettings for other modules: `changes` may include keys PUT /v1/settings cannot set
 * (goLive); the merged result is still checked in full. `action` names the audit entry.
 */
export function saveSettings(branchId, changes, actor, { action = 'update' } = {}) {
  return withTransaction(async (session) => {
    await getSettings(branchId, session);
    const doc = await Settings.findOne({ branchId }).session(session);
    const before = withDefaults(doc.values);
    const after = parseOrThrow(settingsSchema, { ...before, ...changes });
    assertCategoriesKept(before.expenseCategories, after.expenseCategories);
    await assertSeriesStartsFixed(branchId, before.numberSeries, after.numberSeries, session);

    doc.values = after;
    doc.markModified('values');
    doc.updatedBy = actor.userId;
    await doc.save({ session });
    await recordAudit(
      { branchId, entityType: 'settings', entityId: branchId, action, before, after, actor },
      session,
    );
    return after;
  });
}
