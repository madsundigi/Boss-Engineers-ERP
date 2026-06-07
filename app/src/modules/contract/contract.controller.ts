import { Request, Response } from 'express';
import { ContractService } from './contract.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateContractDto, UpdateContractDto, CancelDto, VersionDto, ListQueryDto,
} from './contract.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class ContractController {
  constructor(private readonly service: ContractService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateContractDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateContractDto>(req)));
  };

  activate = async (req: Request, res: Response) => {
    res.json(await this.service.activate(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  close = async (req: Request, res: Response) => {
    res.json(await this.service.close(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  cancel = async (req: Request, res: Response) => {
    res.json(await this.service.cancel(ctxOf(req), idOf(req), valid<CancelDto>(req)));
  };

  invoiceMilestone = async (req: Request, res: Response) => {
    res.json(await this.service.markMilestoneInvoiced(ctxOf(req), idOf(req), idOf(req, 'milestoneId')));
  };

  payMilestone = async (req: Request, res: Response) => {
    res.json(await this.service.markMilestonePaid(ctxOf(req), idOf(req), idOf(req, 'milestoneId')));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contracts.csv"');
    res.send(csv);
  };
}
