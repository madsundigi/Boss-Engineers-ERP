import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { CrmRepository } from './crm.repository';
import { CrmService } from './crm.service';
import { CrmController } from './crm.controller';
import { CRM_PERMS } from './crm.constants';
import {
  createOpportunitySchema, updateOpportunitySchema, advanceStageSchema, versionSchema,
  loseSchema, listOpportunityQuerySchema, createActivitySchema, listActivityQuerySchema,
} from './crm.dto';

/**
 * Compose the CRM module (repository -> service -> controller) and routes. Mounted
 * at /api/crm with sub-paths /opportunities, /activities and /customers/:id/360.
 */
export function crmRouter(pool: Pool): Router {
  const controller = new CrmController(new CrmService(new CrmRepository(pool)));
  const r = Router();
  const P = CRM_PERMS;

  // --- Opportunities ---
  // Static sub-routes must precede '/:id' so they are not captured as an id.
  r.get('/opportunities/export', requirePermission(P.EXPORT),
    validate(listOpportunityQuerySchema, 'query'), asyncHandler(controller.exportCsv));
  r.get('/opportunities/pipeline', requirePermission(P.VIEW),
    asyncHandler(controller.pipelineSummary));

  r.get('/opportunities', requirePermission(P.VIEW),
    validate(listOpportunityQuerySchema, 'query'), asyncHandler(controller.listOpportunities));
  r.post('/opportunities', requirePermission(P.CREATE),
    validate(createOpportunitySchema), asyncHandler(controller.createOpportunity));

  r.get('/opportunities/:id', requirePermission(P.VIEW), asyncHandler(controller.getOpportunity));
  r.patch('/opportunities/:id', requirePermission(P.EDIT),
    validate(updateOpportunitySchema), asyncHandler(controller.updateOpportunity));
  r.delete('/opportunities/:id', requirePermission(P.DELETE),
    validate(versionSchema, 'query'), asyncHandler(controller.removeOpportunity));

  // Pipeline stage transitions.
  r.post('/opportunities/:id/advance', requirePermission(P.EDIT),
    validate(advanceStageSchema), asyncHandler(controller.advanceStage));
  r.post('/opportunities/:id/win', requirePermission(P.EDIT),
    validate(versionSchema), asyncHandler(controller.win));
  r.post('/opportunities/:id/lose', requirePermission(P.EDIT),
    validate(loseSchema), asyncHandler(controller.lose));

  // --- Activities ---
  r.get('/activities', requirePermission(P.VIEW),
    validate(listActivityQuerySchema, 'query'), asyncHandler(controller.listActivities));
  r.post('/activities', requirePermission(P.CREATE),
    validate(createActivitySchema), asyncHandler(controller.createActivity));
  r.get('/activities/:id', requirePermission(P.VIEW), asyncHandler(controller.getActivity));
  r.post('/activities/:id/complete', requirePermission(P.EDIT),
    validate(versionSchema), asyncHandler(controller.completeActivity));

  // --- Customer 360 ---
  r.get('/customers/:id/360', requirePermission(P.VIEW), asyncHandler(controller.customer360));

  return r;
}
