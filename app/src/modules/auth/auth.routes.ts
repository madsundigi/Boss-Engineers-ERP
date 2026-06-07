import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate, valid } from '../../common/validate';
import { LoginService } from './auth.service';
import { loginSchema, LoginDto } from './auth.dto';

/**
 * Public authentication routes. Mounted OUTSIDE the /api authenticate guard so a
 * client can obtain a token before it has one. Only token issuance lives here;
 * every other route is protected by authenticate().
 */
export function authRouter(pool: Pool): Router {
  const service = new LoginService(pool);
  const r = Router();

  r.post('/login',
    validate(loginSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await service.login(valid<LoginDto>(req));
      res.json(result);
    }));

  return r;
}
