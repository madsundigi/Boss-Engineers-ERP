import { Request, Response } from 'express';
import { PlanningService } from './planning.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateWbsDto, CreateTaskDto, UpdateTaskDto, CreateMilestoneDto, UpdateMilestoneDto,
  ApproveBaselineDto,
} from './planning.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}
function projectIdOf(req: Request): number {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid projectId');
  return id;
}

export class PlanningController {
  constructor(private readonly service: PlanningService) {}

  // ---- WBS ----
  createWbs = async (req: Request, res: Response) => {
    const created = await this.service.createWbs(ctxOf(req), projectIdOf(req), valid<CreateWbsDto>(req));
    res.status(201).json(created);
  };

  listWbs = async (req: Request, res: Response) => {
    res.json(await this.service.listWbs(ctxOf(req), projectIdOf(req)));
  };

  // ---- Tasks ----
  createTask = async (req: Request, res: Response) => {
    const created = await this.service.createTask(ctxOf(req), projectIdOf(req), valid<CreateTaskDto>(req));
    res.status(201).json(created);
  };

  getTask = async (req: Request, res: Response) => {
    res.json(await this.service.getTask(ctxOf(req), idOf(req)));
  };

  schedule = async (req: Request, res: Response) => {
    res.json(await this.service.schedule(ctxOf(req), projectIdOf(req)));
  };

  updateTask = async (req: Request, res: Response) => {
    res.json(await this.service.updateTask(ctxOf(req), idOf(req), valid<UpdateTaskDto>(req)));
  };

  // ---- Milestones ----
  createMilestone = async (req: Request, res: Response) => {
    const created = await this.service.createMilestone(ctxOf(req), projectIdOf(req), valid<CreateMilestoneDto>(req));
    res.status(201).json(created);
  };

  listMilestones = async (req: Request, res: Response) => {
    res.json(await this.service.listMilestones(ctxOf(req), projectIdOf(req)));
  };

  updateMilestone = async (req: Request, res: Response) => {
    res.json(await this.service.updateMilestone(ctxOf(req), idOf(req), valid<UpdateMilestoneDto>(req)));
  };

  // ---- Baseline ----
  createBaseline = async (req: Request, res: Response) => {
    const created = await this.service.createBaseline(ctxOf(req), projectIdOf(req));
    res.status(201).json(created);
  };

  approveBaseline = async (req: Request, res: Response) => {
    res.json(await this.service.approveBaseline(ctxOf(req), valid<ApproveBaselineDto>(req)));
  };
}
