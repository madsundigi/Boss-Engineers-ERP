import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { WorkloadRepository } from './workload.repository';
import {
  Allocation, AllocationListResult, CapacityLoad, Timesheet,
} from './workload.types';
import {
  CreateAllocationDto, ListAllocationsDto, CapacityQueryDto, CreateTimesheetDto,
} from './workload.dto';
import { DEFAULT_DAILY_CAPACITY_HOURS } from './workload.constants';

/**
 * WorkloadService — business logic for the Employee Workload module (M07).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database.
 */
export class WorkloadService {
  constructor(private readonly repo: WorkloadRepository) {}

  // ---- Allocations -------------------------------------------------------

  async listAllocations(ctx: RequestContext, query: ListAllocationsDto): Promise<AllocationListResult> {
    if (query.from && query.to && query.to < query.from) {
      throw Errors.badRequest('`to` date must be on or after `from` date');
    }
    return this.repo.listAllocations(ctx, query);
  }

  async getAllocation(ctx: RequestContext, id: number): Promise<Allocation> {
    const row = await this.repo.findAllocationById(ctx, id);
    if (!row) throw Errors.notFound(`Allocation ${id} not found`);
    return row;
  }

  /**
   * Assign a person to a project/task for a day. Verifies the employee exists in
   * the caller's company (and so has a cost rate), then flags over-allocation:
   * if the day's existing committed load plus this request exceeds the employee's
   * daily capacity, the new allocation is created with overAllocated metadata so
   * the planner sees the bottleneck (resource-leveling support, M07 KPI).
   */
  async createAllocation(
    ctx: RequestContext, dto: CreateAllocationDto,
  ): Promise<{ allocation: Allocation; overAllocated: boolean; capacityHours: number; allocatedHours: number }> {
    const costRate = await this.repo.getEmployeeCostRate(ctx, dto.employeeId);
    if (costRate === null) {
      throw Errors.badRequest(`Employee ${dto.employeeId} not found in this company`);
    }

    const existing = await this.repo.allocatedHoursOn(ctx, dto.employeeId, dto.allocDate);
    const allocation = await this.repo.createAllocation(ctx, dto);

    const allocatedHours = existing + dto.plannedHours;
    const capacityHours = DEFAULT_DAILY_CAPACITY_HOURS;
    const overAllocated = allocatedHours > capacityHours;
    return { allocation, overAllocated, capacityHours, allocatedHours };
  }

  /** Confirm a PLANNED allocation (PLANNED -> CONFIRMED). */
  async confirmAllocation(ctx: RequestContext, id: number, rowVersion: number): Promise<Allocation> {
    const existing = await this.getAllocation(ctx, id);
    if (existing.status !== 'PLANNED') {
      throw Errors.conflict(`Only a PLANNED allocation can be confirmed (current: ${existing.status})`);
    }
    const updated = await this.repo.setAllocationStatus(ctx, id, rowVersion, 'CONFIRMED');
    if (!updated) {
      throw Errors.conflict('Allocation was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Cancel an allocation (frees the committed capacity). Terminal. */
  async cancelAllocation(ctx: RequestContext, id: number, rowVersion: number): Promise<Allocation> {
    const existing = await this.getAllocation(ctx, id);
    if (existing.status === 'CANCELLED') {
      throw Errors.conflict('Allocation is already CANCELLED');
    }
    const updated = await this.repo.setAllocationStatus(ctx, id, rowVersion, 'CANCELLED');
    if (!updated) {
      throw Errors.conflict('Allocation was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Capacity-vs-load window with over-allocation flags (bottleneck alerts). */
  async capacityLoad(ctx: RequestContext, query: CapacityQueryDto): Promise<CapacityLoad[]> {
    if (query.to < query.from) {
      throw Errors.badRequest('`to` date must be on or after `from` date');
    }
    return this.repo.capacityLoad(ctx, query);
  }

  // ---- Timesheets --------------------------------------------------------

  async getTimesheet(ctx: RequestContext, id: number): Promise<Timesheet> {
    const row = await this.repo.findTimesheetById(ctx, id);
    if (!row) throw Errors.notFound(`Timesheet ${id} not found`);
    return row;
  }

  /**
   * Record a timesheet for an employee. Costs every line at the employee's cost
   * rate so actual labour cost flows to the project (M07 -> M15). The header is
   * created SUBMITTED, ready for approval.
   */
  async createTimesheet(ctx: RequestContext, dto: CreateTimesheetDto): Promise<Timesheet> {
    if (dto.periodEnd < dto.periodStart) {
      throw Errors.badRequest('periodEnd must be on or after periodStart');
    }
    const outOfRange = dto.lines.find((l) => l.workDate < dto.periodStart || l.workDate > dto.periodEnd);
    if (outOfRange) {
      throw Errors.badRequest(`Line work date ${outOfRange.workDate} is outside the timesheet period`);
    }
    const costRate = await this.repo.getEmployeeCostRate(ctx, dto.employeeId);
    if (costRate === null) {
      throw Errors.badRequest(`Employee ${dto.employeeId} not found in this company`);
    }
    return this.repo.createTimesheet(ctx, dto, costRate);
  }

  /**
   * Approve a timesheet (TIMESHEET.APPROVE). Only a SUBMITTED timesheet may be
   * approved; APPROVED/REJECTED are terminal. Optimistic-locked on row_version.
   */
  async approveTimesheet(ctx: RequestContext, id: number, rowVersion: number): Promise<Timesheet> {
    const existing = await this.getTimesheet(ctx, id);
    if (existing.status !== 'SUBMITTED') {
      throw Errors.conflict(`Only a SUBMITTED timesheet can be approved (current: ${existing.status})`);
    }
    const updated = await this.repo.approveTimesheet(ctx, id, rowVersion);
    if (!updated) {
      throw Errors.conflict('Timesheet was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }
}
