import { z } from 'zod';
import { ymd } from './common.js';
import { IMPORT_KIND_KEYS, getImportKind } from '../imports/kinds.js';

/** POST /v1/imports: an uploaded file to check. `asOf` is the cut-over date, for opening balances. */
export const importStartSchema = z
  .strictObject({
    kind: z.enum(IMPORT_KIND_KEYS),
    fileKey: z.string().min(1).max(300),
    fileName: z.string().trim().min(1).max(120),
    asOf: ymd.optional(),
  })
  .superRefine((value, ctx) => {
    const needs = getImportKind(value.kind).needsAsOf;
    if (needs && !value.asOf) ctx.addIssue({ code: 'custom', path: ['asOf'], message: 'Choose the cut-over date' });
    if (!needs && value.asOf) ctx.addIssue({ code: 'custom', path: ['asOf'], message: 'This kind does not take a date' });
  });

/** POST /v1/imports/:id/confirm (through `versioned`). */
export const importConfirmSchema = z.strictObject({});

export const IMPORT_ROW_STATUSES = Object.freeze(['ready', 'exists', 'error', 'added', 'skipped', 'failed']);

export const importRowsQuery = z.strictObject({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
