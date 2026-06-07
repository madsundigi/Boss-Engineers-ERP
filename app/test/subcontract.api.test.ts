import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { subcontractRouter } from '../src/modules/subcontract/subcontract.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts subcontractRouter at /api/subcontracts exactly as the
 * composition root does; here we mount a minimal equivalent so the module is
 * testable independently of app.ts.
 *
 * Job-work lifecycle: PURCHASE owns the order (create -> issue -> receive ->
 * close, SUBCONTRACT.VCEDAX); SALES has no SUBCONTRACT permission (403). Receive
 * records a 'subcontract.received' transactional-outbox event.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/subcontracts', subcontractRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Subcontract API (integration) — create, issue, receive, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let purchaseUser: number;
  let storesUser: number;
  let salesUser: number;
  let vendorId: number;
  let projectId: number;
  let itemId: number;

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
    purchaseUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='purchase_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the order references. The test connects as the owning superuser,
    // so RLS does not filter these inserts. vendor_id is a NOT NULL FK; project_id
    // is optional but exercised here (a pm_user_id is required to insert a project).
    vendorId = Number((await one(
      `SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST' AND company_id=$1`, [companyId])).vendor_id);
    itemId = Number((await one(
      `SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST' AND company_id=$1`, [companyId])).item_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       SELECT $1, 'PRJ-SC-TEST', 'Subcontract Test Project', c.customer_id, $2, 'ACTIVE'
       FROM mdm.customer c WHERE c.customer_code='CUST-TEST' AND c.company_id=$1
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, purchaseUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a subcontract order (201) with an auto SC number, in OPEN', async () => {
    const res = await request(app).post('/api/subcontracts').set(hdr(purchaseUser)).send({
      vendorId, projectId,
    });
    expect(res.status).toBe(201);
    expect(res.body.scoNo).toMatch(/^SC\//);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.vendorId).toBe(vendorId);
    expect(res.body.issues).toEqual([]);
    expect(res.body.receipts).toEqual([]);
    createdId = res.body.scoId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without SUBCONTRACT.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/subcontracts').set(hdr(salesUser)).send({ vendorId, projectId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing vendorId / bad date', async () => {
    const r1 = await request(app).post('/api/subcontracts').set(hdr(purchaseUser)).send({ projectId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/subcontracts').set(hdr(purchaseUser))
      .send({ vendorId, scoDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/subcontracts');
    expect(res.status).toBe(401);
  });

  it('lists orders (200) and fetches one (200) / 404s an unknown id', async () => {
    const list = await request(app).get('/api/subcontracts?status=OPEN').set(hdr(purchaseUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/subcontracts/${createdId}`).set(hdr(purchaseUser));
    expect(ok.status).toBe(200);
    expect(ok.body.vendorId).toBe(vendorId);
    const no = await request(app).get('/api/subcontracts/99999999').set(hdr(purchaseUser));
    expect(no.status).toBe(404);
  });

  it('issues material then receives goods (happy path) and emits subcontract.received', async () => {
    const issue = await request(app).post(`/api/subcontracts/${createdId}/issue`).set(hdr(purchaseUser))
      .send({ items: [{ itemId, qty: 5 }], rowVersion: createdVersion });
    expect(issue.status).toBe(200);
    expect(issue.body.status).toBe('ISSUED');
    expect(issue.body.issues.length).toBe(1);
    expect(issue.body.issues[0].qty).toBe(5);

    const recv = await request(app).post(`/api/subcontracts/${createdId}/receive`).set(hdr(purchaseUser))
      .send({ items: [{ itemId, qty: 5 }], rowVersion: issue.body.rowVersion });
    expect(recv.status).toBe(200);
    expect(recv.body.status).toBe('RECEIVED');
    expect(recv.body.receipts.length).toBe(1);

    // the receive recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='SUBCONTRACT' AND aggregate_id=$1 AND event_type='subcontract.received'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.scNo).toMatch(/^SC\//);
    expect(Number(evt.rows[0].payload.vendorId)).toBe(vendorId);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/subcontracts').set(hdr(purchaseUser)).send({ vendorId });
    expect(create.status).toBe(201);
    const id = create.body.scoId;
    // issue once so the original version is now stale
    const first = await request(app).post(`/api/subcontracts/${id}/issue`).set(hdr(purchaseUser))
      .send({ items: [{ itemId, qty: 1 }], rowVersion: create.body.rowVersion });
    expect(first.status).toBe(200);
    const stale = await request(app).post(`/api/subcontracts/${id}/receive`).set(hdr(purchaseUser))
      .send({ items: [{ itemId, qty: 1 }], rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
