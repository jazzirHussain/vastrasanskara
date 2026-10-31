import { expect } from 'vitest';
import { Branch } from '../../src/modules/branches/model.js';
import { lockPeriod } from '../../src/modules/periods/service.js';
import { fetchLike, loginAs } from './app.js';
import { today } from './production.js';

let keys = 0;
export const BRANCH_GSTIN = '29ABCDE1234F1Z5';
export const VENDOR_GSTIN = '29AAACV1234K1Z3';

/** The smallest valid "add expense" body; `overrides` replace top-level fields. */
export const expenseBody = (overrides = {}) => ({
  date: today(),
  category: 'rent',
  payee: { name: 'Lakshmi Textiles' },
  total: 118000,
  mode: 'cash',
  ...overrides,
});

/**
 * Expense test helpers for `app`. `world()` makes an admin, operations and a designer, gives the
 * branch state 29 and a GSTIN, and adds a vendor in 29 with a GSTIN and one in 27 without;
 * `upload` puts a small bill photo in (local) storage and answers its key; `add` posts an expense
 * (fields over `expenseBody`) with an Idempotency-Key; `lockMonth` locks a past month.
 */
export function expenseHelpers(app) {
  let admin;

  async function world() {
    admin = await loginAs(app, { roles: ['admin'] });
    const ops = await loginAs(app, { roles: ['operations'] });
    const designer = await loginAs(app, { roles: ['designer'] });
    await Branch.updateOne({}, { gstin: BRANCH_GSTIN, stateCode: '29' });
    const addVendor = async (body) => {
      const r = await admin.agent.post('/v1/vendors').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    };
    const vendor29 = await addVendor({ name: 'Bengaluru Silks', gstin: VENDOR_GSTIN, stateCode: '29' });
    const vendor27 = await addVendor({ name: 'Mumbai Zari', stateCode: '27' });
    return { admin, ops, designer, branchId: String(admin.user.branchId), vendor29, vendor27, storage: app.locals.storage };
  }

  /** Uploads a 3-byte JPEG as a bill photo; answers its key. */
  async function upload(who, { contentType = 'image/jpeg' } = {}) {
    const { body } = await who.agent.post('/v1/files/upload-url').send({ purpose: 'expense_bill', contentType, size: 3 });
    expect(body.key, JSON.stringify(body)).toBeTruthy();
    const put = await fetchLike(app, 'PUT', body.url, Buffer.from('abc'), body.headers);
    expect(put.status).toBe(200);
    return body.key;
  }

  const add = (who, body = {}, key = `e${++keys}`) =>
    who.agent.post('/v1/expenses').set('Idempotency-Key', key).send(expenseBody(body));

  const lockMonth = (month) => lockPeriod(admin.user.branchId, month, { note: '' }, { userId: admin.user._id });

  return { world, upload, add, lockMonth };
}
