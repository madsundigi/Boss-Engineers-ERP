import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { CrmService } from './crm.service';
import {
  CreateOpportunityDto, UpdateOpportunityDto, AdvanceStageDto, VersionDto, LoseDto,
  ListOpportunityQueryDto, CreateActivityDto, ListActivityQueryDto, ForecastQueryDto,
} from './crm.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class CrmController {
  constructor(private readonly svc: CrmService) {}

  // --- Opportunity ---
  createOpportunity = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.createOpportunity(ctxOf(req), valid<CreateOpportunityDto>(req)));
  };
  listOpportunities = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.listOpportunities(ctxOf(req), valid<ListOpportunityQueryDto>(req, 'query')));
  };
  pipelineSummary = async (req: Request, res: Response): Promise<void> => {
    const cid = req.query.customerId ? Number(req.query.customerId) : undefined;
    res.json(await this.svc.pipelineSummary(ctxOf(req), cid));
  };
  revenueForecast = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.revenueForecast(ctxOf(req), valid<ForecastQueryDto>(req, 'query')));
  };
  exportCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.svc.exportCsv(ctxOf(req), valid<ListOpportunityQueryDto>(req, 'query'));
    res.type('text/csv').send(csv);
  };
  getOpportunity = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getOpportunity(ctxOf(req), idOf(req)));
  };
  updateOpportunity = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.updateOpportunity(ctxOf(req), idOf(req), valid<UpdateOpportunityDto>(req)));
  };
  advanceStage = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.advanceStage(ctxOf(req), idOf(req), valid<AdvanceStageDto>(req)));
  };
  win = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.win(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  lose = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.lose(ctxOf(req), idOf(req), valid<LoseDto>(req)));
  };
  removeOpportunity = async (req: Request, res: Response): Promise<void> => {
    await this.svc.deleteOpportunity(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };

  // --- Activity ---
  createActivity = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.createActivity(ctxOf(req), valid<CreateActivityDto>(req)));
  };
  listActivities = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.listActivities(ctxOf(req), valid<ListActivityQueryDto>(req, 'query')));
  };
  getActivity = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getActivity(ctxOf(req), idOf(req)));
  };
  completeActivity = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.completeActivity(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };

  // --- Customer 360 ---
  customer360 = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.customer360(ctxOf(req), idOf(req)));
  };
}
