import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * RBAC (db/08): PLANNING = VCEX (create/edit), FINANCE/CEO = VAX (approve),
 * STORES = V (view-only). So planning_user creates/edits, finance_user approves,
 * stores_user is denied create.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Project API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let storesUser: number;
  let financeUser: number;
  let customerId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  let createdId: number;
  let createdVersion: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = createApp(pool);
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=${companyId}`)).bu_id);
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    customerId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST'`)).customer_id);
  });

  afterAll(async () => { await pool.end(); });

  it('creates a project (201) with an auto-generated number', async () => {
    const res = await request(app).post('/api/projects').set(hdr(planningUser)).send({
      projectName: '2x 50T EOT Crane Package', customerId, pmUserId: planningUser,
      contractValue: 9500000, budgetCost: 8000000,
    });
    expect(res.status).toBe(201);
    expect(res.body.projectNo).toMatch(/^PRJ\//);
    expect(res.body.status).toBe('PLANNING');
    createdId = res.body.projectId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without PROJECT.CREATE (stores_user -> 403)', async () => {
    const res = await request(app).post('/api/projects').set(hdr(storesUser)).send({
      projectName: 'X', customerId, pmUserId: planningUser,
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing name / bad customerId', async () => {
    const r1 = await request(app).post('/api/projects').set(hdr(planningUser))
      .send({ customerId, pmUserId: planningUser });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/projects').set(hdr(planningUser))
      .send({ projectName: 'A', customerId: -1, pmUserId: planningUser });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  it('lists projects (200)', async () => {
    const res = await request(app).get('/api/projects?status=PLANNING').set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/projects/${createdId}`).set(hdr(planningUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectName).toBe('2x 50T EOT Crane Package');
    const no = await request(app).get('/api/projects/99999999').set(hdr(planningUser));
    expect(no.status).toBe(404);
  });

  it('edits a PLANNING project (200) under optimistic concurrency', async () => {
    const res = await request(app).patch(`/api/projects/${createdId}`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion, budgetCost: 8200000 });
    expect(res.status).toBe(200);
    expect(res.body.budgetCost).toBe(8200000);
    createdVersion = res.body.rowVersion;
  });

  it('blocks approval without PROJECT.APPROVE (planning -> 403), allows finance (charter sign-off)', async () => {
    const denied = await request(app).post(`/api/projects/${createdId}/approve`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(denied.status).toBe(403);
    const ok = await request(app).post(`/api/projects/${createdId}/approve`).set(hdr(financeUser))
      .send({ rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    createdVersion = ok.body.rowVersion;
  });

  it('transitions APPROVED -> ACTIVE and blocks an invalid jump', async () => {
    const ok = await request(app).post(`/api/projects/${createdId}/status`).set(hdr(planningUser))
      .send({ status: 'ACTIVE', rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    const bad = await request(app).post(`/api/projects/${createdId}/status`).set(hdr(planningUser))
      .send({ status: 'CLOSED', rowVersion: ok.body.rowVersion });
    expect(bad.status).toBe(409);
  });

  it('exports CSV (200) for PROJECT.EXPORT holders', async () => {
    const res = await request(app).get('/api/projects/export').set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Project No');
  });

  it('RLS isolates tenants even on an unfiltered query', async () => {
    // Under the erp_app role, an UNFILTERED scan still returns 0 rows for a
    // different company and >0 for the correct one — proving RLS is enforced.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE erp_app');
      await c.query(`SELECT set_config('app.company_id', '999999', true)`);
      const wrong = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM proj.project');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [String(companyId)]);
      const right = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM proj.project');
      await c.query('COMMIT');
      expect(wrong.rows[0].n).toBe(0);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      c.release();
    }
  });
});
