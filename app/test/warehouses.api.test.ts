import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { warehousesRouter } from '../src/modules/warehouses/warehouses.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard -> validation
 * -> service -> repository -> PostgreSQL) against a real database. Runs only when
 * DATABASE_URL is set so the suite is a no-op without a database.
 *
 * The app mounts warehousesRouter at /api/warehouses exactly as the composition root
 * does (createApp wires `app.use('/api/warehouses', warehousesRouter(pool))`).
 *
 * mdm.warehouse is minimal: no company_id (scoped via the parent business unit's
 * company), no row_version (no optimistic concurrency), no is_deleted (hard delete).
 *
 * RBAC: warehouses reuse the INVENTORY domain. STORES has full CRUD (INVENTORY.VCEDAX);
 * SALES has no INVENTORY grant at all (so create is 403).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/warehouses', warehousesRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Warehouses API (integration) — master CRUD, RBAC, bu-scoping', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let otherCompanyBuId: number | null;
  let storesUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with uq_wh (bu_id, wh_code).
  const whCode = `WH-${Date.now()}`.slice(0, 15);

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
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    // A bu owned by a DIFFERENT company, if one exists, to prove cross-tenant rejection.
    const other = await one(`SELECT bu_id FROM mdm.business_unit WHERE company_id <> $1 LIMIT 1`, [companyId]);
    otherCompanyBuId = other ? Number(other.bu_id) : null;
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;

  it('creates a warehouse (201) as stores_user, active by default', async () => {
    const res = await request(app).post('/api/warehouses').set(hdr(storesUser)).send({
      buId, whCode, whName: 'Raw Material Store',
    });
    expect(res.status).toBe(201);
    expect(res.body.whCode).toBe(whCode);
    expect(res.body.buId).toBe(buId);
    expect(res.body.isActive).toBe(true);
    expect(res.body.companyId).toBe(companyId);
    createdId = res.body.warehouseId;
  });

  it('denies create without INVENTORY.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/warehouses').set(hdr(salesUser))
      .send({ buId, whCode: `${whCode}X`.slice(0, 15), whName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing warehouse name', async () => {
    const res = await request(app).post('/api/warehouses').set(hdr(storesUser)).send({ buId, whCode: `${whCode}Y`.slice(0, 15) });
    expect(res.status).toBe(400);
  });

  it('404 when creating under a bu_id outside the caller company', async () => {
    if (otherCompanyBuId == null) return; // single-tenant DB: nothing to prove
    const res = await request(app).post('/api/warehouses').set(hdr(storesUser))
      .send({ buId: otherCompanyBuId, whCode: `${whCode}F`.slice(0, 15), whName: 'Foreign' });
    expect(res.status).toBe(404);
  });

  it('409 on a duplicate (bu_id, wh_code)', async () => {
    const res = await request(app).post('/api/warehouses').set(hdr(storesUser))
      .send({ buId, whCode, whName: 'Duplicate' });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/warehouses');
    expect(res.status).toBe(401);
  });

  it('lists warehouses (200, with bu filter) and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/warehouses?q=${whCode}&buId=${buId}`).set(hdr(storesUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/warehouses/${createdId}`).set(hdr(storesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.whCode).toBe(whCode);

    const no = await request(app).get('/api/warehouses/99999999').set(hdr(storesUser));
    expect(no.status).toBe(404);
  });

  it('updates mutable fields (200) — rename + deactivate, no rowVersion needed', async () => {
    const res = await request(app).patch(`/api/warehouses/${createdId}`).set(hdr(storesUser))
      .send({ whName: 'Raw Material Store (North)', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.whName).toBe('Raw Material Store (North)');
    expect(res.body.isActive).toBe(false);
  });

  it('rejects an empty update (400)', async () => {
    const res = await request(app).patch(`/api/warehouses/${createdId}`).set(hdr(storesUser)).send({});
    expect(res.status).toBe(400);
  });

  it('hard-deletes the warehouse (204), then it is gone (404)', async () => {
    const del = await request(app).delete(`/api/warehouses/${createdId}`).set(hdr(storesUser));
    expect(del.status).toBe(204);

    const gone = await request(app).get(`/api/warehouses/${createdId}`).set(hdr(storesUser));
    expect(gone.status).toBe(404);
  });
});
