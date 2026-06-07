import { Request, Response } from 'express';
import { ChangeOrderService } from './change.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateChangeOrderDto, UpdateChangeOrderDto, RejectDto, VersionDto, ListQueryDto,
} from './change.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class ChangeOrderController {
  constructor(private readonly service: ChangeOrderService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateChangeOrderDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateChangeOrderDto>(req)));
  };

  submit = async (req: Request, res: Response) => {
    res.json(await this.service.submit(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  approve = async (req: Request, res: Response) => {
    res.json(await this.service.approve(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  reject = async (req: Request, res: Response) => {
    res.json(await this.service.reject(ctxOf(req), idOf(req), valid<RejectDto>(req)));
  };

  implement = async (req: Request, res: Response) => {
    res.json(await this.service.markImplemented(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  cancel = async (req: Request, res: Response) => {
    res.json(await this.service.cancel(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="change-orders.csv"');
    res.send(csv);
  };
}
