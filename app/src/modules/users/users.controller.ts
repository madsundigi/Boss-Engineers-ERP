import { Request, Response } from 'express';
import { UserService } from './users.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateUserDto, UpdateUserDto, AssignRolesDto, ResetPasswordDto,
  VersionQueryDto, ListQueryDto,
} from './users.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

/** HTTP boundary for both the user-management and role-catalog endpoints. */
export class UserController {
  constructor(private readonly service: UserService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateUserDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateUserDto>(req)));
  };

  assignRoles = async (req: Request, res: Response) => {
    res.json(await this.service.assignRoles(ctxOf(req), idOf(req), valid<AssignRolesDto>(req)));
  };

  resetPassword = async (req: Request, res: Response) => {
    await this.service.resetPassword(ctxOf(req), idOf(req), valid<ResetPasswordDto>(req));
    res.status(204).send();
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req), valid<VersionQueryDto>(req, 'query').rowVersion);
    res.status(204).send();
  };

  // Role catalog (ROLE_MGMT.VIEW) — read-only list of roles + their permissions.
  roleCatalog = async (req: Request, res: Response) => {
    res.json(await this.service.roleCatalog(ctxOf(req)));
  };
}
