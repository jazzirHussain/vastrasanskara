import { reportByKind } from '@vs/shared/reports/catalog.js';

/** A report run as the API answers it. `names`: user id → name. Scheduled runs show "Automatic". */
export function toRunJson(run, { names = new Map() } = {}) {
  const p = run.params ?? {};
  const params = Object.fromEntries(
    Object.entries({ month: p.month, from: p.from, to: p.to, customerId: p.customerId ? String(p.customerId) : null }).filter(([, v]) => v),
  );
  return {
    id: String(run._id),
    kind: run.kind,
    label: reportByKind(run.kind)?.label ?? run.kind,
    format: run.format,
    params,
    status: run.status,
    filename: run.file?.filename ?? null,
    size: run.file?.size ?? null,
    rows: run.rows ?? null,
    error: run.error ? { code: run.error.code, message: run.error.message } : null,
    requestedBy: run.requestedBy
      ? { id: String(run.requestedBy), name: names.get(String(run.requestedBy)) ?? null }
      : { id: null, name: 'Automatic' },
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
  };
}
