import { Request, Response } from 'express';
import { ServiceService } from './service.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateTicketDto, UpdateTicketDto, AssignDto, ResolveDto, CancelDto,
  WarrantyClaimDto, VersionDto, ListQueryDto, KpiQueryDto,
} from './service.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class ServiceController {
  constructor(private readonly service: ServiceService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  kpis = async (req: Request, res: Response) => {
    res.json(await this.service.kpis(ctxOf(req), valid<KpiQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateTicketDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateTicketDto>(req)));
  };

  assign = async (req: Request, res: Response) => {
    res.json(await this.service.assign(ctxOf(req), idOf(req), valid<AssignDto>(req)));
  };

  start = async (req: Request, res: Response) => {
    res.json(await this.service.startWork(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  resolve = async (req: Request, res: Response) => {
    res.json(await this.service.resolve(ctxOf(req), idOf(req), valid<ResolveDto>(req)));
  };

  close = async (req: Request, res: Response) => {
    res.json(await this.service.close(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  cancel = async (req: Request, res: Response) => {
    res.json(await this.service.cancel(ctxOf(req), idOf(req), valid<CancelDto>(req)));
  };

  warrantyClaim = async (req: Request, res: Response) => {
    const claim = await this.service.warrantyClaim(ctxOf(req), idOf(req), valid<WarrantyClaimDto>(req));
    res.status(201).json(claim);
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="service-tickets.csv"');
    res.send(csv);
  };
}
