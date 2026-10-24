import mongoose from 'mongoose';
import { conflict, notFound } from '../../core/errors.js';
import { Worker } from './model.js';

/** The branch's workers by name; `active` narrows to active or inactive ones. */
export function listWorkers(branchId, { active } = {}) {
  return Worker.find({ branchId, ...(active !== undefined && { active }) }).sort({ searchName: 1, _id: 1 }).lean();
}

export async function createWorker(branchId, input, actor) {
  const worker = await Worker.create({
    ...input,
    branchId,
    searchName: input.name.toLowerCase(),
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return worker.toObject();
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
