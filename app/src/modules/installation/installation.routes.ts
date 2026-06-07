import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { InstallationRepository } from './installation.repository';
import { InstallationService } from './installation.service';
import { InstallationController } from './installation.controller';
import { INSTALLATION_PERMS } from './installation.constants';
import {
  createInstallationSchema, updateInstallationSchema, commissionSchema, acceptSchema,
  versionSchema, listQuerySchema,
} from './installation.dto';

/** Compose the Installation module (repository -> service -> controller) and routes. */
export function installationRouter(pool: Pool): Router {
  const controller = new InstallationController(new InstallationService(new InstallationRepository(pool)));
  const r = Router();
  const P = INSTALLATION_PERMS;

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
    validate(createInstallationSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateInstallationSchema),
    asyncHandler(controller.update));

  // Begin site work — INSTALLATION.EDIT.
  r.post('/:id/start',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.start));

  // Record the SAT outcome (PASS/FAIL) — INSTALLATION.EDIT.
  r.post('/:id/commission',
    requirePermission(P.EDIT),
    validate(commissionSchema),
    asyncHandler(controller.commission));

  // Customer sign-off / acceptance (gated) — INSTALLATION.APPROVE.
  r.post('/:id/accept',
    requirePermission(P.APPROVE),
    validate(acceptSchema),
    asyncHandler(controller.accept));

  // Handover complete — INSTALLATION.EDIT.
  r.post('/:id/close',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.close));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
