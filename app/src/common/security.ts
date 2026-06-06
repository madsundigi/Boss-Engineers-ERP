import { RequestHandler } from 'express';
import helmet from 'helmet';
import cors, { CorsOptions } from 'cors';
import { rateLimit } from 'express-rate-limit';

/**
 * Application security perimeter (VULN-API1/API2/API3, VULN-RL1).
 *
 * `securityMiddlewares()` returns the ordered handlers the orchestrator mounts
 * on the Express app, before the routers:
 *   1. helmet()         — security headers (HSTS, X-Content-Type-Options, CSP, ...)
 *   2. cors(...)        — origin allowlist from CORS_ORIGINS (deny by default)
 *   3. rateLimit(...)   — global per-IP throttle
 *
 * A stricter `authRateLimiter` is exported for future auth routes (login, token
 * issuance) where brute-force / credential-stuffing risk is highest.
 */

/** Window for the global limiter (ms). */
const GLOBAL_WINDOW_MS = 60_000;
/** Max requests per IP per window for general API traffic. */
const GLOBAL_LIMIT = 300;
/** Max requests per IP per window for sensitive auth endpoints. */
const AUTH_LIMIT = 20;

/** Parse the comma-separated CORS_ORIGINS allowlist into a trimmed, non-empty list. */
function parseAllowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Build CORS options that reflect only explicitly allowlisted origins. If the
 * allowlist is empty we do NOT echo arbitrary origins — cross-origin browser
 * requests are simply not granted an ACAO header. Credentials are off by design
 * (the API uses Authorization-header auth, not cookies — see VULN-CSRF1).
 */
function buildCorsOptions(): CorsOptions {
  const allowed = parseAllowedOrigins();
  return {
    origin(requestOrigin, callback) {
      // Non-browser / same-origin requests have no Origin header — allow them
      // (CORS only governs cross-origin browser access).
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      callback(null, allowed.includes(requestOrigin));
    },
    credentials: false,
  };
}

/**
 * Ordered list of global security middlewares. Mount these before route
 * handlers, e.g. `app.use(...securityMiddlewares())`.
 */
export function securityMiddlewares(): RequestHandler[] {
  const helmetMw = helmet() as RequestHandler;
  const corsMw = cors(buildCorsOptions()) as RequestHandler;
  const limiterMw = rateLimit({
    windowMs: GLOBAL_WINDOW_MS,
    limit: GLOBAL_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
  });

  return [helmetMw, corsMw, limiterMw];
}

/**
 * Stricter limiter for authentication routes (login, token refresh, password
 * reset). Mount per-route, e.g. `router.post('/login', authRateLimiter, ...)`.
 */
export const authRateLimiter: RequestHandler = rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  limit: AUTH_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
});
