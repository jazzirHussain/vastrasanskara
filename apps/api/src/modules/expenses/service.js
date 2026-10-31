import mongoose from 'mongoose';
import { z } from 'zod';
import { formatExpenseNumber } from '@vs/shared/expenses.js';
import { financialYear, istDate, istDayBounds } from '@vs/shared/fy.js';
import { checkExpenseRules, expenseSchema } from '@vs/shared/schemas/expenses.js';
import { clock } from '../../clock.js';
import { diff } from '../../core/audit/diff.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { nextDocumentNumber } from '../../core/numbering.js';
import { parseOrThrow } from '../../core/validate.js';
import { getBranch } from '../branches/service.js';
import { getCostLinkLabels, resolveCostLink } from '../orders/service.js';
import { assertPeriodOpen, isPeriodLocked } from '../periods/service.js';
import { readSettings } from '../settings/service.js';
import { getUserNames } from '../users/service.js';
import { getVendor } from '../vendors/service.js';
import { Expense } from './model.js';

export { expenseCostForGarments } from './costing.js';
export {
  expenseCostTotal,
  expenseTotalsByCategory,
  inputTaxSummary,
  listExpenses,
  monthSummary,
  recentPayees,
} from './queries.js';

const fieldError = (path, message) => validationError([{ path, message }]);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The business fields of an expense, as audited.
function auditView(expense) {
  return {
    number: expense.number,
    date: expense.date,
    category: expense.category,
    note: expense.note,
    payee: {
      vendorId: expense.payee.vendorId ?? null,
      name: expense.payee.name,
      gstin: expense.payee.gstin ?? null,
      stateCode: expense.payee.stateCode ?? null,
    },
    total: expense.total,
    mode: expense.mode,
    reference: expense.reference,
    gst: expense.gst ?? null,
    attachments: (expense.attachments ?? []).map((a) => a.key),
    link: expense.link ?? null,
    status: expense.status,
    void: expense.void ?? null,
  };
}

/**
 * Checks bill photos before saving: each key must be an expense_bill upload of this branch and
 * be in storage. Answers the attachments with the stored type and size.
 */
async function checkAttachments(branchId, storage, attachments, known = new Set()) {
  if (!attachments.some((a) => !known.has(a.key))) return attachments;
  if (!storage) throw new Error('Saving an expense needs storage to check bill photos');
  const pattern = new RegExp(
    `^${escapeRegex(String(branchId))}/expense_bill/\\d{4}/[0-9a-f-]{36}\\.(jpg|png|webp|heic|pdf)$`,
  );
  attachments.forEach((a, i) => {
    if (!known.has(a.key) && !pattern.test(a.key)) throw fieldError(`attachments.${i}.key`, 'Not a bill photo upload');
  });
  return Promise.all(
    attachments.map(async (a, index) => {
      if (known.has(a.key)) return a;
      const head = await storage.headObject(a.key);
      if (!head) throw new AppError(400, 'ATTACHMENT_NOT_UPLOADED', 'A photo has not finished uploading', { index });
      return { key: a.key, name: a.name, contentType: head.contentType, size: head.size };
    }),
  );
}

/** The category, which must exist in settings and be shown; 400 on `category` otherwise. */
function assertCategoryUsable(settings, key) {
  const category = settings.expenseCategories.find((c) => c.key === key);
  if (!category?.active) throw fieldError('category', 'Choose a category');
}

/**
 * Who was paid, as stored: a vendor's details are copied from the vendor (an input GSTIN is
 * ignored); a typed payee keeps its name and GSTIN, its state coming from the GSTIN when not given.
 */
async function payeeFor(branchId, payee, session) {
  if (payee.vendorId) {
    const vendor = await getVendor(branchId, payee.vendorId, session);
    if (!vendor?.active) throw fieldError('payee.vendorId', 'Choose one of your vendors');
    return {
      vendorId: vendor._id,
      name: vendor.name,
      searchName: vendor.name.toLowerCase(),
      gstin: vendor.gstin ?? null,
      stateCode: vendor.stateCode ?? null,
    };
  }
  const gstin = payee.gstin ?? null;
  return {
    vendorId: null,
    name: payee.name,
    searchName: payee.name.toLowerCase(),
    gstin,
    stateCode: payee.stateCode ?? (gstin ? gstin.slice(0, 2) : null),
  };
}

