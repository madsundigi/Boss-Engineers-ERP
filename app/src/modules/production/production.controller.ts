import { Request, Response } from 'express';
import { ProductionService } from './production.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateWorkOrderDto, UpdateWorkOrderDto, ReleaseDto, ConfirmDto, CompleteDto,
  ChangeStatusDto, ListQueryDto,
} from './production.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class ProductionController {
  constructor(private readonly service: ProductionService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateWorkOrderDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateWorkOrderDto>(req)));
  };

  release = async (req: Request, res: Response) => {
    res.json(await this.service.release(ctxOf(req), idOf(req), valid<ReleaseDto>(req)));
  };

  confirm = async (req: Request, res: Response) => {
    res.json(await this.service.confirm(ctxOf(req), idOf(req), valid<ConfirmDto>(req)));
  };

  complete = async (req: Request, res: Response) => {
    res.json(await this.service.complete(ctxOf(req), idOf(req), valid<CompleteDto>(req)));
  };

  changeStatus = async (req: Request, res: Response) => {
    res.json(await this.service.changeStatus(ctxOf(req), idOf(req), valid<ChangeStatusDto>(req)));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="work-orders.csv"');
    res.send(csv);
  };
}
