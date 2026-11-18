// The database role the app should connect as (Decision 18): audit entries can only be added
// and read, so even the app's own credentials cannot rewrite history.
const AUDIT = 'auditLog';
const AUDIT_ACTIONS = ['find', 'insert', 'createIndex', 'listIndexes'];
const ACTIONS = ['find', 'insert', 'update', 'remove', 'createIndex', 'dropIndex', 'listIndexes', 'collStats'];
const DATABASE_ACTIONS = ['listCollections', 'dbStats', 'createCollection'];

/** A custom role for `db` (Atlas: Database Access → Custom Roles) covering `collections`. */
export function appRole(collections, db = 'vastrasanskara') {
  return {
    role: 'vsApp',
    privileges: [
      { resource: { db, collection: '' }, actions: [...DATABASE_ACTIONS] },
      ...collections.map((collection) => ({
        resource: { db, collection },
        actions: collection === AUDIT ? [...AUDIT_ACTIONS] : [...ACTIONS],
      })),
    ],
    roles: [],
  };
}
