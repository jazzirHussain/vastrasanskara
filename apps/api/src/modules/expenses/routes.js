import { Router } from 'express';
import {
  expenseListQuery,
  expensePatchSchema,
  expenseSchema,
  expenseSummaryQuery,
  expenseVoidSchema,
  payeesQuery,
} from '@vs/shared/schemas/expenses.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { readSettings } from '../settings/service.js';
import { toExpenseJson, toExpenseRowJson } from './json.js';
import {
  createExpense,
  expenseJsonContext,
  getExpense,
  listExpenses,
  monthSummary,
  recentPayees,
  updateExpense,
  voidExpense,
} from './service.js';

const jsonOf = async (branchId, expense) => toExpenseJson(expense, await expenseJsonContext(branchId, expense));

/**
 * Answers 201 for an expense that has committed. If reading it back fails the reply is still a
 * success (id, number, status, version): an error would free the Idempotency-Key and a retry
 * would save the expense twice.
 */
async function respondCommitted(req, res, expense) {
  let body;
  try {
    body = { expense: await jsonOf(req.user.branchId, expense) };
  } catch (err) {
    logger.warn({ err, expenseId: String(expense._id), requestId: req.id }, 'expense saved; reading it back failed');
    body = { expense: { id: String(expense._id), number: expense.number, status: expense.status, version: expense.__v } };
  }
  res.status(201).json(body);
}

/** Expenses: admin and operations; designers have neither permission. */
export function expensesRouter(storage) {
  const router = Router();

  router.post('/', requirePermission('expenses.write'), validate({ body: expenseSchema }), idempotent(), async (req, res) => {
    const expense = await createExpense(req.user.branchId, req.body, actorFrom(req), { storage });
    await respondCommitted(req, res, expense);
  });

  router.get('/', requirePermission('expenses.view'), validate({ query: expenseListQuery }), async (req, res) => {
    const { branchId } = req.user;
    const [{ items, nextCursor }, settings] = await Promise.all([listExpenses(branchId, req.validatedQuery), readSettings(branchId)]);
    res.json({ items: items.map((e) => toExpenseRowJson(e, { categories: settings.expenseCategories })), nextCursor });
  });

  router.get('/summary', requirePermission('expenses.view'), validate({ query: expenseSummaryQuery }), async (req, res) => {
    res.json(await monthSummary(req.user.branchId, req.validatedQuery.month));
  });

  router.get('/payees', requirePermission('expenses.write'), validate({ query: payeesQuery }), async (req, res) => {
    res.json(await recentPayees(req.user.branchId, req.validatedQuery));
  });

  router.get('/:id', requirePermission('expenses.view'), async (req, res) => {
    const { branchId } = req.user;
    res.json({ expense: await jsonOf(branchId, await getExpense(branchId, req.params.id)) });
  });

  router.patch('/:id', requirePermission('expenses.write'), validate({ body: versioned(expensePatchSchema) }), async (req, res) => {
    const { branchId } = req.user;
    const expense = await updateExpense(branchId, req.params.id, req.body, actorFrom(req), { storage });
    res.json({ expense: await jsonOf(branchId, expense) });
  });

  router.post('/:id/void', requirePermission('expenses.write'), validate({ body: versioned(expenseVoidSchema) }), async (req, res) => {
    const { branchId } = req.user;
    const expense = await voidExpense(branchId, req.params.id, req.body, actorFrom(req));
    res.json({ expense: await jsonOf(branchId, expense) });
  });

  return router;
}
