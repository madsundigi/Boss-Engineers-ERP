import { Request, Response } from 'express';
import { BomService } from './bom.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CreateBomDto, UpdateBomDto, VersionDto, ListQueryDto } from './bom.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class BomController {
  constructor(private readonly service: BomService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateBomDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateBomDto>(req)));
  };

  release = async (req: Request, res: Response) => {
    res.json(await this.service.release(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  obsolete = async (req: Request, res: Response) => {
    res.json(await this.service.obsolete(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bom.csv"');
    res.send(csv);
  };
}
