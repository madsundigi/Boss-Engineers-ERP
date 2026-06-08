import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { UserRepository } from './users.repository';
import { UserService } from './users.service';
import { UserController } from './users.controller';
import { USER_PERMS, ROLE_PERMS } from './users.constants';
import {
  createUserSchema, updateUserSchema, assignRolesSchema, resetPasswordSchema,
  versionQuerySchema, listQuerySchema,
} from './users.dto';

/** Build the shared controller (repository -> service -> controller) for both routers. */
function buildController(pool: Pool): UserController {
  return new UserController(new UserService(new UserRepository(pool)));
}

/**
 * usersRouter — mount at /api/users. User administration: list/get (USER_MGMT.VIEW),
 * create (USER_MGMT.CREATE), update / assign-roles / reset-password / deactivate
 * (USER_MGMT.EDIT), soft-delete (USER_MGMT.DELETE).
 */
export function usersRouter(pool: Pool): Router {
  const controller = buildController(pool);
  const r = Router();
  const P = USER_PERMS;

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createUserSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateUserSchema),
    asyncHandler(controller.update));

  // Replace the user's full set of roles (least-privilege assignment).
  r.put('/:id/roles',
    requirePermission(P.EDIT),
    validate(assignRolesSchema),
    asyncHandler(controller.assignRoles));

  // Admin reset of another user's password.
  r.post('/:id/password',
    requirePermission(P.EDIT),
    validate(resetPasswordSchema),
    asyncHandler(controller.resetPassword));

  r.delete('/:id',
    requirePermission(P.DELETE),
    validate(versionQuerySchema, 'query'),
    asyncHandler(controller.remove));

  return r;
}

/**
 * rolesRouter — mount at /api/roles. The READ-ONLY role catalog (ROLE_MGMT.VIEW):
 * each role with the permission codes it grants, so the UI can show what each
 * least-privilege role can do. This module never creates or edits roles.
 */
export function rolesRouter(pool: Pool): Router {
  const controller = buildController(pool);
  const r = Router();

  r.get('/',
    requirePermission(ROLE_PERMS.VIEW),
    asyncHandler(controller.roleCatalog));

  return r;
}
