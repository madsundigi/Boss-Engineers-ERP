import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { WorkCentersRepository } from './workcenters.repository';
import { WorkCentersService } from './workcenters.service';
import { WorkCentersController } from './workcenters.controller';
import { WORK_CENTER_PERMS } from './workcenters.constants';
import {
  createWorkCenterSchema, updateWorkCenterSchema, listQuerySchema,
} from './workcenters.dto';

/** Compose the Work-Centre master module (repository -> service -> controller).
 *  Gated on the WORK_ORDER RBAC domain (no WORK_CENTER domain exists). */
export function workCentersRouter(pool: Pool): Router {
  const controller = new WorkCentersController(new WorkCentersService(new WorkCentersRepository(pool)));
  const r = Router();

  r.get('/', requirePermission(WORK_CENTER_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(WORK_CENTER_PERMS.CREATE), validate(createWorkCenterSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(WORK_CENTER_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(WORK_CENTER_PERMS.EDIT), validate(updateWorkCenterSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(WORK_CENTER_PERMS.DELETE), asyncHandler(controller.remove));

  return r;
}
