import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { WorkCentersService } from './workcenters.service';
import { CreateWorkCenterDto, UpdateWorkCenterDto, ListQueryDto } from './workcenters.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class WorkCentersController {
  constructor(private readonly svc: WorkCentersService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.create(ctxOf(req), valid<CreateWorkCenterDto>(req)));
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getById(ctxOf(req), idOf(req)));
  };
  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.update(ctxOf(req), idOf(req), valid<UpdateWorkCenterDto>(req)));
  };
  remove = async (req: Request, res: Response): Promise<void> => {
    await this.svc.delete(ctxOf(req), idOf(req));
    res.status(204).end();
  };
}
