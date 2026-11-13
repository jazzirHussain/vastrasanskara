import { Router } from 'express';
import { z } from 'zod';
import { customerPatchSchema, customerSchema } from '@vs/shared/schemas/customers.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { validate, versioned } from '../../core/validate.js';
import { toCustomerJson } from './json.js';
import { createCustomer, findCustomers, getCustomer, updateCustomer } from './service.js';

const listQuery = z.strictObject({
  q: z.string().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function customersRouter() {
  const router = Router();

  router.get('/', requirePermission('customers.read'), validate({ query: listQuery }), async (req, res) => {
    const { items, nextCursor } = await findCustomers(req.user.branchId, req.validatedQuery);
    res.json({ items: items.map(toCustomerJson), nextCursor });
  });

  router.post('/', requirePermission('customers.write'), validate({ body: customerSchema }), async (req, res) => {
    res.status(201).json(toCustomerJson(await createCustomer(req.user.branchId, req.body, actorFrom(req))));
  });

  router.get('/:id', requirePermission('customers.read'), async (req, res) => {
    res.json(toCustomerJson(await getCustomer(req.user.branchId, req.params.id)));
  });

  router.patch(
    '/:id',
    requirePermission('customers.write'),
    validate({ body: versioned(customerPatchSchema) }),
    async (req, res) => {
      res.json(toCustomerJson(await updateCustomer(req.user.branchId, req.params.id, req.body, actorFrom(req))));
    },
  );

  return router;
}
