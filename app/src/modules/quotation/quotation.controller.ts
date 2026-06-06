import { Request, Response } from 'express';
import { QuotationService } from './quotation.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateQuotationDto, UpdateQuotationDto, ConvertDto, SendDto, ListQueryDto,
} from './quotation.dto';

function ctxOf(req: Request): RequestContext { if (!req.context) throw Errors.unauthorized(); return req.context; }
function num(v: string, label: string): number {
  const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw Errors.badRequest(`Invalid ${label}`); return n;
}
const idOf = (req: Request) => num(req.params.id, 'id');
const ver = (req: Request) => valid<{ rowVersion: number }>(req).rowVersion;
const reasonOf = (req: Request) => valid<{ rowVersion: number; reason?: string }>(req).reason;

export class QuotationController {
  constructor(private readonly service: QuotationService) {}

  list = async (req: Request, res: Response) =>
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));

  create = async (req: Request, res: Response) =>
    res.status(201).json(await this.service.create(ctxOf(req), valid<CreateQuotationDto>(req)));

  convert = async (req: Request, res: Response) =>
    res.status(201).json(await this.service.convertFromEnquiry(
      ctxOf(req), num(req.params.enquiryId, 'enquiryId'), valid<ConvertDto>(req)));

  getById = async (req: Request, res: Response) =>
    res.json(await this.service.getById(ctxOf(req), idOf(req)));

  update = async (req: Request, res: Response) =>
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateQuotationDto>(req)));

  submit = async (req: Request, res: Response) =>
    res.json(await this.service.submit(ctxOf(req), idOf(req), ver(req)));

  approve = async (req: Request, res: Response) =>
    res.json(await this.service.approve(ctxOf(req), idOf(req), ver(req)));

  reject = async (req: Request, res: Response) =>
    res.json(await this.service.reject(ctxOf(req), idOf(req), ver(req), reasonOf(req)));

  revise = async (req: Request, res: Response) =>
    res.json(await this.service.revise(ctxOf(req), idOf(req), ver(req), valid<{ reason: string }>(req).reason));

  send = async (req: Request, res: Response) =>
    res.json(await this.service.send(ctxOf(req), idOf(req), valid<SendDto>(req)));

  won = async (req: Request, res: Response) =>
    res.json(await this.service.markWon(ctxOf(req), idOf(req), ver(req)));

  lost = async (req: Request, res: Response) =>
    res.json(await this.service.markLost(ctxOf(req), idOf(req), ver(req), reasonOf(req)));

  revisions = async (req: Request, res: Response) =>
    res.json(await this.service.listRevisions(ctxOf(req), idOf(req)));

  pdf = async (req: Request, res: Response) => {
    const { quotation, pdf } = await this.service.generatePdf(ctxOf(req), idOf(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.quotationNo}.pdf"`);
    res.send(pdf);
  };
}
