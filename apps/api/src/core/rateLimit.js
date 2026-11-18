import { rateLimit } from 'express-rate-limit';
import { AppError } from './errors.js';

/**
 * Per-minute request budget for the whole API: per signed-in user (mounted after loadUser),
 * otherwise per IP. Health checks are exempt.
 */
export function apiRateLimiter(config) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: (req) => (req.user ? config.rateLimits.user : config.rateLimits.anonymous),
    keyGenerator: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`),
    skip: (req) => req.originalUrl.startsWith('/v1/health'),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.')),
  });
}
