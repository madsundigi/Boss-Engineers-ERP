import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { RiskRepository } from './risk.repository';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';
import { RISK_PERMS } from './risk.constants';
import { createRiskSchema, updateRiskSchema, versionSchema, listQuerySchema } from './risk.dto';

/** Compose the Project Risk Register module (repository -> service -> controller). */
export function riskRouter(pool: Pool): Router {
  const controller = new RiskController(new RiskService(new RiskRepository(pool)));
  const r = Router();

  r.get('/export', requirePermission(RISK_PERMS.EXPORT), validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));
  r.get('/heatmap', requirePermission(RISK_PERMS.VIEW), asyncHandler(controller.heatmap));

  r.get('/', requirePermission(RISK_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(RISK_PERMS.CREATE), validate(createRiskSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(RISK_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(RISK_PERMS.EDIT), validate(updateRiskSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(RISK_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  r.post('/:id/start-mitigation', requirePermission(RISK_PERMS.EDIT), validate(versionSchema),
    asyncHandler(controller.startMitigation));
  r.post('/:id/close', requirePermission(RISK_PERMS.APPROVE), validate(versionSchema),
    asyncHandler(controller.close));
  r.post('/:id/accept', requirePermission(RISK_PERMS.APPROVE), validate(versionSchema),
    asyncHandler(controller.accept));

  return r;
}
