import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { WarehousesRepository } from './warehouses.repository';
import { WarehousesService } from './warehouses.service';
import { WarehousesController } from './warehouses.controller';
import { WAREHOUSE_PERMS } from './warehouses.constants';
import { createWarehouseSchema, updateWarehouseSchema, listQuerySchema } from './warehouses.dto';

/**
 * Compose the Warehouse master module (repository -> service -> controller). Gated on
 * the INVENTORY RBAC domain (no WAREHOUSE domain exists — warehouses are inventory
 * locations). DELETE carries no rowVersion query param: mdm.warehouse has no
 * row_version, so there is no optimistic-concurrency token to pass.
 */
export function warehousesRouter(pool: Pool): Router {
  const controller = new WarehousesController(new WarehousesService(new WarehousesRepository(pool)));
  const r = Router();

  r.get('/', requirePermission(WAREHOUSE_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(WAREHOUSE_PERMS.CREATE), validate(createWarehouseSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(WAREHOUSE_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(WAREHOUSE_PERMS.EDIT), validate(updateWarehouseSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(WAREHOUSE_PERMS.DELETE), asyncHandler(controller.remove));

  return r;
}
