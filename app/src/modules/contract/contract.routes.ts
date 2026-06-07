import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ContractRepository } from './contract.repository';
import { ContractService } from './contract.service';
import { ContractController } from './contract.controller';
import { CONTRACT_PERMS } from './contract.constants';
import {
  createContractSchema, updateContractSchema, cancelSchema, versionSchema, listQuerySchema,
} from './contract.dto';

/** Compose the Contract module (repository -> service -> controller) and routes. */
export function contractRouter(pool: Pool): Router {
  const controller = new ContractController(new ContractService(new ContractRepository(pool)));
  const r = Router();
  const P = CONTRACT_PERMS;

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
    validate(createContractSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateContractSchema),
    asyncHandler(controller.update));

  // Activate (DRAFT -> ACTIVE) — the binding step, CONTRACT.APPROVE + SoD.
  r.post('/:id/activate',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.activate));

  r.post('/:id/close',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.close));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(cancelSchema),
    asyncHandler(controller.cancel));

  // Billing-milestone transitions (CONTRACT.EDIT).
  r.post('/:id/milestones/:milestoneId/invoice',
    requirePermission(P.EDIT),
    asyncHandler(controller.invoiceMilestone));

  r.post('/:id/milestones/:milestoneId/pay',
    requirePermission(P.EDIT),
    asyncHandler(controller.payMilestone));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
