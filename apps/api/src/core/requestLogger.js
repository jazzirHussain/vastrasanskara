/**
 * One log line per request once the response is sent: "GET /v1/auth/me 200 12ms".
 * Level follows the status (2xx/3xx info, 4xx warn, 5xx error); health checks log at debug so
 * uptime monitors don't flood the output. Only the path is logged — never the query string
 * or body, which can carry personal data.
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const status = res.statusCode;
      const path = req.originalUrl.split('?')[0];
      let level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      if (path.startsWith('/v1/health') && status < 500) level = 'debug';
      logger[level](
        { reqId: req.id, method: req.method, path, status, ms, userId: req.user?.id },
        `${req.method} ${path} ${status} ${ms}ms`,
      );
    });
    next();
  };
}
