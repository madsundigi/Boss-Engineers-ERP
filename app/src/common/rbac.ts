import { Request, Response, NextFunction } from 'express';
import { Errors } from './http-error';
import { hasPermission } from './request-context';

/**
 * RBAC guard. Blocks the request unless the authenticated user holds the given
 * permission code (MODULE.ACTION, e.g. 'ENQUIRY.CREATE'). The permission set is
 * the union of the user's roles (sec.role_permission) loaded at authentication.
 * Deny-by-default: no context or missing permission -> 403.
 */
export function requirePermission(code: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.context;
    if (!ctx) return next(Errors.unauthorized());
    if (!hasPermission(ctx, code)) {
      return next(Errors.forbidden(`Missing permission: ${code}`));
    }
    next();
  };
}
