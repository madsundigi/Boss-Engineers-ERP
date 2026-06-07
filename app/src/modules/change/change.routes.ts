import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ChangeOrderRepository } from './change.repository';
import { ChangeOrderService } from './change.service';
import { ChangeOrderController } from './change.controller';
import { CHANGE_PERMS } from './change.constants';
import {
  createChangeOrderSchema, updateChangeOrderSchema, rejectSchema, versionSchema, listQuerySchema,
} from './change.dto';

/** Compose the Change / Variation module (repository -> service -> controller) and routes. */
export function changeRouter(pool: Pool): Router {
  const controller = new ChangeOrderController(new ChangeOrderService(new ChangeOrderRepository(pool)));
  const r = Router();
  const P = CHANGE_PERMS;

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
    validate(createChangeOrderSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateChangeOrderSchema),
    asyncHandler(controller.update));

  // Submit a DRAFT variation for approval — CHANGE_ORDER.EDIT (Planning).
  r.post('/:id/submit',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.submit));

  // Approve a SUBMITTED variation (SoD: approver != creator) — CHANGE_ORDER.APPROVE (CEO/Finance).
  r.post('/:id/approve',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.approve));

  // Reject a SUBMITTED variation with a reason — CHANGE_ORDER.APPROVE (CEO/Finance).
  r.post('/:id/reject',
    requirePermission(P.APPROVE),
    validate(rejectSchema),
    asyncHandler(controller.reject));

  // Mark an APPROVED variation as IMPLEMENTED — CHANGE_ORDER.EDIT (Planning).
  r.post('/:id/implement',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.implement));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.cancel));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
