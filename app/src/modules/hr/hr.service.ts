import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  HrRepository, CreateEmployeeRow, UpdateEmployeeFields, CreateLeaveRow,
} from './hr.repository';
import {
  Employee, EmployeeListResult, Department, Designation,
  Leave, LeaveListResult, AttendanceSummary,
} from './hr.types';
import {
  CreateEmployeeDto, UpdateEmployeeDto, ListEmployeesDto,
  CreateDepartmentDto, CreateDesignationDto,
  ApplyLeaveDto, RejectLeaveDto, ListLeavesDto, AttendanceQueryDto,
} from './hr.dto';
import { canTransitionLeave, leaveDays, LEAVE_APPROVED_EVENT } from './hr.constants';

/**
 * HrService — business logic for the HRMS core module (employee master,
 * department/designation reference data, leave application + approval, and the
 * month attendance summary). Stateless; depends only on the repository
 * (injected) so it is unit-testable without a database.
 *
 * Segregation of Duties: a leave approver may not approve their own leave —
 * if the approving user maps to an employee (sec.app_user.employee_id) and that
 * employee is the applicant, the approval is refused (403).
 */
export class HrService {
  constructor(private readonly repo: HrRepository) {}

  // ---- Employee master ---------------------------------------------------

  async createEmployee(ctx: RequestContext, dto: CreateEmployeeDto): Promise<Employee> {
    if (await this.repo.empCodeExists(ctx, dto.empCode)) {
      throw Errors.conflict(`Employee code '${dto.empCode}' already exists in this company`);
    }
    const row: CreateEmployeeRow = {
      empCode: dto.empCode,
      fullName: dto.fullName,
      departmentId: dto.departmentId,
      designationId: dto.designationId,
      buId: dto.buId,
      costRate: dto.costRate,
      billingRate: dto.billingRate,
      doj: dto.doj,
      status: dto.status,
    };
    return this.repo.createEmployee(ctx, row);
  }

  async getEmployeeById(ctx: RequestContext, id: number): Promise<Employee> {
    const row = await this.repo.findEmployeeById(ctx, id);
    if (!row) throw Errors.notFound(`Employee ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListEmployeesDto): Promise<EmployeeListResult> {
    return this.repo.listEmployees(ctx, query);
  }

  async updateEmployee(ctx: RequestContext, id: number, dto: UpdateEmployeeDto): Promise<Employee> {
    const { rowVersion, ...rest } = dto;
    const fields = rest as UpdateEmployeeFields;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getEmployeeById(ctx, id); // 404 if missing
    const updated = await this.repo.updateEmployee(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Employee was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  async deleteEmployee(ctx: RequestContext, id: number): Promise<void> {
    await this.getEmployeeById(ctx, id); // 404 if missing
    await this.repo.softDeleteEmployee(ctx, id);
  }

  /** EMPLOYEE.EXPORT — CSV of the (filtered) employee roster. */
  async exportEmployeesCsv(ctx: RequestContext, query: ListEmployeesDto): Promise<string> {
    const { rows } = await this.repo.listEmployees(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Emp Code', 'Full Name', 'Department', 'Designation', 'DOJ', 'Status', 'Cost Rate', 'Billing Rate'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.empCode, r.fullName, r.departmentId, r.designationId, r.doj, r.status, r.costRate, r.billingRate].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // ---- Department / Designation (reference data) -------------------------

  listDepartments(ctx: RequestContext): Promise<Department[]> {
    return this.repo.listDepartments(ctx);
  }

  createDepartment(ctx: RequestContext, dto: CreateDepartmentDto): Promise<Department> {
    return this.repo.createDepartment(ctx, dto.deptCode, dto.deptName);
  }

  listDesignations(ctx: RequestContext): Promise<Designation[]> {
    return this.repo.listDesignations(ctx);
  }

  createDesignation(ctx: RequestContext, dto: CreateDesignationDto): Promise<Designation> {
    return this.repo.createDesignation(ctx, dto.desigCode, dto.desigName);
  }

  // ---- Leave -------------------------------------------------------------

  /** Apply for leave: validate the applicant exists, compute days, open PENDING. */
  async applyLeave(ctx: RequestContext, dto: ApplyLeaveDto): Promise<Leave> {
    if (dto.toDate < dto.fromDate) {
      throw Errors.badRequest('toDate must be on or after fromDate');
    }
    await this.getEmployeeById(ctx, dto.employeeId); // 404 if the employee is unknown / cross-tenant
    const days = leaveDays(dto.fromDate, dto.toDate);
    const row: CreateLeaveRow = {
      employeeId: dto.employeeId,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      leaveType: dto.leaveType,
      reason: dto.reason,
      days,
    };
    return this.repo.createLeave(ctx, row);
  }

  async getLeaveById(ctx: RequestContext, id: number): Promise<Leave> {
    const row = await this.repo.findLeaveById(ctx, id);
    if (!row) throw Errors.notFound(`Leave ${id} not found`);
    return row;
  }

  listLeaves(ctx: RequestContext, query: ListLeavesDto): Promise<LeaveListResult> {
    return this.repo.listLeaves(ctx, query);
  }

  /**
   * Approve a PENDING leave (LEAVE.APPROVE). Enforces SoD — the approving user
   * may not approve their own leave (if the user maps to the applicant employee)
   * — then stamps approver + approved_at and emits 'leave.approved' atomically.
   */
  async approveLeave(ctx: RequestContext, id: number, rowVersion: number): Promise<Leave> {
    const existing = await this.getLeaveById(ctx, id);
    if (!canTransitionLeave(existing.status, 'APPROVED')) {
      throw Errors.conflict(`Only a PENDING leave can be approved (current: ${existing.status})`);
    }
    const approverEmployeeId = await this.repo.employeeIdForUser(ctx, ctx.userId);
    if (approverEmployeeId != null && approverEmployeeId === existing.employeeId) {
      throw Errors.forbidden('Segregation of duties: you cannot approve your own leave application');
    }
    const updated = await this.repo.setLeaveStatus(ctx, id, rowVersion, 'APPROVED', {
      stampApprover: true,
      event: {
        eventType: LEAVE_APPROVED_EVENT, aggregateType: 'LEAVE', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          employeeId: existing.employeeId,
          fromDate: existing.fromDate,
          toDate: existing.toDate,
          days: existing.days,
        },
      },
    });
    if (!updated) throw Errors.conflict('Leave was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Reject a PENDING leave with a reason (LEAVE.APPROVE). */
  async rejectLeave(ctx: RequestContext, id: number, dto: RejectLeaveDto): Promise<Leave> {
    const existing = await this.getLeaveById(ctx, id);
    if (!canTransitionLeave(existing.status, 'REJECTED')) {
      throw Errors.conflict(`Only a PENDING leave can be rejected (current: ${existing.status})`);
    }
    const updated = await this.repo.setLeaveStatus(ctx, id, dto.rowVersion, 'REJECTED', {
      stampApprover: true, reason: dto.reason,
    });
    if (!updated) throw Errors.conflict('Leave was modified by someone else (row version mismatch)');
    return updated;
  }

  // ---- Attendance summary ------------------------------------------------

  attendance(ctx: RequestContext, query: AttendanceQueryDto): Promise<AttendanceSummary[]> {
    return this.repo.attendanceSummary(ctx, query);
  }
}
