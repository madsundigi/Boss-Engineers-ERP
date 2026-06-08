import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { EhsService } from './ehs.service';
import { CreateIncidentDto, UpdateIncidentDto, VersionDto, ListQueryDto } from './ehs.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class EhsController {
  constructor(private readonly svc: EhsService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.create(ctxOf(req), valid<CreateIncidentDto>(req)));
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };
  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.svc.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.type('text/csv').send(csv);
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getById(ctxOf(req), idOf(req)));
  };
  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.update(ctxOf(req), idOf(req), valid<UpdateIncidentDto>(req)));
  };
  startInvestigation = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.startInvestigation(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  close = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.close(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  remove = async (req: Request, res: Response): Promise<void> => {
    await this.svc.delete(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };
}
