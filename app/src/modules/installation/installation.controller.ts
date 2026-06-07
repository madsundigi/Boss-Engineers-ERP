import { Request, Response } from 'express';
import { InstallationService } from './installation.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateInstallationDto, UpdateInstallationDto, CommissionDto, AcceptDto, VersionDto, ListQueryDto,
} from './installation.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class InstallationController {
  constructor(private readonly service: InstallationService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateInstallationDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateInstallationDto>(req)));
  };

  start = async (req: Request, res: Response) => {
    res.json(await this.service.start(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  commission = async (req: Request, res: Response) => {
    res.json(await this.service.commission(ctxOf(req), idOf(req), valid<CommissionDto>(req)));
  };

  accept = async (req: Request, res: Response) => {
    res.json(await this.service.accept(ctxOf(req), idOf(req), valid<AcceptDto>(req)));
  };

  close = async (req: Request, res: Response) => {
    res.json(await this.service.close(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="installations.csv"');
    res.send(csv);
  };
}
