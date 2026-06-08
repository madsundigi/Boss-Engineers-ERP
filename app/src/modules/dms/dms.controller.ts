import { Request, Response } from 'express';
import { DmsService } from './dms.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateDocumentDto, AddVersionDto, UpdateDocumentDto, VersionDto, ListQueryDto,
} from './dms.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class DmsController {
  constructor(private readonly service: DmsService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const created = await this.service.create(ctxOf(req), valid<CreateDocumentDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  listVersions = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.listVersions(ctxOf(req), idOf(req)));
  };

  addVersion = async (req: Request, res: Response): Promise<void> => {
    const updated = await this.service.addVersion(ctxOf(req), idOf(req), valid<AddVersionDto>(req));
    res.status(201).json(updated);
  };

  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateDocumentDto>(req)));
  };

  activate = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.activate(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  archive = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.archive(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  markObsolete = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.markObsolete(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.delete(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="documents.csv"');
    res.send(csv);
  };
}
