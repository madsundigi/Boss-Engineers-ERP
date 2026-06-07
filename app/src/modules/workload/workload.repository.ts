import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import {
  Allocation, AllocationListResult, CapacityLoad, Timesheet, TimesheetLine,
} from './workload.types';
import { ListAllocationsDto, CapacityQueryDto } from './workload.dto';
import { AllocationStatus, DEFAULT_DAILY_CAPACITY_HOURS } from './workload.constants';

const ALLOC_COLS = `a.alloc_id, a.company_id, a.employee_id, e.full_name AS employee_name,
  a.project_id, a.task_id, a.alloc_date, a.planned_hours, a.status, a.row_version`;

const TS_COLS = `t.ts_id, t.company_id, t.employee_id, e.full_name AS employee_name,
  t.period_start, t.period_end, t.status, t.submitted_at, t.approved_by, t.approved_at,
  t.row_version`;

function mapAllocation(r: QueryResultRow): Allocation {
  return {
    allocId: Number(r.alloc_id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    employeeName: r.employee_name ?? null,
    projectId: Number(r.project_id),
    taskId: r.task_id == null ? null : Number(r.task_id),
    allocDate: r.alloc_date,
    plannedHours: Number(r.planned_hours),
    status: r.status,
    rowVersion: Number(r.row_version),
  };
}

function mapLine(r: QueryResultRow): TimesheetLine {
  return {
    tsLineId: Number(r.ts_line_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    workDate: r.work_date,
    hours: Number(r.hours),
    costAmount: Number(r.cost_amount),
  };
}

function mapTimesheet(r: QueryResultRow, lines: TimesheetLine[]): Timesheet {
  return {
    tsId: Number(r.ts_id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    employeeName: r.employee_name ?? null,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    submittedAt: r.submitted_at ?? null,
    approvedBy: r.approved_by == null ? null : Number(r.approved_by),
    approvedAt: r.approved_at ?? null,
    rowVersion: Number(r.row_version),
    totalHours: lines.reduce((s, l) => s + l.hours, 0),
    totalCost: lines.reduce((s, l) => s + l.costAmount, 0),
    lines,
  };
}

export interface CreateAllocationRow {
  employeeId: number;
  projectId: number;
  taskId?: number;
  allocDate: string;
  plannedHours: number;
}

export interface CreateTimesheetLineRow {
  projectId: number;
  wbsId?: number;
  workDate: string;
  hours: number;
}

export interface CreateTimesheetRow {
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  lines: CreateTimesheetLineRow[];
}

export class WorkloadRepository {
  constructor(private readonly pool: Pool) {}

  // ---- Employee helpers --------------------------------------------------

  /** Resolve an employee's per-hour cost rate (company-scoped). Null if not found. */
  async getEmployeeCostRate(ctx: RequestContext, employeeId: number): Promise<number | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ cost_rate: string }>(
        `SELECT cost_rate FROM hcm.employee
          WHERE employee_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [employeeId, ctx.companyId],
      );
      return res.rowCount ? Number(res.rows[0].cost_rate) : null;
    });
  }

  // ---- Allocations -------------------------------------------------------

  /** Sum of planned hours already committed for an employee on a given date. */
  async allocatedHoursOn(ctx: RequestContext, employeeId: number, allocDate: string): Promise<number> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ total: string }>(
        `SELECT COALESCE(SUM(planned_hours), 0)::text AS total
           FROM hcm.resource_allocation
          WHERE company_id = $1 AND employee_id = $2 AND alloc_date = $3
            AND status <> 'CANCELLED'`,
        [ctx.companyId, employeeId, allocDate],
      );
      return Number(res.rows[0].total);
    });
  }

  async createAllocation(ctx: RequestContext, data: CreateAllocationRow): Promise<Allocation> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `WITH ins AS (
           INSERT INTO hcm.resource_allocation
             (company_id, employee_id, project_id, task_id, alloc_date, planned_hours, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PLANNED')
           RETURNING alloc_id, company_id, employee_id, project_id, task_id,
                     alloc_date, planned_hours, status, row_version
         )
         SELECT a.alloc_id, a.company_id, a.employee_id, e.full_name AS employee_name,
                a.project_id, a.task_id, a.alloc_date, a.planned_hours, a.status, a.row_version
           FROM ins a
           LEFT JOIN hcm.employee e ON e.employee_id = a.employee_id`,
        [ctx.companyId, data.employeeId, data.projectId, data.taskId ?? null,
          data.allocDate, data.plannedHours],
      );
      return mapAllocation(res.rows[0]);
    });
  }

  async findAllocationById(ctx: RequestContext, id: number): Promise<Allocation | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${ALLOC_COLS}
           FROM hcm.resource_allocation a
           LEFT JOIN hcm.employee e ON e.employee_id = a.employee_id
          WHERE a.alloc_id = $1 AND a.company_id = $2`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapAllocation(res.rows[0]) : null;
    });
  }

  async listAllocations(ctx: RequestContext, q: ListAllocationsDto): Promise<AllocationListResult> {
    const where: string[] = ['a.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.employeeId) { params.push(q.employeeId); where.push(`a.employee_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`a.project_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`a.status = $${params.length}`); }
    if (q.from) { params.push(q.from); where.push(`a.alloc_date >= $${params.length}`); }
    if (q.to) { params.push(q.to); where.push(`a.alloc_date <= $${params.length}`); }
    const whereSql = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const totalRes = await c.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM hcm.resource_allocation a WHERE ${whereSql}`,
        params,
      );
      const total = Number(totalRes.rows[0].total);

      const rowsRes = await c.query(
        `SELECT ${ALLOC_COLS}
           FROM hcm.resource_allocation a
           LEFT JOIN hcm.employee e ON e.employee_id = a.employee_id
          WHERE ${whereSql}
          ORDER BY a.${q.sort} ${q.dir.toUpperCase()}, a.alloc_id ${q.dir.toUpperCase()}
          LIMIT ${q.pageSize} OFFSET ${offset}`,
        params,
      );
      return { rows: rowsRes.rows.map(mapAllocation), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked status change (e.g. confirm / cancel). Null on version mismatch. */
  async setAllocationStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: AllocationStatus,
  ): Promise<Allocation | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `WITH upd AS (
           UPDATE hcm.resource_allocation
              SET status = $1, row_version = row_version + 1
            WHERE alloc_id = $2 AND company_id = $3 AND row_version = $4
            RETURNING alloc_id, company_id, employee_id, project_id, task_id,
                      alloc_date, planned_hours, status, row_version
         )
         SELECT a.alloc_id, a.company_id, a.employee_id, e.full_name AS employee_name,
                a.project_id, a.task_id, a.alloc_date, a.planned_hours, a.status, a.row_version
           FROM upd a
           LEFT JOIN hcm.employee e ON e.employee_id = a.employee_id`,
        [status, id, ctx.companyId, expectedVersion],
      );
      return res.rowCount ? mapAllocation(res.rows[0]) : null;
    });
  }

  /**
   * Capacity-vs-load over a date window. LEFT JOINs the per-day allocation load
   * onto the capacity calendar; where no calendar row exists a standard working
   * day is assumed so load still has a baseline to flag against.
   */
  async capacityLoad(ctx: RequestContext, q: CapacityQueryDto): Promise<CapacityLoad[]> {
    const params: unknown[] = [ctx.companyId, q.from, q.to];
    let empFilter = '';
    if (q.employeeId) { params.push(q.employeeId); empFilter = `AND a.employee_id = $${params.length}`; }

    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `WITH load AS (
           SELECT a.employee_id, a.alloc_date, SUM(a.planned_hours) AS allocated_hours
             FROM hcm.resource_allocation a
            WHERE a.company_id = $1 AND a.alloc_date BETWEEN $2 AND $3
              AND a.status <> 'CANCELLED' ${empFilter}
            GROUP BY a.employee_id, a.alloc_date
         )
         SELECT l.employee_id, e.full_name AS employee_name, l.alloc_date,
                COALESCE(cc.available_hours, ${DEFAULT_DAILY_CAPACITY_HOURS}) AS capacity_hours,
                l.allocated_hours
           FROM load l
           JOIN hcm.employee e ON e.employee_id = l.employee_id
           LEFT JOIN hcm.capacity_calendar cc
             ON cc.employee_id = l.employee_id AND cc.cal_date = l.alloc_date
          ORDER BY l.alloc_date, l.employee_id`,
        params,
      );
      return res.rows.map((r) => {
        const capacityHours = Number(r.capacity_hours);
        const allocatedHours = Number(r.allocated_hours);
        return {
          employeeId: Number(r.employee_id),
          employeeName: r.employee_name ?? null,
          allocDate: r.alloc_date,
          capacityHours,
          allocatedHours,
          overAllocated: allocatedHours > capacityHours,
        };
      });
    });
  }

  // ---- Timesheets --------------------------------------------------------

  private async fetchLines(c: Queryable, tsId: number): Promise<TimesheetLine[]> {
    const res = await c.query(
      `SELECT ts_line_id, project_id, wbs_id, work_date, hours, cost_amount
         FROM hcm.timesheet_line WHERE timesheet_id = $1 ORDER BY ts_line_id`,
      [tsId],
    );
    return res.rows.map(mapLine);
  }

  /**
   * Insert a SUBMITTED timesheet header + its lines in one transaction. Each
   * line's cost_amount is hours * costRate so labour actuals flow to project
   * cost (M15) — the most-regretted skipped control per the FRD.
   */
  async createTimesheet(
    ctx: RequestContext, data: CreateTimesheetRow, costRate: number,
  ): Promise<Timesheet> {
    return runInContext(this.pool, ctx, async (c) => {
      const head = await c.query(
        `INSERT INTO hcm.timesheet
           (company_id, employee_id, period_start, period_end, status, submitted_at)
         VALUES ($1,$2,$3,$4,'SUBMITTED', now())
         RETURNING ts_id`,
        [ctx.companyId, data.employeeId, data.periodStart, data.periodEnd],
      );
      const tsId = Number(head.rows[0].ts_id);

      for (const l of data.lines) {
        await c.query(
          `INSERT INTO hcm.timesheet_line
             (timesheet_id, project_id, wbs_id, work_date, hours, cost_amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tsId, l.projectId, l.wbsId ?? null, l.workDate, l.hours, l.hours * costRate],
        );
      }

      const headerRow = await c.query(
        `SELECT ${TS_COLS}
           FROM hcm.timesheet t
           LEFT JOIN hcm.employee e ON e.employee_id = t.employee_id
          WHERE t.ts_id = $1`,
        [tsId],
      );
      const lines = await this.fetchLines(c, tsId);
      return mapTimesheet(headerRow.rows[0], lines);
    });
  }

  async findTimesheetById(ctx: RequestContext, id: number): Promise<Timesheet | null> {
    return runRead(this.pool, ctx, async (c) => {
      const headerRow = await c.query(
        `SELECT ${TS_COLS}
           FROM hcm.timesheet t
           LEFT JOIN hcm.employee e ON e.employee_id = t.employee_id
          WHERE t.ts_id = $1 AND t.company_id = $2`,
        [id, ctx.companyId],
      );
      if (!headerRow.rowCount) return null;
      const lines = await this.fetchLines(c, id);
      return mapTimesheet(headerRow.rows[0], lines);
    });
  }

  /**
   * Optimistic-locked approval: stamp approver + approved_at and flip to APPROVED.
   * Returns null if the row_version did not match (concurrent edit -> 409).
   */
  async approveTimesheet(
    ctx: RequestContext, id: number, expectedVersion: number,
  ): Promise<Timesheet | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query<{ ts_id: string }>(
        `UPDATE hcm.timesheet
            SET status = 'APPROVED', approved_by = $1, approved_at = now(),
                row_version = row_version + 1
          WHERE ts_id = $2 AND company_id = $3 AND row_version = $4
        RETURNING ts_id`,
        [ctx.userId, id, ctx.companyId, expectedVersion],
      );
      if (!upd.rowCount) return null;
      const headerRow = await c.query(
        `SELECT ${TS_COLS}
           FROM hcm.timesheet t
           LEFT JOIN hcm.employee e ON e.employee_id = t.employee_id
          WHERE t.ts_id = $1`,
        [id],
      );
      const lines = await this.fetchLines(c, id);
      return mapTimesheet(headerRow.rows[0], lines);
    });
  }
}
