import mongoose from 'mongoose';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { conflict, notFound } from '../../core/errors.js';
import { searchNameMatcher } from '../../core/text.js';
import { Worker } from './model.js';

const auditFields = (w) => ({ name: w.name, skill: w.skill, active: w.active });

/** The branch's workers by name; `active` narrows to active or inactive ones. */
export function listWorkers(branchId, { active } = {}) {
  return Worker.find({ branchId, ...(active !== undefined && { active }) }).sort({ searchName: 1, _id: 1 }).lean();
}

/** Creates a worker (audited, so records brought in by an import trace back to it). */
export async function createWorker(branchId, input, actor) {
  return withTransaction(async (session) => {
    const [worker] = await Worker.create(
      [{ ...input, branchId, searchName: input.name.toLowerCase(), createdBy: actor.userId, updatedBy: actor.userId }],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'worker', entityId: worker._id, action: 'create', before: null, after: auditFields(worker), actor },
      session,
    );
    return worker.toObject();
  });
}

/** The branch's worker with this name, ignoring case and extra spaces, or null. */
export function findWorkerByName(branchId, name) {
  const searchName = searchNameMatcher(name);
  return searchName ? Worker.findOne({ branchId, searchName }).lean() : null;
}

/** Updates a worker at `version` (409 when someone else saved first). */
export async function updateWorker(branchId, id, { version, patch }, actor) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const worker = await Worker.findOne({ _id: id, branchId });
  if (!worker) throw notFound();
  if (worker.__v !== version) throw conflict();
  worker.set(patch);
  if (patch.name) worker.searchName = patch.name.toLowerCase();
  worker.updatedBy = actor.userId;
  worker.increment();
  await worker.save();
  return worker.toObject();
}

const uniqueIds = (ids) => [...new Set(ids.map(String))];

/** Names of the branch's workers, by id. */
export async function getWorkerNames(branchId, ids) {
  const workers = await Worker.find({ branchId, _id: { $in: uniqueIds(ids) } }, { name: 1 }).lean();
  return new Map(workers.map((w) => [String(w._id), w.name]));
}

/** Whether every id is an active worker of the branch. */
export async function areActiveWorkers(branchId, ids) {
  const unique = uniqueIds(ids);
  if (!unique.every((id) => mongoose.isValidObjectId(id))) return false;
  return (await Worker.countDocuments({ branchId, _id: { $in: unique }, active: true })) === unique.length;
}
