import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { DispatchRepository } from './dispatch.repository';
import { DispatchService } from './dispatch.service';
import { DispatchController } from './dispatch.controller';
import { DISPATCH_PERMS } from './dispatch.constants';
import {
  createDispatchSchema, updateDispatchSchema, clearSchema, cancelSchema, versionSchema, listQuerySchema,
} from './dispatch.dto';

/** Compose the Dispatch module (repository -> service -> controller) and routes. */
export function dispatchRouter(pool: Pool): Router {
  const controller = new DispatchController(new DispatchService(new DispatchRepository(pool)));
  const r = Router();
  const P = DISPATCH_PERMS;

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
    validate(createDispatchSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateDispatchSchema),
    asyncHandler(controller.update));

  // Quality clearance gate — DISPATCH.APPROVE (intended for QC).
  r.post('/:id/clear-quality',
    requirePermission(P.APPROVE),
    validate(clearSchema),
    asyncHandler(controller.clearQuality));

  // Commercial / payment clearance gate — DISPATCH.APPROVE (intended for Finance).
  r.post('/:id/clear-commercial',
    requirePermission(P.APPROVE),
    validate(clearSchema),
    asyncHandler(controller.clearCommercial));

  // Release the shipment (both gates must be cleared) — DISPATCH.EDIT (Stores/Logistics).
  r.post('/:id/release',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.release));

  r.post('/:id/deliver',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.deliver));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(cancelSchema),
    asyncHandler(controller.cancel));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
