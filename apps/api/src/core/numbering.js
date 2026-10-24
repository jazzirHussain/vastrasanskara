import { financialYear } from '@vs/shared/fy.js';
import { nextSequence } from './counters.js';

/**
 * Next gapless number of a document type for the branch, in the IST financial year of `now`.
 * The series starts at `start` (from settings.numberSeries). Must run inside the transaction
 * that creates the document, so an aborted save never uses up a number.
 */
export async function nextDocumentNumber({ branchId, docType, now, start = 1 }, session) {
  const fy = financialYear(now);
  const seq = await nextSequence(`doc:${branchId}:${docType}:${fy.code}`, session);
  return { number: start - 1 + seq, fy };
}
