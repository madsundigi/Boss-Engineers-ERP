import { Request, Response } from 'express';
import { TreasuryService } from './treasury.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CreateForecastDto, ListQueryDto, SummaryQueryDto } from './treasury.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}

export class TreasuryController {
  constructor(private readonly service: TreasuryService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const created = await this.service.addForecast(ctxOf(req), valid<CreateForecastDto>(req));
    res.status(201).json(created);
  };

  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  summary = async (req: Request, res: Response): Promise<void> => {
    const { projectId } = valid<SummaryQueryDto>(req, 'query');
    res.json(await this.service.forecastSummary(ctxOf(req), projectId));
  };

  position = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.position(ctxOf(req)));
  };

  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="cashflow-forecasts.csv"');
    res.send(csv);
  };
}