async function insertExpense(branchId, input, actor, { attachments, source, sourceRef }, session) {
  const now = clock.now();
  const { date } = input;
  if (date > istDate(now)) throw businessRule('EXPENSE_DATE_IN_FUTURE', 'The date cannot be in the future');
  await assertPeriodOpen(branchId, date, session);

  const settings = await readSettings(branchId, session);
  assertCategoryUsable(settings, input.category);

  const payee = await payeeFor(branchId, input.payee, session);
  if (input.gst && !payee.gstin) throw fieldError('payee.gstin', "A GST bill shows the supplier's GSTIN");
  const gst = input.gst ? { ...input.gst, interState: input.gst.igst > 0 } : null;

  // Checked before a number is taken, so a bad link leaves no gap.
  const link = input.link ? await resolveCostLink(branchId, input.link, session) : null;

  const dayStart = istDayBounds(date).start;
  const fyCode = financialYear(dayStart).code;
  const branch = await getBranch(branchId, session);
  const { number: n } = await nextDocumentNumber(
    { branchId, docType: 'expense', now: dayStart, start: settings.numberSeries[`expense:${fyCode}`] ?? 1 },
    session,
  );

  const [expense] = await Expense.create(
    [
      {
        branchId,
        number: formatExpenseNumber(branch.prefixes.expense, fyCode, n),
        fyCode,
        date,
        month: date.slice(0, 7),
        category: input.category,
        note: input.note,
        payee,
        total: input.total,
        mode: input.mode,
        reference: input.reference,
        gst,
        attachments,
        link,
        status: 'active',
        void: null,
        source,
        sourceRef,
        createdBy: actor.userId ?? null,
        updatedBy: actor.userId ?? null,
      },
    ],
    { session },
  );
  await recordAudit(
    { branchId, entityType: 'expense', entityId: expense._id, action: 'create', before: null, after: auditView(expense), actor },
    session,
  );
  return expense.toObject();
}

/**
 * Records money paid out, with the next gapless number of the expense date's financial year.
 * Bill photos are checked against storage first. Runs in the caller's transaction when `session`
 * is given (M6 stock receiving, `source: 'purchase'`), else in its own.
 */
export async function createExpense(
  branchId,
  input,
  actor,
  { storage, session, source = 'manual', sourceRef = null } = {},
) {
  const fields = parseOrThrow(expenseSchema, input);
  const attachments = await checkAttachments(branchId, storage, fields.attachments);
  const options = { attachments, source, sourceRef };
  if (session) return insertExpense(branchId, fields, actor, options, session);
  return withTransaction((s) => insertExpense(branchId, fields, actor, options, s));
}

// Merged edits are re-checked with the same cross-field rules as a new expense.
const mergedRules = z.any().superRefine(checkExpenseRules);

const linkInput = (link) => (link ? { kind: link.kind, id: String(link.garmentId ?? link.batchId ?? link.orderId) } : null);

/** A stored expense in the shape of the request body (for merging an edit and re-checking it). */
function inputView(expense) {
  const { gst } = expense;
  return {
    date: expense.date,
    category: expense.category,
    note: expense.note,
    payee: {
      vendorId: expense.payee.vendorId ? String(expense.payee.vendorId) : null,
      name: expense.payee.name,
      gstin: expense.payee.gstin ?? null,
      stateCode: expense.payee.stateCode ?? null,
    },
    total: expense.total,
    mode: expense.mode,
    reference: expense.reference,
    gst: gst
      ? {
          billNo: gst.billNo, billDate: gst.billDate, rateBp: gst.rateBp ?? null, taxable: gst.taxable,
          cgst: gst.cgst, sgst: gst.sgst, igst: gst.igst, itcEligible: gst.itcEligible,
        }
      : null,
    attachments: (expense.attachments ?? []).map((a) => ({ key: a.key, name: a.name })),
    link: linkInput(expense.link),
  };
}

/**
 * Whether an edit's payee is the stored one: the same vendor (its snapshot is kept, even when the
 * vendor is now inactive), or the same typed name, GSTIN and state.
 */
function samePayee(stored, input) {
  if (input.vendorId || stored.vendorId) return String(input.vendorId ?? '') === String(stored.vendorId ?? '');
  const gstin = input.gstin ?? null;
  const stateCode = input.stateCode ?? (gstin ? gstin.slice(0, 2) : null);
  return input.name === stored.name && gstin === (stored.gstin ?? null) && stateCode === (stored.stateCode ?? null);
}

function sameLink(stored, input) {
  const a = linkInput(stored);
  if (!a || !input) return !a && !input;
  return a.kind === input.kind && a.id === String(input.id);
}

/** Loads an expense for a write at `version`: 404, or 409 on a stale version. */
async function loadForWrite(branchId, id, version, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const expense = await Expense.findOne({ _id: id, branchId }).session(session);
  if (!expense) throw notFound();
  if (expense.__v !== version) throw conflict();
  return expense;
}

/**
 * Edits an expense at `version`. Only the fields sent change; the merged expense is re-checked as
 * a new one would be. Its month must be open, and so must the month it moves to (within the same
 * financial year, so the number stays in its series). New bill photos are checked against storage
 * first. Audited only when something changed.
 */
