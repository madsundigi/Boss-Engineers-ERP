import { Request, Response } from 'express';
import { HrService } from './hr.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateEmployeeDto, UpdateEmployeeDto, ListEmployeesDto,
  CreateDepartmentDto, CreateDesignationDto,
  ApplyLeaveDto, ApproveLeaveDto, RejectLeaveDto, ListLeavesDto, AttendanceQueryDto,
} from './hr.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class HrController {
  constructor(private readonly service: HrService) {}

  // ---- Employee ----------------------------------------------------------

  listEmployees = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListEmployeesDto>(req, 'query')));
  };

  createEmployee = async (req: Request, res: Response) => {
    const created = await this.service.createEmployee(ctxOf(req), valid<CreateEmployeeDto>(req));
    res.status(201).json(created);
  };

  getEmployeeById = async (req: Request, res: Response) => {
    res.json(await this.service.getEmployeeById(ctxOf(req), idOf(req)));
  };

  updateEmployee = async (req: Request, res: Response) => {
    res.json(await this.service.updateEmployee(ctxOf(req), idOf(req), valid<UpdateEmployeeDto>(req)));
  };

  deleteEmployee = async (req: Request, res: Response) => {
    await this.service.deleteEmployee(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportEmployees = async (req: Request, res: Response) => {
    const csv = await this.service.exportEmployeesCsv(ctxOf(req), valid<ListEmployeesDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
    res.send(csv);
  };

  // ---- Department / Designation ------------------------------------------

  listDepartments = async (req: Request, res: Response) => {
    res.json(await this.service.listDepartments(ctxOf(req)));
  };

  createDepartment = async (req: Request, res: Response) => {
    const created = await this.service.createDepartment(ctxOf(req), valid<CreateDepartmentDto>(req));
    res.status(201).json(created);
  };

  listDesignations = async (req: Request, res: Response) => {
    res.json(await this.service.listDesignations(ctxOf(req)));
  };

  createDesignation = async (req: Request, res: Response) => {
    const created = await this.service.createDesignation(ctxOf(req), valid<CreateDesignationDto>(req));
    res.status(201).json(created);
  };

  // ---- Leave -------------------------------------------------------------

  listLeaves = async (req: Request, res: Response) => {
    res.json(await this.service.listLeaves(ctxOf(req), valid<ListLeavesDto>(req, 'query')));
  };

  applyLeave = async (req: Request, res: Response) => {
    const created = await this.service.applyLeave(ctxOf(req), valid<ApplyLeaveDto>(req));
    res.status(201).json(created);
  };

  getLeaveById = async (req: Request, res: Response) => {
    res.json(await this.service.getLeaveById(ctxOf(req), idOf(req)));
  };

  approveLeave = async (req: Request, res: Response) => {
    res.json(await this.service.approveLeave(ctxOf(req), idOf(req), valid<ApproveLeaveDto>(req).rowVersion));
  };

  rejectLeave = async (req: Request, res: Response) => {
    res.json(await this.service.rejectLeave(ctxOf(req), idOf(req), valid<RejectLeaveDto>(req)));
  };

  // ---- Attendance --------------------------------------------------------

  attendance = async (req: Request, res: Response) => {
    res.json(await this.service.attendance(ctxOf(req), valid<AttendanceQueryDto>(req, 'query')));
  };
}
