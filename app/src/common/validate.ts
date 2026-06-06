import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { Errors } from './http-error';

type Target = 'body' | 'query' | 'params';

/** Validate & coerce a request part against a Zod schema; reject 400 on failure. */
export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(Errors.badRequest('Invalid request', result.error.flatten()));
    }
    // store the parsed/coerced value for the handler
    (req as unknown as Record<string, unknown>)[`valid_${target}`] = result.data;
    next();
  };
}

/** Read the validated payload the middleware stored. */
export function valid<T>(req: Request, target: Target = 'body'): T {
  return (req as unknown as Record<string, unknown>)[`valid_${target}`] as T;
}
