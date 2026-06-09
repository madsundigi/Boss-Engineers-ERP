import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { FatProtocolRepository } from './fatprotocol.repository';
import { FatProtocolService } from './fatprotocol.service';
import { FatProtocolController } from './fatprotocol.controller';
import { FAT_PERMS } from './fatprotocol.constants';
import { createProtocolSchema, updateProtocolSchema, listQuerySchema } from './fatprotocol.dto';

/**
 * Compose the FAT Protocol master-data module (repository -> service -> controller).
 * Mounted by the composition root as `app.use('/api/fat-protocols', fatProtocolRouter(pool))`.
 * Gated on the existing 'FAT' RBAC domain (QC owns it VCEDAX; others read-only).
 */
export function fatProtocolRouter(pool: Pool): Router {
  const controller = new FatProtocolController(
    new FatProtocolService(new FatProtocolRepository(pool)),
  );
  const r = Router();

  r.get('/', requirePermission(FAT_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(FAT_PERMS.CREATE), validate(createProtocolSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(FAT_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(FAT_PERMS.EDIT), validate(updateProtocolSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(FAT_PERMS.DELETE), asyncHandler(controller.remove));

  return r;
}
