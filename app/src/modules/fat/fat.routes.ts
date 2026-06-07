import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { FatRepository } from './fat.repository';
import { FatService } from './fat.service';
import { FatController } from './fat.controller';
import { FAT_PERMS } from './fat.constants';
import {
  createFatSchema, updateFatSchema, recordResultSchema, changeStatusSchema, approveSchema, listQuerySchema,
} from './fat.dto';

/** Compose the FAT module (repository -> service -> controller) and routes. */
export function fatRouter(pool: Pool): Router {
  const controller = new FatController(new FatService(new FatRepository(pool)));
  const r = Router();
  const P = FAT_PERMS;

  // Export must precede '/:id' so it is not captured as an id.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createFatSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateFatSchema),
    asyncHandler(controller.update));

  r.post('/:id/result',
    requirePermission(P.EDIT),
    validate(recordResultSchema),
    asyncHandler(controller.recordResult));

  r.post('/:id/status',
    requirePermission(P.EDIT),
    validate(changeStatusSchema),
    asyncHandler(controller.changeStatus));

  // sign-off gate — only FAT.APPROVE holders (QC); yields the Dispatch-clearance state
  r.post('/:id/approve',
    requirePermission(P.APPROVE),
    validate(approveSchema),
    asyncHandler(controller.approve));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
