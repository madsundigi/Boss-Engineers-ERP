import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ItemsRepository } from './items.repository';
import { ItemsService } from './items.service';
import { ItemsController } from './items.controller';
import { ITEM_PERMS } from './items.constants';
import { createItemSchema, updateItemSchema, versionSchema, listQuerySchema } from './items.dto';

/** Compose the Item master-data module (repository -> service -> controller).
 *  The composition root mounts this at /api/items:
 *    app.use('/api/items', itemsRouter(pool)); */
export function itemsRouter(pool: Pool): Router {
  const controller = new ItemsController(new ItemsService(new ItemsRepository(pool)));
  const r = Router();

  r.get('/', requirePermission(ITEM_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(ITEM_PERMS.CREATE), validate(createItemSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(ITEM_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(ITEM_PERMS.EDIT), validate(updateItemSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(ITEM_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  return r;
}
