import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { BomRepository } from './bom.repository';
import { BomService } from './bom.service';
import { BomController } from './bom.controller';
import { BOM_PERMS } from './bom.constants';
import { createBomSchema, updateBomSchema, versionSchema, listQuerySchema } from './bom.dto';

/** Compose the BOM module (repository -> service -> controller) and routes. */
export function bomRouter(pool: Pool): Router {
  const controller = new BomController(new BomService(new BomRepository(pool)));
  const r = Router();
  const P = BOM_PERMS;

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
    validate(createBomSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateBomSchema),
    asyncHandler(controller.update));

  // Release (engineering sign-off) — no BOM.APPROVE grant exists, so guard with EDIT.
  r.post('/:id/release',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.release));

  // Supersede a released BOM — guarded with EDIT (no BOM.APPROVE grant).
  r.post('/:id/obsolete',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.obsolete));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
