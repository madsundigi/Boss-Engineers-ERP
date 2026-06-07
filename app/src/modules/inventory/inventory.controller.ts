import { Request, Response } from 'express';
import { InventoryService } from './inventory.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  StockListQueryDto, CreateAdjustmentDto, CreateReservationDto, CreateIssueDto, CriticalListQueryDto,
} from './inventory.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  // ---- stock ----
  listStock = async (req: Request, res: Response) => {
    const result = await this.service.listStock(ctxOf(req), valid<StockListQueryDto>(req, 'query'));
    res.json(result);
  };

  exportStock = async (req: Request, res: Response) => {
    const csv = await this.service.exportStockCsv(ctxOf(req), valid<StockListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock.csv"');
    res.send(csv);
  };

  // ---- adjustments ----
  listAdjustments = async (req: Request, res: Response) => {
    res.json(await this.service.listAdjustments(ctxOf(req)));
  };

  createAdjustment = async (req: Request, res: Response) => {
    const created = await this.service.createAdjustment(ctxOf(req), valid<CreateAdjustmentDto>(req));
    res.status(201).json(created);
  };

  getAdjustment = async (req: Request, res: Response) => {
    res.json(await this.service.getAdjustment(ctxOf(req), idOf(req)));
  };

  approveAdjustment = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.approveAdjustment(ctxOf(req), idOf(req), rowVersion));
  };

  rejectAdjustment = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.rejectAdjustment(ctxOf(req), idOf(req), rowVersion));
  };

  // ---- reserve / issue ----
  reserve = async (req: Request, res: Response) => {
    const created = await this.service.reserve(ctxOf(req), valid<CreateReservationDto>(req));
    res.status(201).json(created);
  };

  issue = async (req: Request, res: Response) => {
    const created = await this.service.issue(ctxOf(req), valid<CreateIssueDto>(req));
    res.status(201).json(created);
  };

  // ---- critical items ----
  listCritical = async (req: Request, res: Response) => {
    res.json(await this.service.listCritical(ctxOf(req), valid<CriticalListQueryDto>(req, 'query')));
  };
}
