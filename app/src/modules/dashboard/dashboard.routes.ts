import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { DASHBOARD_PERMS } from './dashboard.constants';
import { dashboardQuerySchema } from './dashboard.dto';

/**
 * Compose the CEO / Management Dashboard module (repository -> service -> controller)
 * and its routes. READ-ONLY: only GET endpoints (KPI summary, sales funnel) plus a
 * CSV export — no create/update/delete, no outbox events. Deny-by-default RBAC:
 * every read requires DASHBOARD.VIEW; the export additionally requires DASHBOARD.EXPORT.
 */
export function dashboardRouter(pool: Pool): Router {
  const controller = new DashboardController(new DashboardService(new DashboardRepository(pool)));
  const r = Router();
  const P = DASHBOARD_PERMS;

  // Export must precede any parameterised route so it is not captured as a param.
  r.get('/kpis/export',
    requirePermission(P.EXPORT),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/kpis',
    requirePermission(P.VIEW),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(controller.kpis));

  r.get('/sales-funnel',
    requirePermission(P.VIEW),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(controller.salesFunnel));

  r.get('/trends',
    requirePermission(P.VIEW),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(controller.trends));

  return r;
}
