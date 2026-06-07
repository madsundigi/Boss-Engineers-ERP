import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { hrRouter } from '../src/modules/hr/hr.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts hrRouter at /api/hr exactly as the composition root does;
 * here we mount a minimal equivalent so the module is testable independently.
 * HR drives the employee master + leave workflow (EMPLOYEE.* / LEAVE.*);
 * SALES has neither EMPLOYEE.CREATE nor LEAVE.CREATE, so it is the 403 control.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/hr', hrRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('HR API (integration) — employee master, leave workflow, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let hrUser: number;
  let salesUser: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    hrUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='hr_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;
  let empCode: string;

  it('creates an employee (201) as hr_user, in ACTIVE', async () => {
    empCode = `EMP-${Date.now()}`;
    const res = await request(app).post('/api/hr/employees').set(hdr(hrUser)).send({
      empCode, fullName: 'Test Employee', costRate: 500, status: 'ACTIVE',
    });
    expect(res.status).toBe(201);
    expect(res.body.empCode).toBe(empCode);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.rowVersion).toBe(1);
    createdId = res.body.employeeId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without EMPLOYEE.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/hr/employees').set(hdr(salesUser))
      .send({ empCode: `X-${Date.now()}`, fullName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required fields', async () => {
    const res = await request(app).post('/api/hr/employees').set(hdr(hrUser)).send({ fullName: 'No Code' });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/hr/employees');
    expect(res.status).toBe(401);
  });

  it('lists employees (200) and fetches one + 404 unknown', async () => {
    const list = await request(app).get('/api/hr/employees?status=ACTIVE').set(hdr(hrUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/hr/employees/${createdId}`).set(hdr(hrUser));
    expect(ok.status).toBe(200);
    expect(ok.body.empCode).toBe(empCode);

    const no = await request(app).get('/api/hr/employees/99999999').set(hdr(hrUser));
    expect(no.status).toBe(404);
  });

  it('rejects a duplicate emp_code (409)', async () => {
    const dup = await request(app).post('/api/hr/employees').set(hdr(hrUser))
      .send({ empCode, fullName: 'Duplicate' });
    expect(dup.status).toBe(409);
  });

  it('updates an employee (200) then 409 on a stale row version', async () => {
    const upd = await request(app).patch(`/api/hr/employees/${createdId}`).set(hdr(hrUser))
      .send({ fullName: 'Renamed Employee', rowVersion: createdVersion });
    expect(upd.status).toBe(200);
    expect(upd.body.fullName).toBe('Renamed Employee');
    expect(upd.body.rowVersion).toBe(createdVersion + 1);

    const stale = await request(app).patch(`/api/hr/employees/${createdId}`).set(hdr(hrUser))
      .send({ fullName: 'Again', rowVersion: createdVersion });
    expect(stale.status).toBe(409);
    createdVersion = upd.body.rowVersion;
  });

  let leaveId: number;
  let leaveVersion: number;

  it('applies for leave (201) with a server-computed day count', async () => {
    const res = await request(app).post('/api/hr/leaves').set(hdr(hrUser)).send({
      employeeId: createdId, fromDate: '2026-06-01', toDate: '2026-06-03', leaveType: 'CL',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.days).toBe(3);
    leaveId = res.body.leaveId;
    leaveVersion = res.body.rowVersion;
  });

  it('rejects an invalid leave range (400): toDate before fromDate', async () => {
    const res = await request(app).post('/api/hr/leaves').set(hdr(hrUser))
      .send({ employeeId: createdId, fromDate: '2026-06-05', toDate: '2026-06-01' });
    expect(res.status).toBe(400);
  });

  it('lists leaves filtered by employee (200)', async () => {
    const res = await request(app).get(`/api/hr/leaves?employeeId=${createdId}&status=PENDING`).set(hdr(hrUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('denies apply-leave without LEAVE.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/hr/leaves').set(hdr(salesUser))
      .send({ employeeId: createdId, fromDate: '2026-06-01', toDate: '2026-06-01' });
    expect(res.status).toBe(403);
  });

  it('approves a PENDING leave (200) and records the leave.approved event', async () => {
    const res = await request(app).post(`/api/hr/leaves/${leaveId}/approve`).set(hdr(hrUser))
      .send({ rowVersion: leaveVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approverId).toBe(hrUser);

    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='LEAVE' AND aggregate_id=$1 AND event_type='leave.approved'`,
      [leaveId]);
    expect(evt.rowCount).toBe(1);
    expect(Number(evt.rows[0].payload.days)).toBe(3);
  });

  it('409 approving an already-approved leave', async () => {
    const res = await request(app).post(`/api/hr/leaves/${leaveId}/approve`).set(hdr(hrUser))
      .send({ rowVersion: 99 });
    expect(res.status).toBe(409);
  });

  it('returns the month attendance summary (200)', async () => {
    const res = await request(app).get('/api/hr/attendance?month=2026-06').set(hdr(hrUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // the approved 3-day leave should surface for our employee
    const mine = res.body.find((r: { employeeId: number }) => r.employeeId === createdId);
    expect(mine).toBeDefined();
    expect(mine.leaveDays).toBeGreaterThanOrEqual(3);
  });
});
