import { rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';

/**
 * Per-IP limit for unauthenticated auth endpoints (login, password reset):
 * config.loginRateLimit attempts per 15 minutes. Each call creates its own counter.
 */
export function authRateLimiter(config, message = 'Too many attempts; try again later') {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(new AppError(429, 'RATE_LIMITED', message)),
  });
}
