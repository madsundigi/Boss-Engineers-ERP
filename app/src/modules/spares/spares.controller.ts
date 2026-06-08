import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { SparesService } from './spares.service';
import {
  CreatePartDto, UpdatePartDto, SetActiveDto, VersionDto, AdjustStockDto, ListQueryDto,
} from './spares.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class SparesController {
  constructor(private readonly svc: SparesService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.create(ctxOf(req), valid<CreatePartDto>(req)));
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };
  lowStock = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.lowStock(ctxOf(req)));
  };
  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.svc.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.type('text/csv').send(csv);
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getById(ctxOf(req), idOf(req)));
  };
  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.update(ctxOf(req), idOf(req), valid<UpdatePartDto>(req)));
  };
  setActive = async (req: Request, res: Response): Promise<void> => {
    const dto = valid<SetActiveDto>(req);
    res.json(await this.svc.setActive(ctxOf(req), idOf(req), dto.rowVersion, dto.isActive));
  };
  remove = async (req: Request, res: Response): Promise<void> => {
    await this.svc.delete(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };

  adjustStock = async (req: Request, res: Response): Promise<void> => {
    const dto = valid<AdjustStockDto>(req);
    res.json(await this.svc.adjustStock(ctxOf(req), idOf(req), dto.location, dto.delta));
  };
  stockByPart = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.stockByPart(ctxOf(req), idOf(req)));
  };
}
