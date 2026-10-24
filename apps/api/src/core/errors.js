import { logger } from '../logger.js';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const validationError = (details) =>
  new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', details);

export const notAuthenticated = (code = 'NOT_AUTHENTICATED') =>
  new AppError(401, code, 'Please sign in');

export const forbidden = (code = 'FORBIDDEN') =>
  new AppError(403, code, 'You do not have permission to do this');

export const notFound = () => new AppError(404, 'NOT_FOUND', 'Not found');

export const conflict = (
  code = 'CONFLICT',
  message = 'This record was changed by someone else; reload and try again',
) => new AppError(409, code, message);

export const businessRule = (code, message, details) => new AppError(422, code, message, details);

export const unsupportedContentType = () =>
  new AppError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Request body must be JSON');

// express.json() errors carry a `type`; map the client-caused ones to a clean 4xx.
function fromBodyParser(err) {
  switch (err?.type) {
    case 'entity.parse.failed':
      return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    case 'entity.too.large':
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return unsupportedContentType();
    default:
      return null;
  }
}

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === 'VersionError') return conflict();
  return fromBodyParser(err);
}

/** Express error middleware: always replies { error: { code, message, details? } }. */
// Express recognises error middleware by its 4-argument signature.
export function errorHandler(err, req, res, _next) {
  const appError = toAppError(err);
  if (!appError) {
    logger.error({ err, requestId: req.id }, 'unhandled error');
    return res
      .status(500)
      .json({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
  }
  const body = { code: appError.code, message: appError.message };
  if (appError.details !== undefined) body.details = appError.details;
  return res.status(appError.status).json({ error: body });
}
