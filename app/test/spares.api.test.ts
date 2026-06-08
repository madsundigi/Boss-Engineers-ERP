import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { sparesRouter } from '../src/modules/spares/spares.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts sparesRouter at /api/spares exactly as the composition root does
 * (createApp wires `app.use('/api/spares', sparesRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC: SERVICE owns the catalog + stock (SPARE.VCEDAX), STORES maintains it
 * (SPARE.VCE); SALES has no SPARE grant at all, so create is 403.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/spares', sparesRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Spares API (integration) — catalog, per-location stock, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let serviceUser: number;
  let storesUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with uq_spare_part_code.
  const partCode = `SP-${Date.now()}`;

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
    serviceUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='service_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a spare (201) as service_user, active by default', async () => {
    const res = await request(app).post('/api/spares').set(hdr(serviceUser)).send({
      partCode, partName: 'Mechanical Seal Kit', uom: 'NOS', unitPrice: 1250.5, reorderLevel: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.partCode).toBe(partCode);
    expect(res.body.isActive).toBe(true);
    expect(res.body.unitPrice).toBe(1250.5);
    createdId = res.body.spareId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without SPARE.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/spares').set(hdr(salesUser))
      .send({ partCode: `${partCode}-X`, partName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing part name', async () => {
    const res = await request(app).post('/api/spares').set(hdr(serviceUser)).send({ partCode: `${partCode}-Y` });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/spares');
    expect(res.status).toBe(401);
  });

  it('lists spares (200) and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/spares?q=${partCode}`).set(hdr(serviceUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/spares/${createdId}`).set(hdr(serviceUser));
    expect(ok.status).toBe(200);
    expect(ok.body.partCode).toBe(partCode);
    expect(Array.isArray(ok.body.stock)).toBe(true);

    const no = await request(app).get('/api/spares/99999999').set(hdr(serviceUser));
    expect(no.status).toBe(404);
  });

  it('adjusts stock up as stores_user, then the balance is visible on the spare', async () => {
    const adj = await request(app).post(`/api/spares/${createdId}/stock`).set(hdr(storesUser))
      .send({ location: 'MAIN', delta: 20 });
    expect(adj.status).toBe(200);
    expect(adj.body.qtyOnHand).toBe(20);

    const stock = await request(app).get(`/api/spares/${createdId}/stock`).set(hdr(serviceUser));
    expect(stock.status).toBe(200);
    expect(stock.body.find((s: { location: string }) => s.location === 'MAIN').qtyOnHand).toBe(20);

    const full = await request(app).get(`/api/spares/${createdId}`).set(hdr(serviceUser));
    expect(full.body.stock.find((s: { location: string }) => s.location === 'MAIN').qtyOnHand).toBe(20);
  });

  it('blocks a stock adjustment that would go negative (400)', async () => {
    const res = await request(app).post(`/api/spares/${createdId}/stock`).set(hdr(storesUser))
      .send({ location: 'MAIN', delta: -1000 });
    expect(res.status).toBe(400);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // First edit bumps the row version, so the original is now stale.
    const ok = await request(app).patch(`/api/spares/${createdId}`).set(hdr(serviceUser))
      .send({ partName: 'Mechanical Seal Kit v2', rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    const stale = await request(app).patch(`/api/spares/${createdId}`).set(hdr(serviceUser))
      .send({ partName: 'Mechanical Seal Kit v3', rowVersion: createdVersion });
    expect(stale.status).toBe(409);
  });
});
