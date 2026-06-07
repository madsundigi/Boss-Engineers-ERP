import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  Employee, EmployeeListResult, Department, Designation,
  Leave, LeaveListResult, AttendanceSummary,
} from './hr.types';
import {
  ListEmployeesDto, ListLeavesDto, AttendanceQueryDto,
} from './hr.dto';
import { EmployeeStatus, LeaveStatus } from './hr.constants';

/** Selectable columns of hcm.employee (db/03 already ships the audit/concurrency set). */
const EMP_COLS = `employee_id, company_id, emp_code, full_name, department_id, designation_id,
  bu_id, cost_rate, billing_rate, doj, status, created_at, created_by, updated_at, row_version`;

function mapEmployee(r: QueryResultRow): Employee {
  return {
    employeeId: Number(r.employee_id),
    companyId: Number(r.company_id),
    empCode: r.emp_code,
    fullName: r.full_name,
    departmentId: r.department_id == null ? null : Number(r.department_id),
    designationId: r.designation_id == null ? null : Number(r.designation_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    costRate: Number(r.cost_rate),
    billingRate: Number(r.billing_rate),
    doj: r.doj ?? null,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}

function mapDepartment(r: QueryResultRow): Department {
  return {
    departmentId: Number(r.department_id),
    companyId: Number(r.company_id),
    deptCode: r.dept_code,
    deptName: r.dept_name,
  };
}

function mapDesignation(r: QueryResultRow): Designation {
  return {
    designationId: Number(r.designation_id),
    desigCode: r.desig_code,
    desigName: r.desig_name,
  };
}

function mapLeave(r: QueryResultRow): Leave {
  return {
    leaveId: Number(r.leave_id),
    employeeId: Number(r.employee_id),
    employeeName: r.employee_name ?? null,
    fromDate: r.from_date,
    toDate: r.to_date,
    leaveType: r.leave_type ?? null,
    days: r.days == null ? 0 : Number(r.days),
    reason: r.reason ?? null,
    status: r.status,
    approverId: r.approver_id == null ? null : Number(r.approver_id),
    approvedAt: r.approved_at ?? null,
    rowVersion: Number(r.row_version),
  };
}

export interface CreateEmployeeRow {
  empCode: string;
  fullName: string;
  departmentId?: number;
  designationId?: number;
  buId?: number;
  costRate?: number;
  billingRate?: number;
  doj?: string;
  status: EmployeeStatus;
}

export interface UpdateEmployeeFields {
  fullName?: string;
  departmentId?: number | null;
  designationId?: number | null;
  buId?: number | null;
  costRate?: number;
  billingRate?: number;
  doj?: string;
  status?: EmployeeStatus;
}

export interface CreateLeaveRow {
  employeeId: number;
  fromDate: string;
  toDate: string;
  leaveType?: string;
  reason?: string;
  days: number;
}

export class HrRepository {
  constructor(private readonly pool: Pool) {}

  // ---- Employee master ---------------------------------------------------

  /** True if an emp_code is already used inside the caller's company (uniqueness). */
  async empCodeExists(ctx: RequestContext, empCode: string): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM hcm.employee
          WHERE company_id = $1 AND emp_code = $2 AND NOT is_deleted LIMIT 1`,
        [ctx.companyId, empCode],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async createEmployee(ctx: RequestContext, data: CreateEmployeeRow): Promise<Employee> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `INSERT INTO hcm.employee
           (company_id, emp_code, full_name, department_id, designation_id, bu_id,
            cost_rate, billing_rate, doj, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,
                 COALESCE($7,0), COALESCE($8,0), $9, $10, $11, $11)
         RETURNING ${EMP_COLS}`,
        [
          ctx.companyId, data.empCode, data.fullName, data.departmentId ?? null,
          data.designationId ?? null, data.buId ?? null, data.costRate ?? null,
          data.billingRate ?? null, data.doj ?? null, data.status, ctx.userId,
        ],
      );
      return mapEmployee(res.rows[0]);
    });
  }

  async findEmployeeById(ctx: RequestContext, id: number): Promise<Employee | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${EMP_COLS} FROM hcm.employee
          WHERE employee_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapEmployee(res.rows[0]) : null;
    });
  }

  async listEmployees(ctx: RequestContext, q: ListEmployeesDto): Promise<EmployeeListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.departmentId) { params.push(q.departmentId); where.push(`department_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(emp_code ILIKE $${params.length} OR full_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM hcm.employee WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${EMP_COLS} FROM hcm.employee WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()}, employee_id ${q.dir.toUpperCase()}
          LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapEmployee), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked master update. Null on a row-version mismatch (409). */
  async updateEmployee(
    ctx: RequestContext, id: number, expectedVersion: number, fields: UpdateEmployeeFields,
  ): Promise<Employee | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.fullName !== undefined) add('full_name', fields.fullName);
    if (fields.departmentId !== undefined) add('department_id', fields.departmentId);
    if (fields.designationId !== undefined) add('designation_id', fields.designationId);
    if (fields.buId !== undefined) add('bu_id', fields.buId);
    if (fields.costRate !== undefined) add('cost_rate', fields.costRate);
    if (fields.billingRate !== undefined) add('billing_rate', fields.billingRate);
    if (fields.doj !== undefined) add('doj', fields.doj);
    if (fields.status !== undefined) add('status', fields.status);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE hcm.employee
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE employee_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${EMP_COLS}`, params);
      return res.rowCount ? mapEmployee(res.rows[0]) : null;
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDeleteEmployee(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE hcm.employee
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE employee_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // ---- Department / Designation (reference data) -------------------------

  async listDepartments(ctx: RequestContext): Promise<Department[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT department_id, company_id, dept_code, dept_name FROM hcm.department
          WHERE company_id = $1 ORDER BY dept_code`, [ctx.companyId]);
      return res.rows.map(mapDepartment);
    });
  }

  async createDepartment(ctx: RequestContext, deptCode: string, deptName: string): Promise<Department> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO hcm.department (company_id, dept_code, dept_name)
         VALUES ($1,$2,$3)
         RETURNING department_id, company_id, dept_code, dept_name`,
        [ctx.companyId, deptCode, deptName]);
      return mapDepartment(res.rows[0]);
    });
  }

  async listDesignations(ctx: RequestContext): Promise<Designation[]> {
    // hcm.designation is company-global (no company_id); RLS does not apply.
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT designation_id, desig_code, desig_name FROM hcm.designation
          ORDER BY desig_code`);
      return res.rows.map(mapDesignation);
    });
  }

  async createDesignation(ctx: RequestContext, desigCode: string, desigName: string): Promise<Designation> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO hcm.designation (desig_code, desig_name)
         VALUES ($1,$2)
         RETURNING designation_id, desig_code, desig_name`,
        [desigCode, desigName]);
      return mapDesignation(res.rows[0]);
    });
  }

  // ---- Leave -------------------------------------------------------------

  /**
   * The employee_id linked to a user (sec.app_user.employee_id), scoped to the
   * caller's company. Used for the approve-leave Segregation-of-Duties check
   * (an approver may not approve their own leave). Null if the user is not
   * linked to an employee in this company.
   */
  async employeeIdForUser(ctx: RequestContext, userId: number): Promise<number | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ employee_id: string }>(
        `SELECT u.employee_id
           FROM sec.app_user u
           JOIN hcm.employee e ON e.employee_id = u.employee_id AND e.company_id = $2
          WHERE u.user_id = $1 AND u.employee_id IS NOT NULL`,
        [userId, ctx.companyId]);
      return res.rowCount ? Number(res.rows[0].employee_id) : null;
    });
  }

  async createLeave(ctx: RequestContext, data: CreateLeaveRow): Promise<Leave> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `WITH ins AS (
           INSERT INTO hcm.leave
             (employee_id, from_date, to_date, leave_type, days, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
           RETURNING leave_id, employee_id, from_date, to_date, leave_type, days,
                     reason, status, approver_id, approved_at, row_version
         )
         SELECT l.*, e.full_name AS employee_name
           FROM ins l LEFT JOIN hcm.employee e ON e.employee_id = l.employee_id`,
        [data.employeeId, data.fromDate, data.toDate, data.leaveType ?? null,
          data.days, data.reason ?? null]);
      return mapLeave(res.rows[0]);
    });
  }

  async findLeaveById(ctx: RequestContext, id: number): Promise<Leave | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT l.leave_id, l.employee_id, e.full_name AS employee_name,
                l.from_date, l.to_date, l.leave_type, l.days, l.reason, l.status,
                l.approver_id, l.approved_at, l.row_version
           FROM hcm.leave l
           JOIN hcm.employee e ON e.employee_id = l.employee_id
          WHERE l.leave_id = $1 AND e.company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapLeave(res.rows[0]) : null;
    });
  }

  async listLeaves(ctx: RequestContext, q: ListLeavesDto): Promise<LeaveListResult> {
    const where: string[] = ['e.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.employeeId) { params.push(q.employeeId); where.push(`l.employee_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`l.status = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM hcm.leave l
           JOIN hcm.employee e ON e.employee_id = l.employee_id WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT l.leave_id, l.employee_id, e.full_name AS employee_name,
                l.from_date, l.to_date, l.leave_type, l.days, l.reason, l.status,
                l.approver_id, l.approved_at, l.row_version
           FROM hcm.leave l
           JOIN hcm.employee e ON e.employee_id = l.employee_id
          WHERE ${w}
          ORDER BY l.${q.sort} ${q.dir.toUpperCase()}, l.leave_id ${q.dir.toUpperCase()}
          LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapLeave), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Optimistic-locked status change. On APPROVED the approver + approved_at are
   * stamped; a reason may be patched (reject). An optional outbox event is
   * emitted atomically with the state change (transactional outbox).
   * Returns null on a row-version mismatch (409).
   */
  async setLeaveStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: LeaveStatus,
    opts: { stampApprover?: boolean; reason?: string; event?: OutboxEventInput } = {},
  ): Promise<Leave | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    if (opts.stampApprover) {
      params.push(ctx.userId); set.push(`approver_id = $${params.length}`);
      set.push('approved_at = now()');
    }
    if (opts.reason !== undefined) { params.push(opts.reason); set.push(`reason = $${params.length}`); }

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(expectedVersion); const pVer = params.length;
      // Guard the tenant via the owning employee (hcm.leave has no company_id).
      params.push(ctx.companyId); const pCo = params.length;
      const upd = await c.query<{ leave_id: string }>(
        `UPDATE hcm.leave l
            SET ${set.join(', ')}, row_version = row_version + 1
          WHERE l.leave_id = $${pId} AND l.row_version = $${pVer}
            AND EXISTS (SELECT 1 FROM hcm.employee e
                         WHERE e.employee_id = l.employee_id AND e.company_id = $${pCo})
        RETURNING l.leave_id`, params);
      if (!upd.rowCount) return null;
      if (opts.event) await emitOutbox(c, opts.event);
      return this.findLeaveByIdInTx(c, ctx, id);
    });
  }

  /** Re-read a leave inside an open transaction (post-mutation projection). */
  private async findLeaveByIdInTx(c: Queryable, ctx: RequestContext, id: number): Promise<Leave | null> {
    const res = await c.query(
      `SELECT l.leave_id, l.employee_id, e.full_name AS employee_name,
              l.from_date, l.to_date, l.leave_type, l.days, l.reason, l.status,
              l.approver_id, l.approved_at, l.row_version
         FROM hcm.leave l
         JOIN hcm.employee e ON e.employee_id = l.employee_id
        WHERE l.leave_id = $1 AND e.company_id = $2`,
      [id, ctx.companyId]);
    return res.rowCount ? mapLeave(res.rows[0]) : null;
  }

  // ---- Attendance summary (read-only over Workload-owned timesheet + leave) --

  /**
   * Per-employee attendance for a calendar month: total timesheet hours
   * (hcm.timesheet_line, joined via its parent timesheet — owned by Workload,
   * read-only) and total APPROVED leave days overlapping the month
   * (hcm.leave). The timesheet hours are summed by work_date in the month; the
   * leave days are the stored whole-day counts of approved leaves whose range
   * intersects the month window.
   */
  async attendanceSummary(
    ctx: RequestContext, q: AttendanceQueryDto,
  ): Promise<AttendanceSummary[]> {
    const monthStart = `${q.month}-01`;
    const params: unknown[] = [ctx.companyId, monthStart];
    let empFilter = '';
    if (q.employeeId) { params.push(q.employeeId); empFilter = `AND e.employee_id = $${params.length}`; }

    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `WITH mwin AS (
           SELECT $2::date AS m_start, ($2::date + INTERVAL '1 month')::date AS m_end
         ),
         hrs AS (
           SELECT t.employee_id, COALESCE(SUM(tl.hours), 0) AS worked_hours
             FROM hcm.timesheet t
             JOIN hcm.timesheet_line tl ON tl.timesheet_id = t.ts_id
            CROSS JOIN mwin w
            WHERE t.company_id = $1
              AND tl.work_date >= w.m_start AND tl.work_date < w.m_end
            GROUP BY t.employee_id
         ),
         lv AS (
           SELECT l.employee_id, COALESCE(SUM(l.days), 0) AS leave_days
             FROM hcm.leave l
            CROSS JOIN mwin w
            WHERE l.status = 'APPROVED'
              AND l.from_date < w.m_end AND l.to_date >= w.m_start
            GROUP BY l.employee_id
         )
         SELECT e.employee_id, e.full_name AS employee_name,
                COALESCE(hrs.worked_hours, 0) AS worked_hours,
                COALESCE(lv.leave_days, 0)    AS leave_days
           FROM hcm.employee e
           LEFT JOIN hrs ON hrs.employee_id = e.employee_id
           LEFT JOIN lv  ON lv.employee_id  = e.employee_id
          WHERE e.company_id = $1 AND NOT e.is_deleted ${empFilter}
            AND (hrs.employee_id IS NOT NULL OR lv.employee_id IS NOT NULL)
          ORDER BY e.employee_id`,
        params);
      return res.rows.map((r) => ({
        employeeId: Number(r.employee_id),
        employeeName: r.employee_name ?? null,
        month: q.month,
        workedHours: Number(r.worked_hours),
        leaveDays: Number(r.leave_days),
      }));
    });
  }
}
