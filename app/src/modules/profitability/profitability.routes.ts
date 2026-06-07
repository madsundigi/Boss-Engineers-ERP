import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ProfitabilityRepository } from './profitability.repository';
import { ProfitabilityService } from './profitability.service';
import { ProfitabilityController } from './profitability.controller';
import { PROFITABILITY_PERMS } from './profitability.constants';
import { computeSnapshotSchema, listQuerySchema } from './profitability.dto';

/**
 * Compose the Profitability module (repository -> service -> controller) and its
 * routes. Append-only: compute (insert) + reads + CSV export only — there is NO
 * update and NO delete endpoint (a margin snapshot is an immutable record).
 */
export function profitabilityRouter(pool: Pool): Router {
  const controller = new ProfitabilityController(
    new ProfitabilityService(new ProfitabilityRepository(pool)));
  const r = Router();
  const P = PROFITABILITY_PERMS;

  // Static segments must precede the parameterised routes so they are not captured.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  // Management portfolio view: one row per project (its latest snapshot's margin).
  r.get('/portfolio',
    requirePermission(P.VIEW),
    asyncHandler(controller.portfolio));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  // Compute & append a new margin snapshot for a project.
  r.post('/compute',
    requirePermission(P.CREATE),
    validate(computeSnapshotSchema),
    asyncHandler(controller.compute));

  // Latest snapshot for a project (404 if the project has none).
  r.get('/latest/:projectId',
    requirePermission(P.VIEW),
    asyncHandler(controller.getLatest));

  // Latest snapshot expanded into a P&L shape (404 if none).
  r.get('/pnl/:projectId',
    requirePermission(P.VIEW),
    asyncHandler(controller.projectPnl));

  return r;
}
