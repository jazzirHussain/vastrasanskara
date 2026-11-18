import { getImportKind } from '@vs/shared';

const person = (id, names) => (id ? { id: String(id), name: names.get(String(id)) ?? null } : null);

/** An import run as the API answers it. `names`: user id → name; `sameFileAt`: when the same file came before. */
export function toImportJson(run, { names = new Map(), sameFileAt = null } = {}) {
  const counts = run.counts ?? {};
  const committing = run.phase === 'commit';
  const done = committing ? (counts.added ?? 0) + (counts.skipped ?? 0) + (counts.failed ?? 0) : 0;
  return {
    id: String(run._id),
    kind: run.kind,
    label: getImportKind(run.kind).label,
    fileName: run.fileName,
    status: run.status,
    phase: run.phase,
    rowCount: run.rowCount ?? null,
    counts: {
      ready: counts.ready ?? 0,
      exists: counts.exists ?? 0,
      error: counts.error ?? 0,
      added: counts.added ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
    },
    progress: { done, total: committing ? (run.toAdd ?? 0) : (run.rowCount ?? 0) },
    unusedColumns: run.unusedColumns ?? [],
    fileError: run.fileError ? { code: run.fileError.code, message: run.fileError.message } : null,
    sameFileAs: run.sameFileAs ? { id: String(run.sameFileAs), at: sameFileAt } : null,
    asOf: run.asOf ?? null,
    requestedBy: person(run.requestedBy, names),
    confirmedBy: person(run.confirmedBy, names),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    version: run.__v,
  };
}

/** One row of a run: never its stored data, only what the preview shows. */
export function toImportRowJson(row) {
  return {
    rowNo: row.rowNo,
    status: row.status,
    label: row.label ?? '',
    errors: (row.errors ?? []).map((e) => ({ column: e.column ?? null, message: e.message })),
  };
}
