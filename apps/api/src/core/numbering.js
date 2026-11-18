import mongoose from 'mongoose';
import { financialYear } from '@vs/shared/fy.js';
import { nextSequence } from './counters.js';

const counterName = (branchId, docType, fyCode) => `doc:${branchId}:${docType}:${fyCode}`;

/**
 * Next gapless number of a document type for the branch, in the IST financial year of `now`.
 * The series starts at `start` (from settings.numberSeries). Must run inside the transaction
 * that creates the document, so an aborted save never uses up a number.
 */
export async function nextDocumentNumber({ branchId, docType, now, start = 1 }, session) {
  const fy = financialYear(now);
  const seq = await nextSequence(counterName(branchId, docType, fy.code), session);
  return { number: start - 1 + seq, fy };
}

/** Whether the series has given out a number in that financial year (its start can no longer change). */
export async function seriesUsed(branchId, docType, fyCode, session) {
  const counter = await mongoose.connection
    .collection('counters')
    .findOne({ _id: counterName(branchId, docType, fyCode) }, { session });
  return (counter?.value ?? 0) >= 1;
}

/**
 * seriesUsed for a transaction that is about to change the series' start: it also writes the
 * counter, so a first number taken meanwhile conflicts with this transaction and one of the two
 * retries against the other's result (a plain read would let both commit).
 */
export async function holdSeries(branchId, docType, fyCode, session) {
  if (!session?.inTransaction()) throw new Error('holdSeries must be called inside a transaction');
  const counter = await mongoose.connection
    .collection('counters')
    .findOneAndUpdate(
      { _id: counterName(branchId, docType, fyCode) },
      { $set: { startHeldAt: new Date() }, $setOnInsert: { value: 0 } },
      { upsert: true, returnDocument: 'after', session },
    );
  return counter.value >= 1;
}

/**
 * The number the series will give out next in that financial year (no number is taken), and
 * whether it has given any yet.
 */
export async function peekNextNumber(branchId, docType, fyCode, start = 1) {
  const counter = await mongoose.connection.collection('counters').findOne({ _id: counterName(branchId, docType, fyCode) });
  const taken = counter?.value ?? 0;
  return { next: start + taken, used: taken >= 1 };
}
