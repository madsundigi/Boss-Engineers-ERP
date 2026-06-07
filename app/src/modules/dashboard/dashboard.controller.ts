import { Request, Response } from 'express';
import { DashboardService } from './dashboard.service';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}

/** HTTP edge for the read-only M16 dashboard (no writes, no mutating verbs). */
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  kpis = async (req: Request, res: Response) => {
    res.json(await this.service.getKpiSummary(ctxOf(req)));
  };

  salesFunnel = async (req: Request, res: Response) => {
    res.json(await this.service.getSalesFunnel(ctxOf(req)));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportKpisCsv(ctxOf(req));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="dashboard-kpis.csv"');
    res.send(csv);
  };
}
