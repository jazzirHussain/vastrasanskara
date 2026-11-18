// Prints the custom database role for Atlas (Database Access → Custom Roles), so the app's
// user can add audit entries but never change or delete them:
//   node apps/api/src/cli/atlas-role.js [database-name]
import { appRole } from '../core/dbRole.js';
import { appCollections } from '../models.js';

const db = process.argv[2] ?? 'vastrasanskara';
console.log(JSON.stringify(appRole(appCollections(), db), null, 2));
