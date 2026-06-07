import { Request, Response } from 'express';
import { ProcurementService } from './procurement.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreatePrDto, CreatePoDto, ReceiveGrnDto,
  PrListQueryDto, PoListQueryDto, GrnListQueryDto,
} from './procurement.dto';

function ctxOf(req: Request): RequestContext { if (!req.context) throw Errors.unauthorized(); return req.context; }
function num(v: string, label: string): number {
  const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw Errors.badRequest(`Invalid ${label}`); return n;
}
const idOf = (req: Request) => num(req.params.id, 'id');
const ver = (req: Request) => valid<{ rowVersion: number }>(req).rowVersion;

export class ProcurementController {
  constructor(private readonly service: ProcurementService) {}

  // ---- Purchase Requisition ----
  listPr = async (req: Request, res: Response) =>
    res.json(await this.service.listPr(ctxOf(req), valid<PrListQueryDto>(req, 'query')));

  createPr = async (req: Request, res: Response) =>
    res.status(201).json(await this.service.createPr(ctxOf(req), valid<CreatePrDto>(req)));

  getPr = async (req: Request, res: Response) =>
    res.json(await this.service.getPr(ctxOf(req), idOf(req)));

  submitPr = async (req: Request, res: Response) =>
    res.json(await this.service.submitPr(ctxOf(req), idOf(req), ver(req)));

  approvePr = async (req: Request, res: Response) =>
    res.json(await this.service.approvePr(ctxOf(req), idOf(req), ver(req)));

  // ---- Purchase Order ----
  listPo = async (req: Request, res: Response) =>
    res.json(await this.service.listPo(ctxOf(req), valid<PoListQueryDto>(req, 'query')));

  createPo = async (req: Request, res: Response) =>
    res.status(201).json(await this.service.createPo(ctxOf(req), valid<CreatePoDto>(req)));

  getPo = async (req: Request, res: Response) =>
    res.json(await this.service.getPo(ctxOf(req), idOf(req)));

  approvePo = async (req: Request, res: Response) =>
    res.json(await this.service.approvePo(ctxOf(req), idOf(req), ver(req)));

  // ---- Goods Receipt ----
  listGrn = async (req: Request, res: Response) =>
    res.json(await this.service.listGrn(ctxOf(req), valid<GrnListQueryDto>(req, 'query')));

  receiveGrn = async (req: Request, res: Response) =>
    res.status(201).json(await this.service.receiveGrn(ctxOf(req), valid<ReceiveGrnDto>(req)));

  getGrn = async (req: Request, res: Response) =>
    res.json(await this.service.getGrn(ctxOf(req), idOf(req)));
}
