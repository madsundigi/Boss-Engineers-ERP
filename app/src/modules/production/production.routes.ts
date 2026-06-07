import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ProductionRepository } from './production.repository';
import { ProductionService } from './production.service';
import { ProductionController } from './production.controller';
import { WO_PERMS } from './production.constants';
import {
  createWorkOrderSchema, updateWorkOrderSchema, releaseSchema, confirmSchema,
  completeSchema, changeStatusSchema, listQuerySchema,
} from './production.dto';

/** Compose the Production / Work Order module (repository -> service -> controller) and routes. */
export function productionRouter(pool: Pool): Router {
  const controller = new ProductionController(new ProductionService(new ProductionRepository(pool)));
  const r = Router();
  const P = WO_PERMS;

  // Export must precede '/:id' so it is not captured as an id.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createWorkOrderSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateWorkOrderSchema),
    asyncHandler(controller.update));

  // release to the shop floor — only WORK_ORDER.APPROVE holders (Production); material-ready gate
  r.post('/:id/release',
    requirePermission(P.APPROVE),
    validate(releaseSchema),
    asyncHandler(controller.release));

  r.post('/:id/confirm',
    requirePermission(P.EDIT),
    validate(confirmSchema),
    asyncHandler(controller.confirm));

  r.post('/:id/complete',
    requirePermission(P.EDIT),
    validate(completeSchema),
    asyncHandler(controller.complete));

  r.post('/:id/status',
    requirePermission(P.EDIT),
    validate(changeStatusSchema),
    asyncHandler(controller.changeStatus));

  return r;
}
