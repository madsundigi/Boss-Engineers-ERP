import { Request, Response } from 'express';
import { DeliveryService } from './delivery.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CreateForecastDto, ListQueryDto } from './delivery.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function projectIdOf(req: Request): number {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid projectId');
  return id;
}

export class DeliveryController {
  constructor(private readonly service: DeliveryService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.createForecast(ctxOf(req), valid<CreateForecastDto>(req));
    res.status(201).json(created);
  };

  getLatest = async (req: Request, res: Response) => {
    res.json(await this.service.getLatestForProject(ctxOf(req), projectIdOf(req)));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="delivery-forecasts.csv"');
    res.send(csv);
  };
}
