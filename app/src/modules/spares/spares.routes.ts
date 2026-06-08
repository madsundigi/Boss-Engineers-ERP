import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { SparesRepository } from './spares.repository';
import { SparesService } from './spares.service';
import { SparesController } from './spares.controller';
import { SPARE_PERMS } from './spares.constants';
import {
  createPartSchema, updatePartSchema, setActiveSchema, versionSchema,
  adjustStockSchema, listQuerySchema,
} from './spares.dto';

/** Compose the Spares Catalog & Service Inventory module (repository -> service -> controller). */
export function sparesRouter(pool: Pool): Router {
  const controller = new SparesController(new SparesService(new SparesRepository(pool)));
  const r = Router();

  // Static collection routes BEFORE the '/:id' param routes so they are not shadowed.
  r.get('/export', requirePermission(SPARE_PERMS.EXPORT), validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));
  r.get('/low-stock', requirePermission(SPARE_PERMS.VIEW), asyncHandler(controller.lowStock));

  r.get('/', requirePermission(SPARE_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(SPARE_PERMS.CREATE), validate(createPartSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(SPARE_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(SPARE_PERMS.EDIT), validate(updatePartSchema),
    asyncHandler(controller.update));
  r.patch('/:id/active', requirePermission(SPARE_PERMS.EDIT), validate(setActiveSchema),
    asyncHandler(controller.setActive));
  r.delete('/:id', requirePermission(SPARE_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  // Per-location service inventory.
  r.get('/:id/stock', requirePermission(SPARE_PERMS.VIEW), asyncHandler(controller.stockByPart));
  r.post('/:id/stock', requirePermission(SPARE_PERMS.EDIT), validate(adjustStockSchema),
    asyncHandler(controller.adjustStock));

  return r;
}
