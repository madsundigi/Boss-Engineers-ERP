import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { EhsRepository } from './ehs.repository';
import { EhsService } from './ehs.service';
import { EhsController } from './ehs.controller';
import { EHS_PERMS } from './ehs.constants';
import { createIncidentSchema, updateIncidentSchema, versionSchema, listQuerySchema } from './ehs.dto';

/** Compose the EHS / Incident Register module (repository -> service -> controller). */
export function ehsRouter(pool: Pool): Router {
  const controller = new EhsController(new EhsService(new EhsRepository(pool)));
  const r = Router();

  r.get('/export', requirePermission(EHS_PERMS.EXPORT), validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/', requirePermission(EHS_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(EHS_PERMS.CREATE), validate(createIncidentSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(EHS_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(EHS_PERMS.EDIT), validate(updateIncidentSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(EHS_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  r.post('/:id/start-investigation', requirePermission(EHS_PERMS.EDIT), validate(versionSchema),
    asyncHandler(controller.startInvestigation));
  r.post('/:id/close', requirePermission(EHS_PERMS.APPROVE), validate(versionSchema),
    asyncHandler(controller.close));

  return r;
}
