import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, UpdateCustomerDto, VersionDto, ListQueryDto } from './customers.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.create(ctxOf(req), valid<CreateCustomerDto>(req)));
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getById(ctxOf(req), idOf(req)));
  };
  update = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.update(ctxOf(req), idOf(req), valid<UpdateCustomerDto>(req)));
  };
  remove = async (req: Request, res: Response): Promise<void> => {
    await this.svc.delete(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };
}
