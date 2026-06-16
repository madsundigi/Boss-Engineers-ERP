import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) for the Employee Workload
 * module against a real database. Runs only when DATABASE_URL is set (provisioned
 * by the test harness) so the suite is a no-op without a database.
 *
 * Fixtures: the base hcm.resource_allocation / hcm.timesheet reference an
 * hcm.employee, which in turn needs a department + designation; allocations and
 * timesheet lines also reference a proj.project. We seed a minimal employee +
 * project for company BE in beforeAll (idempotent) so the module has the master
 * data it requires.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Workload API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let hrUser: number;
  let planningUser: number;
  let salesUser: number;
  let employeeId: number;
  let projectId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = createApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    hrUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='hr_user'`)).user_id);
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Department fixture so the allocation projection can surface a department
    // name (idempotent on the unique (company_id, dept_code)).
    const dept = await one(
      `INSERT INTO hcm.department (company_id, dept_code, dept_name)
       VALUES ($1,'DEPT-WL-TEST','Workload Test Dept')
       ON CONFLICT (company_id, dept_code) DO UPDATE SET dept_name = EXCLUDED.dept_name
       RETURNING department_id`,
      [companyId],
    );
    const departmentId = Number(dept.department_id);

    // Minimal employee (idempotent on the unique emp_code). cost_rate drives
    // the timesheet line cost_amount, so set a non-zero rate. Attached to the
    // department above so the allocation read projection resolves a dept name.
    const emp = await one(
      `INSERT INTO hcm.employee (company_id, emp_code, full_name, department_id, cost_rate, billing_rate, status)
       VALUES ($1,'EMP-WL-TEST','Workload Test Engineer', $2, 500, 900, 'ACTIVE')
       ON CONFLICT (emp_code) DO UPDATE SET full_name = EXCLUDED.full_name, department_id = EXCLUDED.department_id
       RETURNING employee_id`,
      [companyId, departmentId],
    );
    employeeId = Number(emp.employee_id);

    // Minimal project (allocations + timesheet lines reference proj.project).
    const custId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST'`)).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1,'PRJ-WL-TEST','Workload Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`,
      [companyId, custId, hrUser],
    );
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  // ---- Allocations -------------------------------------------------------

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/workload/allocations');
    expect(res.status).toBe(401);
  });

  it('lists allocations (200) for a WORKLOAD.VIEW holder', async () => {
    const res = await request(app).get('/api/workload/allocations').set(hdr(hrUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('creates an allocation (201) and reports capacity vs load', async () => {
    const res = await request(app).post('/api/workload/allocations').set(hdr(hrUser)).send({
      employeeId, projectId, allocDate: '2026-06-10', plannedHours: 4, completionPct: 25,
    });
    expect(res.status).toBe(201);
    expect(res.body.allocation.status).toBe('PLANNED');
    expect(res.body.allocation.employeeId).toBe(employeeId);
    // The assigned employee's department name surfaces on the projection.
    expect(res.body.allocation.department).toBe('Workload Test Dept');
    // completionPct round-trips out on the created allocation.
    expect(res.body.allocation.completionPct).toBe(25);
    // No work-item ref supplied -> both ref fields null on the projection.
    expect(res.body.allocation.refType).toBeNull();
    expect(res.body.allocation.refId).toBeNull();
    expect(typeof res.body.overAllocated).toBe('boolean');
    expect(res.body.allocatedHours).toBeGreaterThanOrEqual(4);

    // The completion % must survive a re-read (GET by id).
    const got = await request(app).get(`/api/workload/allocations/${res.body.allocation.allocId}`).set(hdr(hrUser));
    expect(got.status).toBe(200);
    expect(got.body.completionPct).toBe(25);
    expect(got.body.department).toBe('Workload Test Dept');
  });

  it('links an allocation to a downstream work item (refType/refId round-trips)', async () => {
    const res = await request(app).post('/api/workload/allocations').set(hdr(hrUser)).send({
      employeeId, projectId, allocDate: '2026-06-13', plannedHours: 4,
      refType: 'WORK_ORDER', refId: 12345,
    });
    expect(res.status).toBe(201);
    expect(res.body.allocation.refType).toBe('WORK_ORDER');
    expect(res.body.allocation.refId).toBe(12345);

    // The ref must survive a re-read (confirm via GET by id).
    const got = await request(app).get(`/api/workload/allocations/${res.body.allocation.allocId}`).set(hdr(hrUser));
    expect(got.status).toBe(200);
    expect(got.body.refType).toBe('WORK_ORDER');
    expect(got.body.refId).toBe(12345);
  });

  it('rejects a half-specified work-item ref (400): refType without refId', async () => {
    const res = await request(app).post('/api/workload/allocations').set(hdr(hrUser))
      .send({ employeeId, projectId, allocDate: '2026-06-13', plannedHours: 4, refType: 'FAT' });
    expect(res.status).toBe(400);
  });

  it('flags over-allocation once the day exceeds 8h capacity', async () => {
    // Two more 4h allocations on the same day push committed load past 8h.
    await request(app).post('/api/workload/allocations').set(hdr(hrUser))
      .send({ employeeId, projectId, allocDate: '2026-06-11', plannedHours: 5 });
    const res = await request(app).post('/api/workload/allocations').set(hdr(hrUser))
      .send({ employeeId, projectId, allocDate: '2026-06-11', plannedHours: 5 });
    expect(res.status).toBe(201);
    expect(res.body.overAllocated).toBe(true);     // 5 + 5 = 10 > 8
  });

  it('returns a capacity-vs-load window (200)', async () => {
    // Scope to THIS suite's employee: the capacity view is global (all employees),
    // and other suites can seed allocations on the same calendar day, so an
    // unfiltered find() could pick a different employee's under-allocated row.
    const res = await request(app)
      .get(`/api/workload/allocations/capacity?from=2026-06-09&to=2026-06-12&employeeId=${employeeId}`)
      .set(hdr(hrUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    const over = res.body.rows.find((r: { allocDate: string; overAllocated: boolean }) => r.allocDate === '2026-06-11');
    expect(over?.overAllocated).toBe(true);
  });

  it('rejects an invalid allocation body (400)', async () => {
    const r1 = await request(app).post('/api/workload/allocations').set(hdr(hrUser))
      .send({ projectId, allocDate: '2026-06-10', plannedHours: 4 }); // missing employeeId
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/workload/allocations').set(hdr(hrUser))
      .send({ employeeId, projectId, allocDate: '2026-06-10', plannedHours: 30 }); // > 24h
    expect(r2.status).toBe(400);
  });

  it('denies allocation create without WORKLOAD.CREATE (403 for sales_user)', async () => {
    const res = await request(app).post('/api/workload/allocations').set(hdr(salesUser))
      .send({ employeeId, projectId, allocDate: '2026-06-10', plannedHours: 4 });
    expect(res.status).toBe(403);
  });

  it('denies allocation list without WORKLOAD.VIEW (403 for sales_user)', async () => {
    const res = await request(app).get('/api/workload/allocations').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  // ---- Timesheets --------------------------------------------------------

  it('creates and approves a timesheet (planning_user approves)', async () => {
    const created = await request(app).post('/api/workload/timesheets').set(hdr(hrUser)).send({
      employeeId, periodStart: '2026-06-08', periodEnd: '2026-06-12',
      lines: [
        { projectId, workDate: '2026-06-09', hours: 8 },
        { projectId, workDate: '2026-06-10', hours: 6 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('SUBMITTED');
    expect(created.body.totalHours).toBe(14);
    // cost_amount = hours * cost_rate(500): (8 + 6) * 500 = 7000
    expect(created.body.totalCost).toBe(7000);
    const tsId = created.body.tsId;
    const rowVersion = created.body.rowVersion;

    // PLANNING holds TIMESHEET.APPROVE.
    const approved = await request(app).post(`/api/workload/timesheets/${tsId}/approve`)
      .set(hdr(planningUser)).send({ rowVersion });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedBy).toBe(planningUser);

    // Re-approving a now-APPROVED timesheet is a 409 (terminal).
    const again = await request(app).post(`/api/workload/timesheets/${tsId}/approve`)
      .set(hdr(planningUser)).send({ rowVersion: approved.body.rowVersion });
    expect(again.status).toBe(409);
  });

  it('rejects an invalid timesheet body (400): no lines', async () => {
    const res = await request(app).post('/api/workload/timesheets').set(hdr(hrUser)).send({
      employeeId, periodStart: '2026-06-08', periodEnd: '2026-06-12', lines: [],
    });
    expect(res.status).toBe(400);
  });

  it('denies timesheet approve without TIMESHEET.APPROVE (403 for sales_user)', async () => {
    const created = await request(app).post('/api/workload/timesheets').set(hdr(hrUser)).send({
      employeeId, periodStart: '2026-06-08', periodEnd: '2026-06-12',
      lines: [{ projectId, workDate: '2026-06-09', hours: 8 }],
    });
    expect(created.status).toBe(201);
    const res = await request(app).post(`/api/workload/timesheets/${created.body.tsId}/approve`)
      .set(hdr(salesUser)).send({ rowVersion: created.body.rowVersion });
    expect(res.status).toBe(403);
  });

  // ---- RLS ---------------------------------------------------------------

  it('RLS isolates tenants on an unfiltered allocation scan (BUG-01 fix)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE erp_app');
      await c.query(`SELECT set_config('app.company_id', '999999', true)`);
      const wrong = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM hcm.resource_allocation');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [String(companyId)]);
      const right = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM hcm.resource_allocation');
      await c.query('COMMIT');
      expect(wrong.rows[0].n).toBe(0);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      c.release();
    }
  });
});
