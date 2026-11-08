import mongoose from 'mongoose';
import { listCostingGarments } from '../orders/service.js';
import { listChargeableEvents } from '../production/service.js';
import { CreditNote, Invoice } from './model.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));

/** The find filter of an order's issued bills (exported for the index test; order_docs). */
export const orderInvoicesFilter = (orderId) => ({ orderId: oid(orderId), type: 'invoice', status: 'issued' });

/** The find filter of the issued credit notes of the bills (exported for the index test; credit_notes). */
export const creditNotesFilter = (invoiceIds) => ({ invoiceId: { $in: invoiceIds.map(oid) }, type: 'credit_note', status: 'issued' });

/**
 * What the order has been billed, line by line, for costing: each line of its issued bills with
 * its taxable value less what issued credit notes took off that line, and the garment it belongs
 * to (a garment line's own garment, a charge line's garment through its stage event, else null).
 * Cancelled bills count nothing. Answers [{ invoiceId, number, lineKey, garmentId | null, taxable }].
 */
export async function orderRevenueLines(branchId, orderId, session) {
  const invoices = await Invoice.find({ ...orderInvoicesFilter(orderId), branchId: oid(branchId) }, { number: 1, snapshot: 1 })
    .sort({ date: 1, _id: 1 })
    .session(session ?? null)
    .lean();
  if (!invoices.length) return [];

  const notes = await CreditNote.find(creditNotesFilter(invoices.map((i) => i._id)), { invoiceId: 1, lineCredits: 1 })
    .session(session ?? null)
    .lean();
  const credited = new Map();
  for (const note of notes) {
    for (const c of note.lineCredits ?? []) {
      const key = `${note.invoiceId}:${c.key}`;
      credited.set(key, (credited.get(key) ?? 0) + c.taxable);
    }
  }

  const lines = invoices.flatMap((inv) => (inv.snapshot?.lines ?? []).map((l) => ({ inv, l })));
  let eventGarment = new Map();
  if (lines.some(({ l }) => l.stageEventId && !l.garmentId)) {
    const garments = await listCostingGarments(branchId, { orderIds: [String(orderId)] }, session);
    const events = await listChargeableEvents(branchId, garments.map((g) => oid(g.id)), session);
    eventGarment = new Map(events.map((e) => [String(e.id), String(e.garmentId)]));
  }

  return lines.map(({ inv, l }) => ({
    invoiceId: String(inv._id),
    number: inv.number,
    lineKey: l.key,
    garmentId: l.garmentId ? String(l.garmentId) : (l.stageEventId && eventGarment.get(String(l.stageEventId))) || null,
    taxable: (l.taxable ?? 0) - (credited.get(`${inv._id}:${l.key}`) ?? 0),
  }));
}
