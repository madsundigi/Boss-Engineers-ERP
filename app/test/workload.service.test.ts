import { WorkloadService } from '../src/modules/workload/workload.service';
import { WorkloadRepository } from '../src/modules/workload/workload.repository';
import { RequestContext } from '../src/common/request-context';
import { Allocation, Timesheet } from '../src/modules/workload/workload.types';
import { createAllocationSchema } from '../src/modules/workload/workload.dto';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 1, username: 'tester', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

const alloc: Allocation = {
  allocId: 5, companyId: 1, employeeId: 7, employeeName: 'Asha Rao',
  projectId: 3, taskId: null, allocDate: '2026-06-10', plannedHours: 4,
  status: 'PLANNED', refType: null, refId: null, rowVersion: 1,
};

const timesheet: Timesheet = {
  tsId: 9, companyId: 1, employeeId: 7, employeeName: 'Asha Rao',
  periodStart: '2026-06-08', periodEnd: '2026-06-12', status: 'SUBMITTED',
  submittedAt: 't', approvedBy: null, approvedAt: null, rowVersion: 1,
  totalHours: 8, totalCost: 4000,
  lines: [{ tsLineId: 1, projectId: 3, wbsId: null, workDate: '2026-06-09', hours: 8, costAmount: 4000 }],
};

