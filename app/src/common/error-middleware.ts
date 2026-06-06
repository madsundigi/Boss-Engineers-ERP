import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from './http-error';

/** Central error handler — maps AppError, Zod, and known pg errors to JSON. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.flatten() },
    });
  }
  // PostgreSQL check/unique/not-null violations -> 409/400
  const pg = err as { code?: string; constraint?: string; detail?: string };
  if (pg && typeof pg.code === 'string') {
    if (pg.code === '23505')
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'Duplicate value', details: pg.constraint } });
    if (pg.code === '23514' || pg.code === '23502' || pg.code === '23503')
      return res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Database constraint violation', details: pg.constraint } });
  }
  // Unknown — do not leak internals
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error', details: null } });
}
