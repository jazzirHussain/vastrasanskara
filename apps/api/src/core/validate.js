import { z } from 'zod';
import { validationError } from './errors.js';

/** Parses with a zod schema; failures become 400 VALIDATION_FAILED with field paths. */
export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * Validates request parts with zod schemas. Parsed values replace req.body and req.params;
 * the query goes to req.validatedQuery because Express 5 makes req.query read-only.
 */
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    if (params) req.params = parseOrThrow(params, req.params);
    if (query) req.validatedQuery = parseOrThrow(query, req.query);
    if (body) req.body = parseOrThrow(body, req.body ?? {});
    next();
  };
}

/**
 * Body schema for an optimistic-concurrency update: `{ version, ...fields }` where the fields
 * are checked by `schema`. Parses to `{ version, patch }`.
 */
export function versioned(schema) {
  return z.looseObject({ version: z.int().min(0) }).transform(({ version, ...rest }, ctx) => {
    const result = schema.safeParse(rest);
    if (result.success) return { version, patch: result.data };
    for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    return z.NEVER;
  });
}
