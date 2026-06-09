import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { workCentersRouter } from '../src/modules/workcenters/workcenters.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts workCentersRouter at /api/work-centers exactly as the composition
 * root does (createApp wires `app.use('/api/work-centers', workCentersRouter(pool))`);
 * here we mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC reuses the WORK_ORDER domain (no WORK_CENTER domain exists): PRODUCTION owns it
 * (WORK_ORDER.VCEDAX — full CRUD), PLANNING has VC (create but no delete -> 403 delete),
 * FINANCE has V only (view -> 403 create).
 *
 * mdm.work_center has no row_version / is_deleted, so there is no optimistic concurrency
 * and delete is a hard delete.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/work-centers', workCentersRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Work-Centres API (integration) — master CRUD, RBAC, BU tenant scoping', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let productionUser: number;
  let planningUser: number;
  let financeUser: number;

  // Unique per run so re-running the suite never collides with the UNIQUE wc_code.
  const wcCode = `WC-${Date.now()}`;

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
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;

  it('creates a work centre (201) as production_user, active by default', async () => {
    const res = await request(app).post('/api/work-centers').set(hdr(productionUser)).send({
      buId, wcCode, wcName: 'CNC Machining Bay', capacityPerDay: 16, costRate: 1450.75,
    });
    expect(res.status).toBe(201);
    expect(res.body.wcCode).toBe(wcCode);
    expect(res.body.buId).toBe(buId);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.isActive).toBe(true);
    expect(res.body.capacityPerDay).toBe(16);
    expect(res.body.costRate).toBe(1450.75);
    createdId = res.body.wcId;
  });

  it('denies create without WORK_ORDER.CREATE (finance -> 403)', async () => {
    const res = await request(app).post('/api/work-centers').set(hdr(financeUser))
      .send({ buId, wcCode: `${wcCode}-X`, wcName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing wc name', async () => {
    const res = await request(app).post('/api/work-centers').set(hdr(productionUser))
      .send({ buId, wcCode: `${wcCode}-Y` });
    expect(res.status).toBe(400);
  });

  it('rejects a BU outside the company (400)', async () => {
    const res = await request(app).post('/api/work-centers').set(hdr(productionUser))
      .send({ buId: 99999999, wcCode: `${wcCode}-Z`, wcName: 'Bad BU' });
    expect(res.status).toBe(400);
  });

  it('maps a duplicate wc_code to a 409 conflict', async () => {
    const res = await request(app).post('/api/work-centers').set(hdr(productionUser))
      .send({ buId, wcCode, wcName: 'Dup' });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/work-centers');
    expect(res.status).toBe(401);
  });

  it('lists work centres (200) with ?q + ?buId and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/work-centers?q=${wcCode}&buId=${buId}`).set(hdr(productionUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/work-centers/${createdId}`).set(hdr(productionUser));
    expect(ok.status).toBe(200);
    expect(ok.body.wcCode).toBe(wcCode);

    const no = await request(app).get('/api/work-centers/99999999').set(hdr(productionUser));
    expect(no.status).toBe(404);
  });

  it('updates a work centre (200) — no rowVersion required (table has none)', async () => {
    const res = await request(app).patch(`/api/work-centers/${createdId}`).set(hdr(productionUser))
      .send({ wcName: 'CNC Machining Bay v2', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.wcName).toBe('CNC Machining Bay v2');
    expect(res.body.isActive).toBe(false);
  });

  it('denies delete without WORK_ORDER.DELETE (planning -> 403)', async () => {
    const res = await request(app).delete(`/api/work-centers/${createdId}`).set(hdr(planningUser));
    expect(res.status).toBe(403);
  });

  it('hard-deletes as production_user (204), then the row is gone (404)', async () => {
    const del = await request(app).delete(`/api/work-centers/${createdId}`).set(hdr(productionUser));
    expect(del.status).toBe(204);

    const gone = await request(app).get(`/api/work-centers/${createdId}`).set(hdr(productionUser));
    expect(gone.status).toBe(404);
  });
});
