import { Request, Response } from 'express';
import { TaxService } from './tax.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateTaxCodeDto, SetActiveDto, TaxCodeQueryDto, GenerateEInvoiceDto,
  GenerateEwayBillDto, TxnQueryDto, SummaryQueryDto,
} from './tax.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idParam(req: Request, name: string): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class TaxController {
  constructor(private readonly service: TaxService) {}

  // --- Tax-code master ---
  listTaxCodes = async (req: Request, res: Response) => {
    res.json(await this.service.listTaxCodes(ctxOf(req), valid<TaxCodeQueryDto>(req, 'query')));
  };

  createTaxCode = async (req: Request, res: Response) => {
    const created = await this.service.createTaxCode(ctxOf(req), valid<CreateTaxCodeDto>(req));
    res.status(201).json(created);
  };

  getTaxCode = async (req: Request, res: Response) => {
    res.json(await this.service.getTaxCode(ctxOf(req), idParam(req, 'id')));
  };

  setActive = async (req: Request, res: Response) => {
    res.json(await this.service.setActive(ctxOf(req), idParam(req, 'id'), valid<SetActiveDto>(req).isActive));
  };

  // --- E-invoice / e-way bill ---
  generateEInvoice = async (req: Request, res: Response) => {
    const result = await this.service.generateEInvoice(
      ctxOf(req), idParam(req, 'invoiceId'), valid<GenerateEInvoiceDto>(req));
    res.status(201).json(result);
  };

  generateEwayBill = async (req: Request, res: Response) => {
    const result = await this.service.generateEwayBill(
      ctxOf(req), idParam(req, 'invoiceId'), valid<GenerateEwayBillDto>(req));
    res.status(201).json(result);
  };

  // --- Reads ---
  listTransactions = async (req: Request, res: Response) => {
    res.json(await this.service.listTransactions(ctxOf(req), valid<TxnQueryDto>(req, 'query')));
  };

  summary = async (req: Request, res: Response) => {
    res.json(await this.service.gstSummary(ctxOf(req), valid<SummaryQueryDto>(req, 'query')));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<TxnQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="gst-register.csv"');
    res.send(csv);
  };
}
