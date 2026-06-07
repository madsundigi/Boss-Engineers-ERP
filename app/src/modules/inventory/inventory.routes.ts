import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { INVENTORY_PERMS } from './inventory.constants';
import {
  stockListQuerySchema, createAdjustmentSchema, approveAdjustmentSchema,
  createReservationSchema, createIssueSchema, criticalListQuerySchema,
} from './inventory.dto';

/** Compose the inventory module (repository -> service -> controller) and routes. */
export function inventoryRouter(pool: Pool): Router {
  const controller = new InventoryController(new InventoryService(new InventoryRepository(pool)));
  const r = Router();

  // ---- Stock balances --------------------------------------------------
  // Export must precede any '/:id'-style routes so it is not captured as an id.
  r.get('/stock/export',
    requirePermission(INVENTORY_PERMS.EXPORT),
    validate(stockListQuerySchema, 'query'),
    asyncHandler(controller.exportStock));

  r.get('/stock',
    requirePermission(INVENTORY_PERMS.VIEW),
    validate(stockListQuerySchema, 'query'),
    asyncHandler(controller.listStock));

  // ---- Critical-item register -----------------------------------------
  r.get('/critical-items',
    requirePermission(INVENTORY_PERMS.VIEW),
    validate(criticalListQuerySchema, 'query'),
    asyncHandler(controller.listCritical));

  // ---- Reserve / Issue -------------------------------------------------
  r.post('/reservations',
    requirePermission(INVENTORY_PERMS.CREATE),
    validate(createReservationSchema),
    asyncHandler(controller.reserve));

  r.post('/issues',
    requirePermission(INVENTORY_PERMS.CREATE),
    validate(createIssueSchema),
    asyncHandler(controller.issue));

  // ---- Stock adjustments / receipts / write-offs ----------------------
  r.get('/adjustments',
    requirePermission(INVENTORY_PERMS.VIEW),
    asyncHandler(controller.listAdjustments));

  r.post('/adjustments',
    requirePermission(INVENTORY_PERMS.CREATE),
    validate(createAdjustmentSchema),
    asyncHandler(controller.createAdjustment));

  r.get('/adjustments/:id',
    requirePermission(INVENTORY_PERMS.VIEW),
    asyncHandler(controller.getAdjustment));

  // Approve posts the adjustment to stock; write-offs require INVENTORY.APPROVE
  // (enforced in the service so a non-write-off still posts under EDIT).
  r.post('/adjustments/:id/approve',
    requirePermission(INVENTORY_PERMS.APPROVE),
    validate(approveAdjustmentSchema),
    asyncHandler(controller.approveAdjustment));

  r.post('/adjustments/:id/reject',
    requirePermission(INVENTORY_PERMS.EDIT),
    validate(approveAdjustmentSchema),
    asyncHandler(controller.rejectAdjustment));

  return r;
}
