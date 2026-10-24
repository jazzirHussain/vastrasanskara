import mongoose from 'mongoose';
import { clock } from '../../clock.js';
import { notFound, validationError } from '../../core/errors.js';
import { getCustomer } from '../customers/service.js';
import { readSettings } from '../settings/service.js';
import { Measurement } from './model.js';

/** Throws 400 on `garmentType` unless it is one of the branch's garment types. */
export async function assertGarmentType(branchId, garmentType, path = 'garmentType') {
  const { garmentTypes } = await readSettings(branchId);
  if (!garmentTypes.some((t) => t.key === garmentType)) {
    throw validationError([{ path, message: 'Unknown garment type' }]);
  }
}

/** Records a new set of measurements for the customer (never replaces an earlier set). */
export async function recordMeasurement(branchId, customerId, input, actor) {
  const customer = await getCustomer(branchId, customerId);
  await assertGarmentType(branchId, input.garmentType);
  const measurement = await Measurement.create({
    ...input,
    branchId,
    customerId: customer._id,
    takenBy: actor.userId,
    takenAt: clock.now(),
  });
  return measurement.toObject();
}

/** The customer's measurement sets, newest first. */
export async function listMeasurements(branchId, customerId) {
  const customer = await getCustomer(branchId, customerId);
  return Measurement.find({ branchId, customerId: customer._id }).sort({ takenAt: -1, _id: -1 }).lean();
}

/** The newest set per garment type: { [garmentType]: measurement }. */
export async function latestMeasurements(branchId, customerId) {
  const latest = {};
  for (const m of await listMeasurements(branchId, customerId)) latest[m.garmentType] ??= m;
  return latest;
}

export async function getMeasurement(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const measurement = await Measurement.findOne({ _id: id, branchId }).lean();
  if (!measurement) throw notFound();
  return measurement;
}
