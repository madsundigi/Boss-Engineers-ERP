import { Request, Response } from 'express';
import { WorkloadService } from './workload.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateAllocationDto, ListAllocationsDto, CapacityQueryDto, CreateTimesheetDto,
} from './workload.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class WorkloadController {
  constructor(private readonly service: WorkloadService) {}

  // ---- Allocations -------------------------------------------------------

  listAllocations = async (req: Request, res: Response) => {
    const result = await this.service.listAllocations(ctxOf(req), valid<ListAllocationsDto>(req, 'query'));
    res.json(result);
  };

  createAllocation = async (req: Request, res: Response) => {
    const created = await this.service.createAllocation(ctxOf(req), valid<CreateAllocationDto>(req));
    res.status(201).json(created);
  };

  getAllocation = async (req: Request, res: Response) => {
    res.json(await this.service.getAllocation(ctxOf(req), idOf(req)));
  };

  confirmAllocation = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.confirmAllocation(ctxOf(req), idOf(req), rowVersion));
  };

  cancelAllocation = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.cancelAllocation(ctxOf(req), idOf(req), rowVersion));
  };

  capacityLoad = async (req: Request, res: Response) => {
    const rows = await this.service.capacityLoad(ctxOf(req), valid<CapacityQueryDto>(req, 'query'));
    res.json({ rows });
  };

  // ---- Timesheets --------------------------------------------------------

  createTimesheet = async (req: Request, res: Response) => {
    const created = await this.service.createTimesheet(ctxOf(req), valid<CreateTimesheetDto>(req));
    res.status(201).json(created);
  };

  getTimesheet = async (req: Request, res: Response) => {
    res.json(await this.service.getTimesheet(ctxOf(req), idOf(req)));
  };

  approveTimesheet = async (req: Request, res: Response) => {
    const { rowVersion } = valid<{ rowVersion: number }>(req);
    res.json(await this.service.approveTimesheet(ctxOf(req), idOf(req), rowVersion));
  };
}
