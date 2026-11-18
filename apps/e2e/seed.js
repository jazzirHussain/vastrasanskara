// The people and price list every journey starts from. Users are written straight to the
// database (they would otherwise need an emailed invite); everything else goes through the API.
export const PASSWORD = 'e2e-correct-horse-1';
export const USERS = {
  admin: { name: 'Owner Rao', email: 'owner@e2e.test' },
  operations: { name: 'Kavya Front', email: 'kavya@e2e.test' },
  designer: { name: 'Meera Design', email: 'meera@e2e.test' },
};

/** `api(method, path, body)` is signed in as the admin; `insertUser` writes a user with PASSWORD. */
export async function seed({ api, insertUser }) {
  await insertUser({ ...USERS.operations, roles: ['operations'] });
  await insertUser({ ...USERS.designer, roles: ['designer'] });
  // No advance needed before work starts, so the order journey runs straight through production.
  await api('PUT', '/v1/settings', { advancePercent: 0 });
  await api('POST', '/v1/catalog/items', {
    name: 'Blouse stitching',
    kind: 'garment',
    supplyType: 'goods',
    hsnSac: '6206',
    gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }],
    garmentTypes: ['blouse'],
  });
}
