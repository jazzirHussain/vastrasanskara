import { Router } from 'express';
import { z } from 'zod';
import { IMPORT_KINDS, IMPORT_KIND_KEYS, getImportKind, importConfirmSchema, importRowsQuery, importStartSchema } from '@vs/shared';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { notFound } from '../../core/errors.js';
import { contentDisposition } from '../../core/http.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { readSettings } from '../settings/service.js';
import { getUserNames, listDesigners } from '../users/service.js';
import { toImportJson, toImportRowJson } from './json.js';
import { templateCsv, templateXlsx } from './sheets.js';
import {
  cancelImport,
  confirmImport,
  getImport,
  listImportRows,
  listImports,
  problemsFile,
  resumeImport,
  sameFileDate,
  startImport,
} from './service.js';

const RUN = 'imports.run';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const templateQuery = z.strictObject({ format: z.enum(['xlsx', 'csv']).optional() });
const listQuery = z.strictObject({
  kind: z.enum(IMPORT_KIND_KEYS).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const versionOnly = validate({ body: versioned(importConfirmSchema) });

// What the page needs to describe each kind; the cell readers stay on the server.
const KINDS_JSON = IMPORT_KINDS.map(({ kind, label, help, needsAsOf, columns }) => ({
  kind,
  label,
  help,
  needsAsOf,
  columns: columns.map((c) => ({
    key: c.key,
    header: c.header,
    required: c.required,
    example: c.example,
    help: c.help,
    choices: c.choices ? c.choices.map((x) => x.label) : null,
  })),
}));

async function jsonOf(run) {
  const names = await getUserNames([run.requestedBy, run.confirmedBy].filter(Boolean));
  return toImportJson(run, { names, sameFileAt: await sameFileDate(run) });
}

// The run is recorded; if reading it back fails, answer what is known.
async function respond(req, res, run, status = 200) {
  let body;
  try {
    body = await jsonOf(run);
  } catch (err) {
    logger.warn({ runId: String(run._id), requestId: req.id, errName: err?.name }, 'import recorded; reading it back failed');
    body = { id: String(run._id), status: run.status };
  }
  res.status(status).json({ import: body });
}

function sendFile(res, { buffer, filename, contentType }) {
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', contentDisposition(filename));
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
}

/** Bringing in old records: admin only (imports.run). */
export function importsRouter(storage) {
  const router = Router();
  router.use(requirePermission(RUN));

  router.get('/kinds', (req, res) => {
    res.json({ kinds: KINDS_JSON });
  });

  router.get('/templates/:kind', validate({ query: templateQuery }), async (req, res) => {
    if (!IMPORT_KIND_KEYS.includes(req.params.kind)) throw notFound();
    const def = getImportKind(req.params.kind);
    if (req.validatedQuery.format === 'csv') {
      sendFile(res, { buffer: templateCsv(def.kind), filename: `${def.label} template.csv`, contentType: 'text/csv; charset=utf-8' });
      return;
    }
    const [settings, designers] = await Promise.all([readSettings(req.user.branchId), listDesigners(req.user.branchId)]);
    const buffer = await templateXlsx(def.kind, { garmentTypes: settings.garmentTypes ?? [], designers });
    sendFile(res, { buffer, filename: `${def.label} template.xlsx`, contentType: XLSX });
  });

  router.post('/', validate({ body: importStartSchema }), idempotent(), async (req, res) => {
    const run = await startImport(req.user.branchId, req.body, actorFrom(req), { storage });
    await respond(req, res, run, 202);
  });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { items, nextCursor } = await listImports(req.user.branchId, req.validatedQuery);
    const names = await getUserNames(items.flatMap((r) => [r.requestedBy, r.confirmedBy]).filter(Boolean));
    res.json({ items: items.map((r) => toImportJson(r, { names })), nextCursor });
  });

  router.get('/:id', async (req, res) => {
    res.json({ import: await jsonOf(await getImport(req.user.branchId, req.params.id)) });
  });

  router.get('/:id/rows', validate({ query: importRowsQuery }), async (req, res) => {
    const { items, nextCursor } = await listImportRows(req.user.branchId, req.params.id, req.validatedQuery);
    res.json({ items: items.map(toImportRowJson), nextCursor });
  });

  router.get('/:id/problems', async (req, res) => {
    const { run, buffer } = await problemsFile(req.user.branchId, req.params.id);
    sendFile(res, { buffer, filename: `${getImportKind(run.kind).label} rows to fix.xlsx`, contentType: XLSX });
  });

  router.post('/:id/confirm', versionOnly, async (req, res) => {
    await respond(req, res, await confirmImport(req.user.branchId, req.params.id, req.body, actorFrom(req), { storage }));
  });

  router.post('/:id/cancel', versionOnly, async (req, res) => {
    await respond(req, res, await cancelImport(req.user.branchId, req.params.id, req.body, actorFrom(req)));
  });

  router.post('/:id/resume', versionOnly, async (req, res) => {
    await respond(req, res, await resumeImport(req.user.branchId, req.params.id, req.body, actorFrom(req), { storage }));
  });

  return router;
}
