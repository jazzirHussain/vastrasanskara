import { branchPatchSchema } from '@vs/shared/schemas/branch.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, notFound, validationError } from '../../core/errors.js';
import { parseOrThrow } from '../../core/validate.js';
import { Branch } from './model.js';

export const BRANCH_FIELDS = ['name', 'legalName', 'gstin', 'stateCode', 'address', 'phone', 'email', 'logoKey', 'prefixes'];

function pick(branch) {
  const plain = typeof branch.toObject === 'function' ? branch.toObject() : branch;
  return Object.fromEntries(BRANCH_FIELDS.map((f) => [f, plain[f] ?? null]));
}

/** A GSTIN starts with its state code, so the branch's state must match it. */
export function assertStateMatchesGstin({ gstin, stateCode }) {
  if (gstin && gstin.slice(0, 2) !== stateCode) {
    throw businessRule('STATE_GSTIN_MISMATCH', 'The state code must match the first two digits of the GSTIN');
  }
}

export async function getBranch(branchId) {
  const branch = await Branch.findById(branchId).lean();
  if (!branch) throw notFound();
  return branch;
}

/** Updates branch details (audited). The logo must be a branch_logo upload of this branch. */
export function updateBranch(branchId, patch, actor) {
  const changes = parseOrThrow(branchPatchSchema, patch);
  if (changes.logoKey && !changes.logoKey.startsWith(`${branchId}/branch_logo/`)) {
    throw validationError([{ path: 'logoKey', message: 'Upload the logo for this branch first' }]);
  }
  return withTransaction(async (session) => {
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) throw notFound();
    const before = pick(branch);
    assertStateMatchesGstin({ ...before, ...changes });

    branch.set(changes);
    branch.updatedBy = actor.userId;
    await branch.save({ session });
    await recordAudit(
      { branchId, entityType: 'branch', entityId: branchId, action: 'update', before, after: pick(branch), actor },
      session,
    );
    return branch.toObject();
  });
}
