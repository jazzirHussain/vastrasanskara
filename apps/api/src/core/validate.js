import { validationError } from './errors.js';

function parse(schema, value) {
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
    if (params) req.params = parse(params, req.params);
    if (query) req.validatedQuery = parse(query, req.query);
    if (body) req.body = parse(body, req.body ?? {});
    next();
  };
}
