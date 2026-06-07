import { HrService } from '../src/modules/hr/hr.service';
import { HrRepository } from '../src/modules/hr/hr.repository';
import { RequestContext } from '../src/common/request-context';
import { Employee, Leave } from '../src/modules/hr/hr.types';
import { leaveDays } from '../src/modules/hr/hr.constants';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'hr', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function employee(over: Partial<Employee> = {}): Employee {
  return {
    employeeId: 10, companyId: 1, empCode: 'E001', fullName: 'Asha Rao',
    departmentId: null, designationId: null, buId: 1, costRate: 0, billingRate: 0,
    doj: '2020-01-01', status: 'ACTIVE',
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1, ...over,
  };
}

function leave(over: Partial<Leave> = {}): Leave {
  return {
    leaveId: 30, employeeId: 10, employeeName: 'Asha Rao',
    fromDate: '2026-06-01', toDate: '2026-06-03', leaveType: 'CL', days: 3,
    reason: null, status: 'PENDING', approverId: null, approvedAt: null, rowVersion: 1, ...over,
  };
}

function makeRepo() {
  return {
    empCodeExists: jest.fn(),
    createEmployee: jest.fn(),
    findEmployeeById: jest.fn(),
    listEmployees: jest.fn(),
    updateEmployee: jest.fn(),
    softDeleteEmployee: jest.fn(),
    listDepartments: jest.fn(),
    createDepartment: jest.fn(),
    listDesignations: jest.fn(),
    createDesignation: jest.fn(),
    employeeIdForUser: jest.fn(),
    createLeave: jest.fn(),
    findLeaveById: jest.fn(),
    listLeaves: jest.fn(),
    setLeaveStatus: jest.fn(),
    attendanceSummary: jest.fn(),
  } as unknown as jest.Mocked<HrRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('HrService', () => {
  let repo: jest.Mocked<HrRepository>;
  let service: HrService;
  beforeEach(() => { repo = makeRepo(); service = new HrService(repo); });

  // ---- leave day computation (pure) -------------------------------------
  describe('leaveDays', () => {
    it('counts a single day inclusively as 1', () => {
      expect(leaveDays('2026-06-01', '2026-06-01')).toBe(1);
    });
    it('counts a range inclusively (3-day span)', () => {
      expect(leaveDays('2026-06-01', '2026-06-03')).toBe(3);
    });
    it('spans month boundaries correctly', () => {
      expect(leaveDays('2026-01-30', '2026-02-02')).toBe(4);
    });
  });

  // ---- employee CRUD guards ---------------------------------------------
  describe('createEmployee', () => {
    it('creates when the emp_code is free', async () => {
      repo.empCodeExists.mockResolvedValue(false);
      const created = employee();
      repo.createEmployee.mockResolvedValue(created);
      const out = await service.createEmployee(ctx, { empCode: 'E001', fullName: 'Asha Rao', status: 'ACTIVE' });
      expect(out).toBe(created);
      expect(repo.createEmployee).toHaveBeenCalledWith(ctx, expect.objectContaining({ empCode: 'E001' }));
    });
    it('409 when the emp_code already exists in the company', async () => {
      repo.empCodeExists.mockResolvedValue(true);
      await expect(code(service.createEmployee(ctx, { empCode: 'E001', fullName: 'Dup', status: 'ACTIVE' }))).resolves.toBe(409);
      expect(repo.createEmployee).not.toHaveBeenCalled();
    });
  });

  describe('getEmployeeById', () => {
    it('404 when not found', async () => {
      repo.findEmployeeById.mockResolvedValue(null);
      await expect(code(service.getEmployeeById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('updateEmployee', () => {
    it('400 when no fields are supplied', async () => {
      await expect(code(service.updateEmployee(ctx, 10, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 on a stale row version (optimistic concurrency)', async () => {
      repo.findEmployeeById.mockResolvedValue(employee({ rowVersion: 4 }));
      repo.updateEmployee.mockResolvedValue(null); // version mismatch
      await expect(code(service.updateEmployee(ctx, 10, { fullName: 'New', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('updates when the version matches', async () => {
      repo.findEmployeeById.mockResolvedValue(employee());
      const updated = employee({ fullName: 'New Name', rowVersion: 2 });
      repo.updateEmployee.mockResolvedValue(updated);
      const out = await service.updateEmployee(ctx, 10, { fullName: 'New Name', rowVersion: 1 });
      expect(out).toBe(updated);
    });
  });

  describe('deleteEmployee', () => {
    it('404 when the employee is missing', async () => {
      repo.findEmployeeById.mockResolvedValue(null);
      await expect(code(service.deleteEmployee(ctx, 10))).resolves.toBe(404);
      expect(repo.softDeleteEmployee).not.toHaveBeenCalled();
    });
  });

  // ---- leave application + day computation -------------------------------
  describe('applyLeave', () => {
    it('computes inclusive days and opens PENDING', async () => {
      repo.findEmployeeById.mockResolvedValue(employee());
      repo.createLeave.mockResolvedValue(leave());
      await service.applyLeave(ctx, { employeeId: 10, fromDate: '2026-06-01', toDate: '2026-06-03' });
      expect(repo.createLeave).toHaveBeenCalledWith(ctx, expect.objectContaining({ days: 3, employeeId: 10 }));
    });
    it('404 when the applicant employee is unknown', async () => {
      repo.findEmployeeById.mockResolvedValue(null);
      await expect(code(service.applyLeave(ctx, { employeeId: 999, fromDate: '2026-06-01', toDate: '2026-06-01' }))).resolves.toBe(404);
      expect(repo.createLeave).not.toHaveBeenCalled();
    });
  });

  // ---- leave approval transition + SoD ----------------------------------
  describe('approveLeave', () => {
    it('approves a PENDING leave (stamps approver, emits event)', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ status: 'PENDING' }));
      repo.employeeIdForUser.mockResolvedValue(7); // approver maps to a DIFFERENT employee
      const approved = leave({ status: 'APPROVED', approverId: 5, rowVersion: 2 });
      repo.setLeaveStatus.mockResolvedValue(approved);
      const out = await service.approveLeave(ctx, 30, 1);
      expect(out).toBe(approved);
      const [, , , status, opts] = repo.setLeaveStatus.mock.calls[0];
      expect(status).toBe('APPROVED');
      expect(opts).toEqual(expect.objectContaining({ stampApprover: true }));
      expect((opts as { event?: { eventType: string } }).event?.eventType).toBe('leave.approved');
    });
    it('403 SoD: the approver cannot approve their own leave', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ employeeId: 10, status: 'PENDING' }));
      repo.employeeIdForUser.mockResolvedValue(10); // approver IS the applicant
      await expect(code(service.approveLeave(ctx, 30, 1))).resolves.toBe(403);
      expect(repo.setLeaveStatus).not.toHaveBeenCalled();
    });
    it('409 when the leave is not PENDING', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ status: 'APPROVED' }));
      await expect(code(service.approveLeave(ctx, 30, 1))).resolves.toBe(409);
    });
    it('409 on a stale row version', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ status: 'PENDING' }));
      repo.employeeIdForUser.mockResolvedValue(null);
      repo.setLeaveStatus.mockResolvedValue(null); // version mismatch
      await expect(code(service.approveLeave(ctx, 30, 1))).resolves.toBe(409);
    });
    it('404 when the leave is missing', async () => {
      repo.findLeaveById.mockResolvedValue(null);
      await expect(code(service.approveLeave(ctx, 99, 1))).resolves.toBe(404);
    });
  });

  describe('rejectLeave', () => {
    it('rejects a PENDING leave with a reason', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ status: 'PENDING' }));
      const rejected = leave({ status: 'REJECTED', reason: 'no cover', rowVersion: 2 });
      repo.setLeaveStatus.mockResolvedValue(rejected);
      const out = await service.rejectLeave(ctx, 30, { reason: 'no cover', rowVersion: 1 });
      expect(out).toBe(rejected);
      const [, , , status, opts] = repo.setLeaveStatus.mock.calls[0];
      expect(status).toBe('REJECTED');
      expect(opts).toEqual(expect.objectContaining({ reason: 'no cover', stampApprover: true }));
    });
    it('409 when the leave is already terminal', async () => {
      repo.findLeaveById.mockResolvedValue(leave({ status: 'REJECTED' }));
      await expect(code(service.rejectLeave(ctx, 30, { reason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });
});
