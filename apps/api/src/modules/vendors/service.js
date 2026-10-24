import mongoose from 'mongoose';
import { checkVendorRules } from '@vs/shared/schemas/workshop.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { Vendor } from './model.js';

// GSTIN and state reach tax records, so changes to them are audited (with name and active).
const AUDITED = ['name', 'gstin', 'stateCode', 'active'];
const auditFields = (v) => Object.fromEntries(AUDITED.map((f) => [f, v[f] ?? null]));

// The zod rule again, on the merged vendor (a patch may change only one side of it).
function assertVendorRules(vendor) {
  const issues = [];
  checkVendorRules(vendor, { addIssue: (issue) => issues.push({ path: issue.path.join('.'), message: issue.message }) });
  if (issues.length) throw validationError(issues);
}

/** The branch's vendors by name; `active` narrows to active or inactive ones. */
export function listVendors(branchId, { active } = {}) {
  return Vendor.find({ branchId, ...(active !== undefined && { active }) }).sort({ searchName: 1, _id: 1 }).lean();
}

/** Creates a vendor; the branch's state is used when no state code is given. */
export async function createVendor(branchId, input, actor) {
  const fields = { ...input, stateCode: input.stateCode ?? (await getBranch(branchId)).stateCode };
  assertVendorRules(fields);
  return withTransaction(async (session) => {
    const [vendor] = await Vendor.create(
      [{ ...fields, branchId, searchName: fields.name.toLowerCase(), createdBy: actor.userId, updatedBy: actor.userId }],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'vendor', entityId: vendor._id, action: 'create', before: null, after: auditFields(vendor), actor },
      session,
    );
    return vendor.toObject();
  });
}

/** Updates a vendor at `version` (409 when someone else saved first). */
export async function updateVendor(branchId, id, { version, patch }, actor) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return withTransaction(async (session) => {
    const vendor = await Vendor.findOne({ _id: id, branchId }).session(session);
    if (!vendor) throw notFound();
    if (vendor.__v !== version) throw conflict();
    assertVendorRules({ ...vendor.toObject(), ...patch });
    const before = auditFields(vendor);
    vendor.set(patch);
    if (patch.name) vendor.searchName = patch.name.toLowerCase();
    vendor.updatedBy = actor.userId;
    vendor.increment();
    await vendor.save({ session });
    const after = auditFields(vendor);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await recordAudit({ branchId, entityType: 'vendor', entityId: vendor._id, action: 'update', before, after, actor }, session);
    }
    return vendor.toObject();
  });
}

/** Names of the branch's vendors, by id. */
export async function getVendorNames(branchId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const vendors = await Vendor.find({ branchId, _id: { $in: unique } }, { name: 1 }).lean();
  return new Map(vendors.map((v) => [String(v._id), v.name]));
}

/** Whether the id is an active vendor of the branch. */
export async function isActiveVendor(branchId, id) {
  if (!mongoose.isValidObjectId(id)) return false;
  return Boolean(await Vendor.exists({ _id: id, branchId, active: true }));
}
