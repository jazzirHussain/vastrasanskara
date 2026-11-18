import mongoose from 'mongoose';
import { checkCatalogItemRules } from '@vs/shared/schemas/catalog.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { searchNameMatcher } from '../../core/text.js';
import { readSettings } from '../settings/service.js';
import { getItem as getStockItem } from '../stock/service.js';
import { CatalogItem } from './model.js';

// Tax fields reach every bill, so their changes are audited (spec §5.7).
const AUDITED = ['name', 'kind', 'supplyType', 'hsnSac', 'unit', 'gstSlabs', 'active'];
const auditView = (item) =>
  Object.fromEntries(
    AUDITED.map((f) => [f, f === 'gstSlabs' ? item.gstSlabs.map((s) => ({ upToUnitPrice: s.upToUnitPrice, rateBp: s.rateBp })) : item[f]]),
  );

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The shared rules again, on the whole item (a patch may change only one side of a rule).
function assertItemRules(item) {
  const issues = [];
  checkCatalogItemRules(item, {
    addIssue: (issue) => issues.push({ path: issue.path.join('.'), message: issue.message }),
  });
  if (issues.length) throw validationError(issues);
}

async function assertKnownGarmentTypes(branchId, types, session) {
  const known = new Set((await readSettings(branchId, session)).garmentTypes.map((t) => t.key));
  const issues = types
    .map((type, i) => ({ type, i }))
    .filter(({ type }) => !known.has(type))
    .map(({ i }) => ({ path: `garmentTypes.${i}`, message: 'Not one of your garment types' }));
  if (issues.length) throw validationError(issues);
}

// A linked stock item must exist in the branch (the shared rules already limit links to materials).
async function assertStockItemExists(branchId, stockItemId, session) {
  if (!stockItemId) return;
  try {
    await getStockItem(branchId, stockItemId, session);
  } catch (err) {
    if (err.status === 404 || err.code === 'NOT_FOUND') {
      throw validationError([{ path: 'stockItemId', message: 'Not one of your stock items' }]);
    }
    throw err;
  }
}

// One active item per garment type and per extra charge.
async function assertMappingFree(branchId, item, selfId, session) {
  if (!item.active) return;
  const taken = [];
  if (item.garmentTypes.length) taken.push({ garmentTypes: { $in: item.garmentTypes } });
  if (item.chargeFor) taken.push({ chargeFor: item.chargeFor });
  if (!taken.length) return;
  const other = await CatalogItem.findOne(
    { branchId, active: true, $or: taken, ...(selfId && { _id: { $ne: selfId } }) },
    { name: 1 },
  )
    .session(session)
    .lean();
  if (other) {
    throw businessRule('CATALOG_MAPPING_TAKEN', 'Another item already bills this', {
      itemId: String(other._id),
      name: other.name,
    });
  }
}

/** The branch's items by name (at most 500); optional active / kind / name-contains filters. */
export function listItems(branchId, { active, kind, q } = {}) {
  const filter = { branchId };
  if (active !== undefined) filter.active = active;
  if (kind) filter.kind = kind;
  if (q) filter.searchName = { $regex: escapeRegex(q.trim().toLowerCase()) };
  return CatalogItem.find(filter).sort({ searchName: 1, _id: 1 }).limit(500).lean();
}

export async function getItem(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const item = await CatalogItem.findOne({ _id: id, branchId }).lean();
  if (!item) throw notFound();
  return item;
}

/** The branch's item with this name, ignoring case and extra spaces, or null. */
export function findItemByName(branchId, name, session) {
  const searchName = searchNameMatcher(name);
  return searchName ? CatalogItem.findOne({ branchId, searchName }).session(session ?? null).lean() : null;
}

export function createItem(branchId, input, actor) {
  return withTransaction(async (session) => {
    await assertKnownGarmentTypes(branchId, input.garmentTypes, session);
    await assertStockItemExists(branchId, input.stockItemId, session);
    await assertMappingFree(branchId, input, null, session);
    const [item] = await CatalogItem.create(
      [{ ...input, branchId, searchName: input.name.toLowerCase(), createdBy: actor.userId, updatedBy: actor.userId }],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'catalog_item', entityId: item._id, action: 'create', before: null, after: auditView(item), actor },
      session,
    );
    return item.toObject();
  });
}

/** Updates an item at `version` (409 when someone else saved first). */
export function updateItem(branchId, id, { version, patch }, actor) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return withTransaction(async (session) => {
    const item = await CatalogItem.findOne({ _id: id, branchId }).session(session);
    if (!item) throw notFound();
    if (item.__v !== version) throw conflict();
    const merged = { ...item.toObject(), ...patch };
    assertItemRules(merged);
    if (patch.garmentTypes) await assertKnownGarmentTypes(branchId, patch.garmentTypes, session);
    if (patch.stockItemId) await assertStockItemExists(branchId, patch.stockItemId, session);
    await assertMappingFree(branchId, merged, item._id, session);
    const before = auditView(item);
    item.set(patch);
    if (patch.name) item.searchName = patch.name.toLowerCase();
    item.updatedBy = actor.userId;
    item.increment();
    await item.save({ session });
    const after = auditView(item);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await recordAudit({ branchId, entityType: 'catalog_item', entityId: item._id, action: 'update', before, after, actor }, session);
    }
    return item.toObject();
  });
}

/** Items by id, as a Map keyed by the id string (unknown or foreign ids are left out). */
export async function getItemsByIds(branchId, ids, session) {
  const valid = [...new Set(ids.map(String))].filter((id) => mongoose.isValidObjectId(id));
  const items = await CatalogItem.find({ branchId, _id: { $in: valid } }).session(session ?? null).lean();
  return new Map(items.map((item) => [String(item._id), item]));
}

/** The active item that bills a garment type, or null. */
export async function itemForGarmentType(branchId, type, session) {
  return CatalogItem.findOne({ branchId, active: true, garmentTypes: type }).session(session ?? null).lean();
}

/** The active item that bills an extra charge ('rush', 'alteration', 'rework'), or null. */
export async function itemForCharge(branchId, chargeFor, session) {
  return CatalogItem.findOne({ branchId, active: true, chargeFor }).session(session ?? null).lean();
}

/** Garment types in settings that no active price-list item bills yet (their keys). */
export async function garmentTypesWithoutItem(branchId) {
  const { garmentTypes } = await readSettings(branchId);
  const billed = new Set(await CatalogItem.distinct('garmentTypes', { branchId, active: true }));
  return garmentTypes.map((t) => t.key).filter((key) => !billed.has(key));
}
