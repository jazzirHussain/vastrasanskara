import mongoose from 'mongoose';
import { formatExpenseNumber } from '@vs/shared/expenses.js';
import { financialYear, istDate, istDayBounds } from '@vs/shared/fy.js';
import { expenseSchema } from '@vs/shared/schemas/expenses.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, notFound, validationError } from '../../core/errors.js';
import { nextDocumentNumber } from '../../core/numbering.js';
import { parseOrThrow } from '../../core/validate.js';
import { getBranch } from '../branches/service.js';
import { assertPeriodOpen, isPeriodLocked } from '../periods/service.js';
import { readSettings } from '../settings/service.js';
import { getUserNames } from '../users/service.js';
import { getVendor } from '../vendors/service.js';
import { Expense } from './model.js';

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
async function checkAttachments(branchId, storage, attachments) {
  if (!attachments.length) return [];
  if (!storage) throw new Error('createExpense needs storage to check bill photos');
  const pattern = new RegExp(
    `^${escapeRegex(String(branchId))}/expense_bill/\\d{4}/[0-9a-f-]{36}\\.(jpg|png|webp|heic|pdf)$`,
  );
  attachments.forEach((a, i) => {
    if (!pattern.test(a.key)) throw fieldError(`attachments.${i}.key`, 'Not a bill photo upload');
  });
  return Promise.all(
    attachments.map(async (a, index) => {
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

  // Task 5 resolves links to a garment, batch or order.
  if (input.link) throw fieldError('link', 'Not available yet');

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
        link: null,
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
  const [settings, names, monthLocked] = await Promise.all([
    readSettings(branchId),
    getUserNames([expense.createdBy, expense.void?.by]),
    isPeriodLocked(branchId, expense.month),
  ]);
  // Task 5 fills link labels from orders/service.js.
  return { categories: settings.expenseCategories, names, linkLabels: new Map(), monthLocked };
}

/**
 * Whether the user may read a bill photo: one on an expense of their branch needs expenses.view;
 * one not on any expense yet (the form's preview) needs expenses.write.
 */
export async function canReadExpenseFile(user, key) {
  const saved = await Expense.exists({ branchId: user.branchId, 'attachments.key': key });
  return user.permissions.has(saved ? 'expenses.view' : 'expenses.write');
}
