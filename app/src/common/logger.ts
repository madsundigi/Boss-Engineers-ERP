/**
 * Structured application logging (PRR finding: "Logging 2/10 — console-only").
 *
 * Exposes a single `pino` logger and a `pino-http` middleware so request logs
 * carry a per-request id and timing, and app logs are JSON (shippable to
 * ELK/Loki) instead of bare `console.*`.
 *
 * Level resolution:
 *   - `silent`               when NODE_ENV === 'test'  (keeps the Jest output clean)
 *   - process.env.LOG_LEVEL  if set
 *   - 'info'                 otherwise
 *
 * Self-contained: the server wires `httpLogger` into app.ts; nothing here
 * imports app config so it can be used from any layer.
 */
import pino, { Logger } from 'pino';
import pinoHttp, { HttpLogger } from 'pino-http';

const isTest = process.env.NODE_ENV === 'test';

const level: string = isTest ? 'silent' : process.env.LOG_LEVEL ?? 'info';

/** The base application logger. Import and use `logger.info({...}, 'msg')`. */
export const logger: Logger = pino({
  level,
  base: { service: 'boss-engineers-erp' },
  // ISO timestamps are friendlier for log aggregation than epoch ms.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Defence-in-depth: never let common secret-bearing headers reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
});

/**
 * Express middleware that logs one line per HTTP request/response.
 * Reuses the base logger (so level/redaction apply) and surfaces any
 * incoming `x-correlation-id` as the log `req.id` for trace correlation.
 */
export const httpLogger: HttpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-correlation-id'];
    const id = Array.isArray(incoming) ? incoming[0] : incoming;
    if (id) {
      res.setHeader('x-correlation-id', id);
      return id;
    }
    return undefined as unknown as string;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

export default logger;
