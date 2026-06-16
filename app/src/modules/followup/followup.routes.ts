import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { FollowupRepository } from './followup.repository';
import { FollowupService } from './followup.service';
import { FollowupController } from './followup.controller';
import { FOLLOWUP_PERMS } from './followup.constants';
import {
  listQuerySchema, createFollowupSchema, updateFollowupSchema, dashboardQuerySchema,
} from './followup.dto';

/**
 * Compose the enquiry follow-up module (repository -> service -> controller) and
 * its routes. Reuses the ENQUIRY permissions: VIEW guards reads, EDIT guards
 * writes (no new permission codes). Mounted at /api/followups.
 */
export function followupRouter(pool: Pool): Router {
  const controller = new FollowupController(new FollowupService(new FollowupRepository(pool)));
  const r = Router();
  const P = FOLLOWUP_PERMS;

  // '/dashboard' must precede '/:id' so it is not captured as an id.
  r.get('/dashboard',
    requirePermission(P.VIEW),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(controller.dashboard));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.EDIT),
    validate(createFollowupSchema),
    asyncHandler(controller.create));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateFollowupSchema),
    asyncHandler(controller.update));

  return r;
}
