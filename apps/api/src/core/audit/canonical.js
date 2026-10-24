// Turns values into the exact JSON-safe form that is hashed and stored, so an entry
// re-read from MongoDB hashes identically.

function isObjectId(value) {
  return value?._bsontype === 'ObjectId' || value?._bsontype === 'ObjectID';
}

function isMongooseDocument(value) {
  return typeof value?.toObject === 'function' && value.$__ !== undefined;
}

/** Date → ISO string, ObjectId → hex, Decimal128 → string, Mongoose doc → plain object; drops undefined. */
export function normalize(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (isObjectId(value)) return value.toHexString();
  if (value?._bsontype === 'Decimal128') return value.toString();
  if (isMongooseDocument(value)) return normalize(value.toObject({ depopulate: true }));
  if (value instanceof Map) return normalize(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const n = normalize(v);
      if (n !== undefined) out[key] = n;
    }
    return out;
  }
  return value;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** JSON of the normalized value with object keys sorted recursively. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(normalize(value)) ?? null);
}
