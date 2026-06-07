import { Request, Response } from 'express';
import { ProfitabilityService } from './profitability.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ComputeSnapshotDto, ListQueryDto } from './profitability.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function projectIdOf(req: Request): number {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid projectId');
  return id;
}

export class ProfitabilityController {
  constructor(private readonly service: ProfitabilityService) {}

  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  compute = async (req: Request, res: Response) => {
    const created = await this.service.computeSnapshot(ctxOf(req), valid<ComputeSnapshotDto>(req));
    res.status(201).json(created);
  };

  getLatest = async (req: Request, res: Response) => {
    res.json(await this.service.getLatestForProject(ctxOf(req), projectIdOf(req)));
  };

  projectPnl = async (req: Request, res: Response) => {
    res.json(await this.service.projectPnl(ctxOf(req), projectIdOf(req)));
  };

  portfolio = async (req: Request, res: Response) => {
    res.json(await this.service.portfolioMargin(ctxOf(req)));
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="profitability.csv"');
    res.send(csv);
  };
}
