// Enquiry reads: lists and figures. Re-exported by service.js (other modules import that).
//
// M8 dashboard: "follow-ups due" = followUpsDue(today); tile 8 (enquiries: conversion and source)
// = enquiryConversionBySource; tile 6 / tile 1 live in appointments/queries.js.
import mongoose from 'mongoose';
import { paginate } from '../../core/pagination.js';
import { Enquiry } from './model.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VIEW_SORT = { follow_ups: ['followUpDate', 1] };
const STATUS_VIEWS = new Set(['new', 'appointment_booked', 'converted', 'lost']);

/** The filter of an enquiry list view (exported for the index test). */
export function enquiryListFilter(branchId, { view = 'open', q, source, from, to } = {}, { today }) {
  const filter = { branchId: new mongoose.Types.ObjectId(String(branchId)) };
  if (source) filter.source = source;
  if (from || to) filter.enquiryDate = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (view === 'follow_ups') Object.assign(filter, { isOpen: true, followUpDate: { $lte: today } });
  else if (view === 'open') filter.isOpen = true;
  else if (STATUS_VIEWS.has(view)) filter.status = view;
  const term = q?.trim();
  if (term && /^[\d\s+-]+$/.test(term) && /\d/.test(term)) {
    filter.phone = { $regex: escapeRegex(term.replace(/\D/g, '')) };
  } else if (term) {
    filter.searchName = { $regex: `^${escapeRegex(term.toLowerCase())}` };
  }
  return filter;
}

/** One page of a list view: follow-ups oldest call-back first, the others newest enquiry first. `source` and
 * `from`/`to` (on `enquiryDate`) narrow it (the M8 enquiry sources drill-down). */
export function listEnquiries(branchId, { view = 'open', q, source, from, to, cursor, limit } = {}, { today }) {
  const sort = VIEW_SORT[view] ?? ['enquiryDate', -1];
  return paginate(Enquiry, enquiryListFilter(branchId, { view, q, source, from, to }, { today }), { sort, cursor, limit });
}

/** How many open enquiries are due a call today or earlier, and how many of them are overdue. */
export async function followUpsDue(branchId, today) {
  const [row] = await Enquiry.aggregate([
    { $match: enquiryListFilter(branchId, { view: 'follow_ups' }, { today }) },
    { $group: { _id: null, count: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$followUpDate', today] }, 1, 0] } } } },
  ]);
  return { count: row?.count ?? 0, overdue: row?.overdue ?? 0 };
}

/** Ids of the branch's enquiries converted to this customer (for the customer's appointments). */
export async function enquiryIdsForCustomer(branchId, customerId) {
  if (!mongoose.isValidObjectId(customerId)) return [];
  const rows = await Enquiry.find(
    { branchId, convertedCustomerId: { $eq: new mongoose.Types.ObjectId(String(customerId)), $type: 'objectId' } },
    { _id: 1 },
  ).lean();
  return rows.map((r) => r._id);
}

/** Enquiries captured on IST days from..to (exported for the index test). */
export const conversionMatch = (branchId, { from, to }) => ({
  branchId: new mongoose.Types.ObjectId(String(branchId)),
  enquiryDate: { $gte: from, $lte: to },
});

/** Enquiries captured from..to by how they heard of us: how many converted, were lost, are open. */
export async function enquiryConversionBySource(branchId, { from, to }) {
  const rows = await Enquiry.aggregate([
    { $match: conversionMatch(branchId, { from, to }) },
    {
      $group: {
        _id: '$source',
        total: { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } },
        lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
        open: { $sum: { $cond: ['$isOpen', 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map(({ _id, ...counts }) => ({ source: _id, ...counts }));
}
