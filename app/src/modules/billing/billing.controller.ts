import { Request, Response } from 'express';
import { BillingService } from './billing.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateInvoiceDto, UpdateInvoiceDto, CancelDto, VersionDto, ListQueryDto,
  CreateReceiptDto, ReceiptQueryDto, CreateAdvanceDto, AdjustAdvanceDto, AdvanceQueryDto,
  CreateRetentionDto, ReleaseRetentionDto, RetentionQueryDto, RecognizeRevenueDto,
} from './billing.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class BillingController {
  constructor(private readonly service: BillingService) {}

  // -------- Invoices --------
  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateInvoiceDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateInvoiceDto>(req)));
  };

  post = async (req: Request, res: Response) => {
    res.json(await this.service.post(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  markSent = async (req: Request, res: Response) => {
    res.json(await this.service.markSent(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  cancel = async (req: Request, res: Response) => {
    res.json(await this.service.cancel(ctxOf(req), idOf(req), valid<CancelDto>(req)));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(csv);
  };

  // -------- Receipts & allocation --------
  createReceipt = async (req: Request, res: Response) => {
    const created = await this.service.createReceipt(ctxOf(req), valid<CreateReceiptDto>(req));
    res.status(201).json(created);
  };

  getReceipt = async (req: Request, res: Response) => {
    res.json(await this.service.getReceipt(ctxOf(req), idOf(req)));
  };

  listReceipts = async (req: Request, res: Response) => {
    res.json(await this.service.listReceipts(ctxOf(req), valid<ReceiptQueryDto>(req, 'query')));
  };

  // -------- Advances --------
  createAdvance = async (req: Request, res: Response) => {
    const created = await this.service.createAdvance(ctxOf(req), valid<CreateAdvanceDto>(req));
    res.status(201).json(created);
  };

  listAdvances = async (req: Request, res: Response) => {
    res.json(await this.service.listAdvances(ctxOf(req), valid<AdvanceQueryDto>(req, 'query')));
  };

  adjustAdvance = async (req: Request, res: Response) => {
    res.json(await this.service.adjustAdvance(ctxOf(req), idOf(req), valid<AdjustAdvanceDto>(req)));
  };

  // -------- Retention --------
  createRetention = async (req: Request, res: Response) => {
    const created = await this.service.createRetention(ctxOf(req), valid<CreateRetentionDto>(req));
    res.status(201).json(created);
  };

  listRetentions = async (req: Request, res: Response) => {
    res.json(await this.service.listRetentions(ctxOf(req), valid<RetentionQueryDto>(req, 'query')));
  };

  releaseRetention = async (req: Request, res: Response) => {
    res.json(await this.service.releaseRetention(ctxOf(req), idOf(req), valid<ReleaseRetentionDto>(req)));
  };

  // -------- Revenue recognition --------
  recognizeRevenue = async (req: Request, res: Response) => {
    const created = await this.service.recognizeRevenue(ctxOf(req), valid<RecognizeRevenueDto>(req));
    res.status(201).json(created);
  };

  listRevenue = async (req: Request, res: Response) => {
    res.json(await this.service.listRevenue(ctxOf(req), idOf(req)));
  };
}
