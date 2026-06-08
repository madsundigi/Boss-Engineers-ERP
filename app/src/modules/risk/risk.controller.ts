import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { RiskService } from './risk.service';
import { CreateRiskDto, UpdateRiskDto, VersionDto, ListQueryDto } from './risk.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class RiskController {
  constructor(private readonly svc: RiskService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.create(ctxOf(req), valid<CreateRiskDto>(req)));
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };
  heatmap = async (req: Request, res: Response): Promise<void> => {
    const pid = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json(await this.svc.heatmap(ctxOf(req), pid));
  };
  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.svc.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.type('text/csv').send(csv);
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getById(ctxOf(req), idOf(req)));
  };
  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.update(ctxOf(req), idOf(req), valid<UpdateRiskDto>(req)));
  };
  startMitigation = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.startMitigation(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  close = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.close(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  accept = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.accept(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  remove = async (req: Request, res: Response): Promise<void> => {
    await this.svc.delete(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };
}
