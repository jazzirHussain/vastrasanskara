import { createWorker, findWorkerByName } from '../../workers/service.js';
import { registerImportKind } from './index.js';

registerImportKind('workers', {
  context: async () => ({}),
  async check({ data }, ctx) {
    const existing = await findWorkerByName(ctx.branchId, data.name);
    return { status: existing ? 'exists' : 'ready', label: data.name };
  },
  async commit([row], ctx, actor) {
    // Someone may have added the same worker since the check.
    if (await findWorkerByName(ctx.branchId, row.data.name)) return { status: 'skipped', entityId: null };
    const worker = await createWorker(ctx.branchId, row.data, actor);
    return { status: 'added', entityId: worker._id };
  },
});
