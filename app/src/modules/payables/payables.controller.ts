import { Request, Response } from 'express';
import { PayablesService } from './payables.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateVendorInvoiceDto, UpdateVendorInvoiceDto, DisputeDto, VersionDto, ListQueryDto,
  CreatePaymentDto, PaymentListQueryDto,
} from './payables.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class PayablesController {
  constructor(private readonly service: PayablesService) {}

  // -------- Vendor invoices --------
  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateVendorInvoiceDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateVendorInvoiceDto>(req)));
  };

  match = async (req: Request, res: Response) => {
    res.json(await this.service.match(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  approve = async (req: Request, res: Response) => {
    res.json(await this.service.approve(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  dispute = async (req: Request, res: Response) => {
    res.json(await this.service.dispute(ctxOf(req), idOf(req), valid<DisputeDto>(req)));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="vendor-invoices.csv"');
    res.send(csv);
  };

  // -------- Vendor payments --------
  createPayment = async (req: Request, res: Response) => {
    const created = await this.service.createPayment(ctxOf(req), valid<CreatePaymentDto>(req));
    res.status(201).json(created);
  };

  listPayments = async (req: Request, res: Response) => {
    res.json(await this.service.listPayments(ctxOf(req), valid<PaymentListQueryDto>(req, 'query')));
  };

  exportPaymentsCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportPaymentsCsv(ctxOf(req), valid<PaymentListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="vendor-payments.csv"');
    res.send(csv);
  };
}
