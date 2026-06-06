import { Request, Response } from 'express';
import { EnquiryService } from './enquiry.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CreateEnquiryDto, UpdateEnquiryDto, ChangeStatusDto, ListQueryDto } from './enquiry.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class EnquiryController {
  constructor(private readonly service: EnquiryService) {}

  list = async (req: Request, res: Response) => {
    const result = await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.json(result);
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateEnquiryDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateEnquiryDto>(req)));
  };

  changeStatus = async (req: Request, res: Response) => {
    res.json(await this.service.changeStatus(ctxOf(req), idOf(req), valid<ChangeStatusDto>(req)));
  };

  approve = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.approve(ctxOf(req), idOf(req), rowVersion));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="enquiries.csv"');
    res.send(csv);
  };
}
