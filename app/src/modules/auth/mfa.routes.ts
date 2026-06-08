import { Router, Request } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler';
import { validate, valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { MfaService } from './mfa.service';

const tokenSchema = z.object({ token: z.string().regex(/^\d{6}$/, 'A 6-digit code is required') });
type TokenDto = z.infer<typeof tokenSchema>;

/**
 * Authenticated MFA enrollment routes. Mounted under /api (so the authenticate()
 * guard has already resolved req.context) at /api/auth.
 */
export function mfaRouter(pool: Pool): Router {
  const svc = new MfaService(pool);
  const r = Router();
  const uid = (req: Request): number => {
    if (!req.context) throw Errors.unauthorized();
    return req.context.userId;
  };

  r.post('/mfa/setup', asyncHandler(async (req, res) => {
    res.json(await svc.setup(uid(req)));
  }));
  r.post('/mfa/enable', validate(tokenSchema), asyncHandler(async (req, res) => {
    await svc.enable(uid(req), valid<TokenDto>(req).token);
    res.json({ mfaEnabled: true });
  }));
  r.post('/mfa/disable', validate(tokenSchema), asyncHandler(async (req, res) => {
    await svc.disable(uid(req), valid<TokenDto>(req).token);
    res.json({ mfaEnabled: false });
  }));

  return r;
}
