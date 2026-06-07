import { Request, Response } from 'express';
import { ProjectService } from './project.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CreateProjectDto, UpdateProjectDto, ChangeStatusDto, ListQueryDto } from './project.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class ProjectController {
  constructor(private readonly service: ProjectService) {}

  list = async (req: Request, res: Response) => {
    const result = await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.json(result);
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateProjectDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateProjectDto>(req)));
  };

  changeStatus = async (req: Request, res: Response) => {
    res.json(await this.service.changeStatus(ctxOf(req), idOf(req), valid<ChangeStatusDto>(req)));
  };

  approve = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.approve(ctxOf(req), idOf(req), rowVersion));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="projects.csv"');
    res.send(csv);
  };
}
