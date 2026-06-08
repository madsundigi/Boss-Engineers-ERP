import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { MaintenanceRepository } from './maintenance.repository';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceController } from './maintenance.controller';
import { MAINTENANCE_PERMS } from './maintenance.constants';
import {
  createAssetSchema, updateAssetSchema, setAssetStatusSchema, assetListQuerySchema,
  createWoSchema, updateWoSchema, versionSchema, woListQuerySchema,
} from './maintenance.dto';

/**
 * Compose the Plant Maintenance module (repository -> service -> controller) and its
 * routes. Two sub-resources under the mount point:
 *   /assets       — the asset / tooling register
 *   /work-orders  — the maintenance work orders (MWO)
 */
export function maintenanceRouter(pool: Pool): Router {
  const controller = new MaintenanceController(new MaintenanceService(new MaintenanceRepository(pool)));
  const r = Router();
  const P = MAINTENANCE_PERMS;

  // --- Asset register ---
  r.get('/assets',
    requirePermission(P.VIEW), validate(assetListQuerySchema, 'query'),
    asyncHandler(controller.listAssets));
  r.post('/assets',
    requirePermission(P.CREATE), validate(createAssetSchema),
    asyncHandler(controller.createAsset));

  r.get('/assets/:id',
    requirePermission(P.VIEW), asyncHandler(controller.getAsset));
  r.patch('/assets/:id',
    requirePermission(P.EDIT), validate(updateAssetSchema),
    asyncHandler(controller.updateAsset));
  r.post('/assets/:id/status',
    requirePermission(P.EDIT), validate(setAssetStatusSchema),
    asyncHandler(controller.setAssetStatus));
  r.delete('/assets/:id',
    requirePermission(P.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.removeAsset));

  // --- Maintenance work orders (MWO). Export must precede '/:id'. ---
  r.get('/work-orders/export',
    requirePermission(P.EXPORT), validate(woListQuerySchema, 'query'),
    asyncHandler(controller.exportWoCsv));

  r.get('/work-orders',
    requirePermission(P.VIEW), validate(woListQuerySchema, 'query'),
    asyncHandler(controller.listWo));
  r.post('/work-orders',
    requirePermission(P.CREATE), validate(createWoSchema),
    asyncHandler(controller.createWo));

  r.get('/work-orders/:id',
    requirePermission(P.VIEW), asyncHandler(controller.getWo));
  r.patch('/work-orders/:id',
    requirePermission(P.EDIT), validate(updateWoSchema),
    asyncHandler(controller.updateWo));
  r.delete('/work-orders/:id',
    requirePermission(P.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.removeWo));

  // Work-order lifecycle: OPEN -> IN_PROGRESS -> DONE (+ CANCELLED).
  r.post('/work-orders/:id/start',
    requirePermission(P.EDIT), validate(versionSchema),
    asyncHandler(controller.startWo));
  r.post('/work-orders/:id/complete',
    requirePermission(P.EDIT), validate(versionSchema),
    asyncHandler(controller.completeWo));
  r.post('/work-orders/:id/cancel',
    requirePermission(P.EDIT), validate(versionSchema),
    asyncHandler(controller.cancelWo));

  return r;
}
