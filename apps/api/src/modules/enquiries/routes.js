import { Router } from 'express';
import {
  checkPhoneQuery,
  convertSchema,
  enquiryListQuery,
  enquiryPatchSchema,
  enquirySchema,
  istDate,
  logCallSchema,
  lostSchema,
  reopenSchema,
} from '@vs/shared';
import { clock } from '../../clock.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { toCustomerJson } from '../customers/json.js';
import { getCustomer } from '../customers/service.js';
import { getOrderNumbers } from '../orders/service.js';
import { getUserNames } from '../users/service.js';
import { enquiryUserIds, toEnquiryJson, toEnquiryRowJson } from './json.js';
import {
  checkPhone,
  convertEnquiry,
  createEnquiry,
  followUpsDue,
  getEnquiry,
  listEnquiries,
  logCall,
  markLost,
  reopenEnquiry,
  updateEnquiry,
} from './service.js';

const WRITE = 'enquiries.write';
const today = () => istDate(clock.now());

// The converted customer and order are read here (routes may read orders; the service never does).
async function jsonOf(enquiry) {
  const { branchId, convertedCustomerId, convertedOrderId } = enquiry;
  const [names, customer, orderNos] = await Promise.all([
    getUserNames(enquiryUserIds(enquiry)),
    convertedCustomerId ? getCustomer(branchId, convertedCustomerId).catch(() => null) : null,
    convertedOrderId ? getOrderNumbers(branchId, [convertedOrderId]) : new Map(),
  ]);
  const orderNo = convertedOrderId ? orderNos.get(String(convertedOrderId)) : undefined;
  return toEnquiryJson(enquiry, { names, customer, order: orderNo ? { orderNo } : null });
}

/**
 * Answers 201 for an enquiry that has committed. If reading it back fails the reply is still a
 * success: an error would free the Idempotency-Key and a retry would save the enquiry twice.
 */
async function respondCommitted(req, res, enquiry) {
  let body;
  try {
    body = { enquiry: await jsonOf(enquiry) };
  } catch (err) {
    logger.warn({ err, enquiryId: String(enquiry._id), requestId: req.id }, 'enquiry saved; reading it back failed');
    body = { enquiry: { id: String(enquiry._id), status: enquiry.status, version: enquiry.__v } };
  }
  res.status(201).json(body);
}

/** Enquiries: admin and operations only (designers never see enquiries or budgets). */
export function enquiriesRouter() {
  const router = Router();

  router.get('/', requirePermission(WRITE), validate({ query: enquiryListQuery }), async (req, res) => {
    const day = today();
    const { items, nextCursor } = await listEnquiries(req.user.branchId, req.validatedQuery, { today: day });
    res.json({ items: items.map((e) => toEnquiryRowJson(e, { today: day })), nextCursor });
  });

  router.get('/check-phone', requirePermission(WRITE), validate({ query: checkPhoneQuery }), async (req, res) => {
    res.json(await checkPhone(req.user.branchId, req.validatedQuery.phone));
  });

  router.get('/follow-ups/count', requirePermission(WRITE), async (req, res) => {
    res.json(await followUpsDue(req.user.branchId, today()));
  });

  router.post('/', requirePermission(WRITE), validate({ body: enquirySchema }), idempotent(), async (req, res) => {
    await respondCommitted(req, res, await createEnquiry(req.user.branchId, req.body, actorFrom(req)));
  });

  router.get('/:id', requirePermission(WRITE), async (req, res) => {
    res.json({ enquiry: await jsonOf(await getEnquiry(req.user.branchId, req.params.id)) });
  });

  const write = (path, method, schema, action) =>
    router[method](path, requirePermission(WRITE), validate({ body: versioned(schema) }), async (req, res) => {
      const enquiry = await action(req.user.branchId, req.params.id, req.body, actorFrom(req));
      res.json({ enquiry: await jsonOf(enquiry) });
    });

  write('/:id', 'patch', enquiryPatchSchema, updateEnquiry);
  write('/:id/call', 'post', logCallSchema, logCall);
  write('/:id/lost', 'post', lostSchema, markLost);
  write('/:id/reopen', 'post', reopenSchema, reopenEnquiry);

  // It may create a customer, so it needs the customer permission too.
  router.post('/:id/convert', requirePermission(WRITE, 'customers.write'), validate({ body: versioned(convertSchema) }), async (req, res) => {
    const { enquiry, customer, matched } = await convertEnquiry(req.user.branchId, req.params.id, req.body, actorFrom(req));
    res.json({ enquiry: await jsonOf(enquiry), customer: toCustomerJson(customer), matched });
  });

  return router;
}
