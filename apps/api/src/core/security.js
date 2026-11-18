import helmet from 'helmet';
import cors from 'cors';
import { AppError, unsupportedContentType } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Strict helmet headers (the API serves JSON and file bytes, never pages: nothing may load from
 * it or frame it) plus CORS that allows exactly the web app's origin, with credentials.
 */
export function securityMiddleware(config) {
  return [
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
    cors({
      // A function, not a string: with a string, cors echoes that origin to every caller.
      origin: (origin, callback) => callback(null, origin === config.appOrigin),
      credentials: true,
      maxAge: 7200,
      allowedHeaders: ['Content-Type', 'X-Requested-With', 'Idempotency-Key'],
    }),
  ];
}

/** API answers hold personal and money data: no browser or proxy may keep a copy. */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function hasBody(req) {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
}

/**
 * CSRF defence for state-changing requests: browsers cannot send a custom header
 * cross-site without a CORS preflight, which only the app origin passes.
 */
export function requireAppHeader(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('X-Requested-With') !== 'vs-app') {
    return next(new AppError(403, 'CSRF_HEADER_MISSING', 'Request is missing the app header'));
  }
  if (hasBody(req) && !req.is('application/json')) return next(unsupportedContentType());
  return next();
}