function makeRepo() {
  return {
    getEmployeeCostRate: jest.fn(),
    allocatedHoursOn: jest.fn(),
    createAllocation: jest.fn(),
    findAllocationById: jest.fn(),
    listAllocations: jest.fn(),
    setAllocationStatus: jest.fn(),
    capacityLoad: jest.fn(),
    createTimesheet: jest.fn(),
    findTimesheetById: jest.fn(),
    approveTimesheet: jest.fn(),
  } as unknown as jest.Mocked<WorkloadRepository>;
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('WorkloadService', () => {
  let repo: jest.Mocked<WorkloadRepository>;
  let service: WorkloadService;
  beforeEach(() => { repo = makeRepo(); service = new WorkloadService(repo); });

  describe('createAllocation', () => {
    it('400 when the employee is not in this company', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(null);
      await expect(status(service.createAllocation(ctx, {
        employeeId: 7, projectId: 3, allocDate: '2026-06-10', plannedHours: 4,
      }))).resolves.toBe(400);
      expect(repo.createAllocation).not.toHaveBeenCalled();
    });

    it('creates and reports NOT over-allocated when load <= 8h/day', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(500);
      repo.allocatedHoursOn.mockResolvedValue(2);     // already 2h that day
      repo.createAllocation.mockResolvedValue(alloc);
      const out = await service.createAllocation(ctx, {
        employeeId: 7, projectId: 3, allocDate: '2026-06-10', plannedHours: 4,
      });
      expect(out.allocation).toBe(alloc);
      expect(out.overAllocated).toBe(false);          // 2 + 4 = 6 <= 8
      expect(out.allocatedHours).toBe(6);
    });

    it('flags over-allocation when the day exceeds capacity', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(500);
      repo.allocatedHoursOn.mockResolvedValue(6);     // already 6h that day
      repo.createAllocation.mockResolvedValue({ ...alloc, plannedHours: 4 });
      const out = await service.createAllocation(ctx, {
        employeeId: 7, projectId: 3, allocDate: '2026-06-10', plannedHours: 4,
      });
      expect(out.overAllocated).toBe(true);           // 6 + 4 = 10 > 8
      expect(out.allocatedHours).toBe(10);
    });

    it('threads a downstream work-item ref (refType/refId) through to the repo', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(500);
      repo.allocatedHoursOn.mockResolvedValue(0);
      const linked: Allocation = { ...alloc, refType: 'WORK_ORDER', refId: 42 };
      repo.createAllocation.mockResolvedValue(linked);
      const dto = {
        employeeId: 7, projectId: 3, allocDate: '2026-06-10', plannedHours: 4,
        refType: 'WORK_ORDER' as const, refId: 42,
      };
      const out = await service.createAllocation(ctx, dto);
      // The ref must reach the repository unchanged...
      expect(repo.createAllocation).toHaveBeenCalledWith(ctx, dto);
      // ...and round-trip back out on the created allocation.
      expect(out.allocation.refType).toBe('WORK_ORDER');
      expect(out.allocation.refId).toBe(42);
    });
  });

  // The both-or-neither rule is enforced at the DTO boundary (route validate()),
  // so exercise it directly against the schema (the service is past Zod).
  describe('createAllocationSchema — work-item ref refinement', () => {
    const base = { employeeId: 7, projectId: 3, allocDate: '2026-06-10', plannedHours: 4 };

    it('accepts an allocation with both refType and refId', () => {
      const r = createAllocationSchema.safeParse({ ...base, refType: 'INSTALLATION', refId: 9 });
      expect(r.success).toBe(true);
    });
    it('accepts an allocation with neither ref field', () => {
      expect(createAllocationSchema.safeParse(base).success).toBe(true);
    });
    it('rejects refType without refId', () => {
      expect(createAllocationSchema.safeParse({ ...base, refType: 'FAT' }).success).toBe(false);
    });
    it('rejects refId without refType', () => {
      expect(createAllocationSchema.safeParse({ ...base, refId: 9 }).success).toBe(false);
    });
    it('rejects an unknown refType value', () => {
      expect(createAllocationSchema.safeParse({ ...base, refType: 'SHIPMENT', refId: 9 }).success).toBe(false);
    });
  });

  describe('confirmAllocation', () => {
    it('409 unless current status is PLANNED', async () => {
      repo.findAllocationById.mockResolvedValue({ ...alloc, status: 'CONFIRMED' });
      await expect(status(service.confirmAllocation(ctx, 5, 1))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findAllocationById.mockResolvedValue(alloc);
      repo.setAllocationStatus.mockResolvedValue(null);
      await expect(status(service.confirmAllocation(ctx, 5, 1))).resolves.toBe(409);
    });
    it('confirms a PLANNED allocation', async () => {
      repo.findAllocationById.mockResolvedValue(alloc);
      repo.setAllocationStatus.mockResolvedValue({ ...alloc, status: 'CONFIRMED', rowVersion: 2 });
      const out = await service.confirmAllocation(ctx, 5, 1);
      expect(out.status).toBe('CONFIRMED');
      expect(repo.setAllocationStatus).toHaveBeenCalledWith(ctx, 5, 1, 'CONFIRMED');
    });
  });

  describe('capacityLoad', () => {
    it('400 when `to` precedes `from`', async () => {
      await expect(status(service.capacityLoad(ctx, { from: '2026-06-12', to: '2026-06-08' }))).resolves.toBe(400);
    });
    it('passes through to the repo for a valid window', async () => {
      repo.capacityLoad.mockResolvedValue([]);
      await service.capacityLoad(ctx, { from: '2026-06-08', to: '2026-06-12' });
      expect(repo.capacityLoad).toHaveBeenCalled();
    });
  });

  describe('createTimesheet', () => {
    it('400 when periodEnd precedes periodStart', async () => {
      await expect(status(service.createTimesheet(ctx, {
        employeeId: 7, periodStart: '2026-06-12', periodEnd: '2026-06-08',
        lines: [{ projectId: 3, workDate: '2026-06-09', hours: 8 }],
      }))).resolves.toBe(400);
    });
    it('400 when a line work date falls outside the period', async () => {
      await expect(status(service.createTimesheet(ctx, {
        employeeId: 7, periodStart: '2026-06-08', periodEnd: '2026-06-12',
        lines: [{ projectId: 3, workDate: '2026-06-20', hours: 8 }],
      }))).resolves.toBe(400);
    });
    it('400 when the employee is not in this company', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(null);
      await expect(status(service.createTimesheet(ctx, {
        employeeId: 7, periodStart: '2026-06-08', periodEnd: '2026-06-12',
        lines: [{ projectId: 3, workDate: '2026-06-09', hours: 8 }],
      }))).resolves.toBe(400);
      expect(repo.createTimesheet).not.toHaveBeenCalled();
    });
    it('costs lines at the employee cost rate and submits', async () => {
      repo.getEmployeeCostRate.mockResolvedValue(500);
      repo.createTimesheet.mockResolvedValue(timesheet);
      const dto = {
        employeeId: 7, periodStart: '2026-06-08', periodEnd: '2026-06-12',
        lines: [{ projectId: 3, workDate: '2026-06-09', hours: 8 }],
      };
      const out = await service.createTimesheet(ctx, dto);
      expect(out).toBe(timesheet);
      expect(repo.createTimesheet).toHaveBeenCalledWith(ctx, dto, 500);
    });
  });

  describe('approveTimesheet', () => {
    it('409 unless current status is SUBMITTED', async () => {
      repo.findTimesheetById.mockResolvedValue({ ...timesheet, status: 'APPROVED' });
      await expect(status(service.approveTimesheet(ctx, 9, 1))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findTimesheetById.mockResolvedValue(timesheet);
      repo.approveTimesheet.mockResolvedValue(null);
      await expect(status(service.approveTimesheet(ctx, 9, 1))).resolves.toBe(409);
    });
    it('approves a SUBMITTED timesheet', async () => {
      repo.findTimesheetById.mockResolvedValue(timesheet);
      repo.approveTimesheet.mockResolvedValue({ ...timesheet, status: 'APPROVED', rowVersion: 2 });
      const out = await service.approveTimesheet(ctx, 9, 1);
      expect(out.status).toBe('APPROVED');
      expect(repo.approveTimesheet).toHaveBeenCalledWith(ctx, 9, 1);
    });
  });
});
