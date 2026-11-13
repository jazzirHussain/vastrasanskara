import { expect, vi } from 'vitest';
import { atIstTime } from '@vs/shared';
import { clock } from '../../src/clock.js';
import { loginAs } from './app.js';

let keys = 0;

/** The smallest valid "new enquiry" body; `overrides` replace top-level fields. */
export const enquiryBody = (overrides = {}) => ({ name: 'Priya Sharma', phone: '98450 12345', ...overrides });

/**
 * Front-office test helpers for `app`. `world()` makes an admin, operations, two designers (Meera,
 * Nila) and a customer (Asha Rao) who agreed to email; `addEnquiry` posts an enquiry with an
 * Idempotency-Key; `book` posts an appointment the same way; `atIst(date, time)` fixes the clock
 * at that IST wall-clock time.
 */
export function frontOfficeHelpers(app) {
  async function world() {
    const admin = await loginAs(app, { roles: ['admin'] });
    const ops = await loginAs(app, { roles: ['operations'] });
    const d1 = await loginAs(app, { roles: ['designer'], name: 'Meera' });
    const d2 = await loginAs(app, { roles: ['designer'], name: 'Nila' });
    const r = await ops.agent.post('/v1/customers').send({
      name: 'Asha Rao',
      phone: '9876543210',
      email: 'asha@example.com',
      consent: { email: true, whatsapp: false, sms: false },
      consentNote: 'Agreed at the counter',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { admin, ops, d1, d2, customer: r.body, branchId: String(admin.user.branchId) };
  }

  const addEnquiry = (who, body = {}, key = `enq${++keys}`) =>
    who.agent.post('/v1/enquiries').set('Idempotency-Key', key).send(enquiryBody(body));

  const book = (who, body, key = `appt${++keys}`) =>
    who.agent.post('/v1/appointments').set('Idempotency-Key', key).send(body);

  /** Fixes "now" at `time` IST on `date` until vi.restoreAllMocks(). */
  const atIst = (date, time) => {
    const at = atIstTime(date, time);
    vi.spyOn(clock, 'now').mockImplementation(() => new Date(at));
    return at;
  };

  return { world, addEnquiry, book, atIst };
}
