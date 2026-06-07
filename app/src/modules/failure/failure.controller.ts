import { Request, Response } from 'express';
import { FailureService } from './failure.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateNcrDto, AddRcaDto, AddCapaDto, AddCapaActionDto, UpdateCapaStatusDto,
  VersionDto, ListQueryDto,
} from './failure.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idParam(req: Request, name: string): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class FailureController {
  constructor(private readonly service: FailureService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateNcrDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idParam(req, 'id')));
  };

  addRca = async (req: Request, res: Response) => {
    res.status(201).json(await this.service.addRca(ctxOf(req), idParam(req, 'id'), valid<AddRcaDto>(req)));
  };

  addCapa = async (req: Request, res: Response) => {
    res.status(201).json(await this.service.addCapa(ctxOf(req), idParam(req, 'id'), valid<AddCapaDto>(req)));
  };

  addCapaAction = async (req: Request, res: Response) => {
    const action = await this.service.addCapaAction(
      ctxOf(req), idParam(req, 'id'), idParam(req, 'capaId'), valid<AddCapaActionDto>(req));
    res.status(201).json(action);
  };

  updateCapaStatus = async (req: Request, res: Response) => {
    res.json(await this.service.updateCapaStatus(
      ctxOf(req), idParam(req, 'id'), idParam(req, 'capaId'), valid<UpdateCapaStatusDto>(req)));
  };

  close = async (req: Request, res: Response) => {
    res.json(await this.service.close(ctxOf(req), idParam(req, 'id'), valid<VersionDto>(req).rowVersion));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idParam(req, 'id'));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ncrs.csv"');
    res.send(csv);
  };
}
