// Enquiry reads: lists and figures. Re-exported by service.js (other modules import that).
//
// M8 dashboard: "follow-ups due" = followUpsDue(today); tile 8 (enquiries: conversion and source)
// = enquiryConversionBySource.
import mongoose from 'mongoose';
import { paginate } from '../../core/pagination.js';
import { Enquiry } from './model.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VIEW_SORT = { follow_ups: ['followUpDate', 1] };
const STATUS_VIEWS = new Set(['new', 'appointment_booked', 'converted', 'lost']);

/** The filter of an enquiry list view (exported for the index test). */
export function enquiryListFilter(branchId, { view = 'open', q } = {}, { today }) {
  const filter = { branchId: new mongoose.Types.ObjectId(String(branchId)) };
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

/** One page of a list view: follow-ups oldest call-back first, the others newest enquiry first. */
export function listEnquiries(branchId, { view = 'open', q, cursor, limit } = {}, { today }) {
  const sort = VIEW_SORT[view] ?? ['enquiryDate', -1];
  return paginate(Enquiry, enquiryListFilter(branchId, { view, q }, { today }), { sort, cursor, limit });
}

/** How many open enquiries are due a call today or earlier, and how many of them are overdue. */
export async function followUpsDue(branchId, today) {
  const [row] = await Enquiry.aggregate([
    { $match: enquiryListFilter(branchId, { view: 'follow_ups' }, { today }) },
    { $group: { _id: null, count: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$followUpDate', today] }, 1, 0] } } } },
  ]);
  return { count: row?.count ?? 0, overdue: row?.overdue ?? 0 };
}
