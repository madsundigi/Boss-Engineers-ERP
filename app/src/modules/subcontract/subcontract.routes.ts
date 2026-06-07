import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { SubcontractRepository } from './subcontract.repository';
import { SubcontractService } from './subcontract.service';
import { SubcontractController } from './subcontract.controller';
import { SUBCONTRACT_PERMS } from './subcontract.constants';
import {
  createSubcontractSchema, updateSubcontractSchema, issueSchema, receiveSchema,
  cancelSchema, versionSchema, listQuerySchema,
} from './subcontract.dto';

/** Compose the Subcontracting module (repository -> service -> controller) and routes. */
export function subcontractRouter(pool: Pool): Router {
  const controller = new SubcontractController(new SubcontractService(new SubcontractRepository(pool)));
  const r = Router();
  const P = SUBCONTRACT_PERMS;

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
    validate(createSubcontractSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateSubcontractSchema),
    asyncHandler(controller.update));

  // Issue raw material to the vendor (OPEN -> ISSUED) — SUBCONTRACT.EDIT.
  r.post('/:id/issue',
    requirePermission(P.EDIT),
    validate(issueSchema),
    asyncHandler(controller.issue));

  // Receive processed goods back (ISSUED -> RECEIVED) — SUBCONTRACT.EDIT.
  r.post('/:id/receive',
    requirePermission(P.EDIT),
    validate(receiveSchema),
    asyncHandler(controller.receive));

  // Close a fully-received order (RECEIVED -> CLOSED) — SUBCONTRACT.APPROVE.
  r.post('/:id/close',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.close));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(cancelSchema),
    asyncHandler(controller.cancel));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
