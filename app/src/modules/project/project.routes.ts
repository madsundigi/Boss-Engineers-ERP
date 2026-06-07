import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { PROJECT_PERMS } from './project.constants';
import {
  createProjectSchema, updateProjectSchema, changeStatusSchema, approveSchema, listQuerySchema,
} from './project.dto';

/** Compose the project module (repository -> service -> controller) and routes. */
export function projectRouter(pool: Pool): Router {
  const controller = new ProjectController(new ProjectService(new ProjectRepository(pool)));
  const r = Router();
  const P = PROJECT_PERMS;

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
    validate(createProjectSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateProjectSchema),
    asyncHandler(controller.update));

  r.post('/:id/status',
    requirePermission(P.EDIT),
    validate(changeStatusSchema),
    asyncHandler(controller.changeStatus));

  // charter / budget approval gate — only PROJECT.APPROVE holders (Finance / CEO)
  r.post('/:id/approve',
    requirePermission(P.APPROVE),
    validate(approveSchema),
    asyncHandler(controller.approve));

  return r;
}
