import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { FailureRepository } from './failure.repository';
import { FailureService } from './failure.service';
import { FailureController } from './failure.controller';
import { FAILURE_PERMS } from './failure.constants';
import {
  createNcrSchema, addRcaSchema, addCapaSchema, addCapaActionSchema,
  updateCapaStatusSchema, versionSchema, listQuerySchema,
} from './failure.dto';

/** Compose the Failure Analysis module (repository -> service -> controller) and routes. */
export function failureRouter(pool: Pool): Router {
  const controller = new FailureController(new FailureService(new FailureRepository(pool)));
  const r = Router();
  const P = FAILURE_PERMS;

  // Export must precede '/:id' so it is not captured as an id.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  // Anyone on the floor can raise an NCR (NCR_CAPA.CREATE).
  r.post('/',
    requirePermission(P.CREATE),
    validate(createNcrSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  // Recording the analysis + the corrective/preventive actions is QC's job (NCR_CAPA.EDIT).
  r.post('/:id/rca',
    requirePermission(P.EDIT),
    validate(addRcaSchema),
    asyncHandler(controller.addRca));

  r.post('/:id/capa',
    requirePermission(P.EDIT),
    validate(addCapaSchema),
    asyncHandler(controller.addCapa));

  r.post('/:id/capa/:capaId/actions',
    requirePermission(P.EDIT),
    validate(addCapaActionSchema),
    asyncHandler(controller.addCapaAction));

  r.patch('/:id/capa/:capaId',
    requirePermission(P.EDIT),
    validate(updateCapaStatusSchema),
    asyncHandler(controller.updateCapaStatus));

  // Closing the NCR is the effectiveness-verification gate — NCR_CAPA.APPROVE (QC).
  r.post('/:id/close',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.close));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