export async function updateExpense(branchId, id, { version, patch }, actor, { storage } = {}) {
  let checked = null;
  if (patch.attachments) {
    const current = await getExpense(branchId, id);
    const known = new Set((current.attachments ?? []).map((a) => a.key));
    checked = await checkAttachments(branchId, storage, patch.attachments, known);
  }

  return withTransaction(async (session) => {
    const now = clock.now();
    const expense = await loadForWrite(branchId, id, version, session);
    if (expense.status === 'voided') throw businessRule('EXPENSE_VOIDED', 'This expense was voided and cannot be changed');
    await assertPeriodOpen(branchId, expense.date, session);

    if (patch.date !== undefined && patch.date !== expense.date) {
      if (patch.date > istDate(now)) throw businessRule('EXPENSE_DATE_IN_FUTURE', 'The date cannot be in the future');
      if (financialYear(istDayBounds(patch.date).start).code !== expense.fyCode) {
        throw businessRule('EXPENSE_FY_CHANGE', 'An expense cannot move to another financial year');
      }
      await assertPeriodOpen(branchId, patch.date, session);
    }

    const stored = expense.toObject();
    const merged = parseOrThrow(mergedRules, { ...inputView(stored), ...patch });

    if (merged.category !== stored.category) assertCategoryUsable(await readSettings(branchId, session), merged.category);

    const payee = samePayee(stored.payee, merged.payee) ? stored.payee : await payeeFor(branchId, merged.payee, session);
    if (merged.gst && !payee.gstin) throw fieldError('payee.gstin', "A GST bill shows the supplier's GSTIN");

    let { link } = stored;
    if (!sameLink(stored.link, merged.link)) {
      link = merged.link ? await resolveCostLink(branchId, merged.link, session) : null;
    }

    let attachments = stored.attachments;
    if (checked) {
      const byKey = new Map(stored.attachments.map((a) => [a.key, a]));
      attachments = checked.map((a) => {
        const meta = byKey.get(a.key) ?? (a.contentType ? a : null);
        // On the expense when checked but gone now: someone saved in between.
        if (!meta) throw conflict();
        return { key: a.key, name: a.name, contentType: meta.contentType, size: meta.size };
      });
    }

    const before = auditView(stored);
    const changes = {
      date: merged.date,
      month: merged.date.slice(0, 7),
      category: merged.category,
      note: merged.note,
      payee,
      total: merged.total,
      mode: merged.mode,
      reference: merged.reference,
      gst: merged.gst ? { ...merged.gst, interState: merged.gst.igst > 0 } : null,
      attachments,
      link,
    };
    // Nothing changed (e.g. Save tapped twice): keep the version, write nothing.
    const after = auditView({ ...stored, ...changes });
    if (!diff(before, after).length) return stored;

    expense.set({ ...changes, updatedBy: actor.userId ?? null });
    expense.increment();
    await expense.save({ session });
    await recordAudit(
      { branchId, entityType: 'expense', entityId: expense._id, action: 'update', before, after: auditView(expense.toObject()), actor },
      session,
    );
    return expense.toObject();
  });
}

/** Voids an expense at `version` with a reason. Permanent; its month must be open. */
export async function voidExpense(branchId, id, { version, patch: { reason } }, actor) {
  return withTransaction(async (session) => {
    const now = clock.now();
    const expense = await loadForWrite(branchId, id, version, session);
    if (expense.status === 'voided') throw businessRule('ALREADY_VOIDED', 'This expense is already voided');
    await assertPeriodOpen(branchId, expense.date, session);
    const before = auditView(expense.toObject());
    expense.set({ status: 'voided', void: { reason, at: now, by: actor.userId }, updatedBy: actor.userId ?? null });
    expense.increment();
    await expense.save({ session });
    await recordAudit(
      { branchId, entityType: 'expense', entityId: expense._id, action: 'void', before, after: auditView(expense.toObject()), actor },
      session,
    );
    return expense.toObject();
  });
}

/** One of the branch's expenses, or 404. */
export async function getExpense(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const expense = await Expense.findOne({ _id: id, branchId }).lean();
  if (!expense) throw notFound();
  return expense;
}

/**
 * What toExpenseJson needs besides the expense: category labels, user names, link labels and
 * whether the expense's month is locked.
 */
export async function expenseJsonContext(branchId, expense) {
  const [settings, names, monthLocked, linkLabels] = await Promise.all([
    readSettings(branchId),
    getUserNames([expense.createdBy, expense.void?.by]),
    isPeriodLocked(branchId, expense.month),
    getCostLinkLabels(branchId, expense.link ? [expense.link] : []),
  ]);
  return { categories: settings.expenseCategories, names, linkLabels, monthLocked };
}

/**
 * Whether the user may read a bill photo: one on an expense of their branch needs expenses.view;
 * one not on any expense yet (the form's preview) needs expenses.write.
 */
export async function canReadExpenseFile(user, key) {
  const saved = await Expense.exists({ branchId: user.branchId, 'attachments.key': key });
  return user.permissions.has(saved ? 'expenses.view' : 'expenses.write');
}
