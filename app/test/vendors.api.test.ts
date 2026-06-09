import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { vendorsRouter } from '../src/modules/vendors/vendors.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard -> validation
 * -> service -> repository -> PostgreSQL) against a real database. Runs only when
 * DATABASE_URL is set so the suite is a no-op without a database.
 *
 * The app mounts vendorsRouter at /api/vendors exactly as the composition root does
 * (createApp wires `app.use('/api/vendors', vendorsRouter(pool))`).
 *
 * RBAC: PURCHASE owns onboarding (VENDOR.VCEX — view/create/edit/export, NO delete),
 * ADMIN has full CRUD (VCEDX), SALES has no VENDOR grant at all (so create is 403).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/vendors', vendorsRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Vendors API (integration) — master CRUD, RBAC, optimistic concurrency', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let purchaseUser: number;
  let adminUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with the UNIQUE vendor_code.
  const vendorCode = `V-${Date.now()}`;

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
    adminUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='admin_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a vendor (201) as purchase_user, ACTIVE + unapproved by default', async () => {
    const res = await request(app).post('/api/vendors').set(hdr(purchaseUser)).send({
      vendorCode, vendorName: 'Precision Castings Pvt Ltd', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F',
    });
    expect(res.status).toBe(201);
    expect(res.body.vendorCode).toBe(vendorCode);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.isApproved).toBe(false);
    createdId = res.body.vendorId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without VENDOR.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/vendors').set(hdr(salesUser))
      .send({ vendorCode: `${vendorCode}-X`, vendorName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing vendor name', async () => {
    const res = await request(app).post('/api/vendors').set(hdr(purchaseUser)).send({ vendorCode: `${vendorCode}-Y` });
    expect(res.status).toBe(400);
  });

  it('rejects a bad status enum (400)', async () => {
    const res = await request(app).post('/api/vendors').set(hdr(purchaseUser))
      .send({ vendorCode: `${vendorCode}-Z`, vendorName: 'Bad Status', status: 'BLOCKED' });
    expect(res.status).toBe(400);
  });

  it('409 on a duplicate vendor_code', async () => {
    const res = await request(app).post('/api/vendors').set(hdr(purchaseUser))
      .send({ vendorCode, vendorName: 'Duplicate' });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/vendors');
    expect(res.status).toBe(401);
  });

  it('lists vendors (200) and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/vendors?q=${vendorCode}`).set(hdr(purchaseUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/vendors/${createdId}`).set(hdr(purchaseUser));
    expect(ok.status).toBe(200);
    expect(ok.body.vendorCode).toBe(vendorCode);

    const no = await request(app).get('/api/vendors/99999999').set(hdr(purchaseUser));
    expect(no.status).toBe(404);
  });

  it('updates and approves a vendor (200), bumping the row version', async () => {
    const res = await request(app).patch(`/api/vendors/${createdId}`).set(hdr(purchaseUser))
      .send({ isApproved: true, rating: 4.5, rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.isApproved).toBe(true);
    expect(Number(res.body.rating)).toBe(4.5);
    expect(res.body.rowVersion).toBe(createdVersion + 1);
    createdVersion = res.body.rowVersion;
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const stale = await request(app).patch(`/api/vendors/${createdId}`).set(hdr(purchaseUser))
      .send({ vendorName: 'Renamed Again', rowVersion: createdVersion - 1 });
    expect(stale.status).toBe(409);
  });

  it('denies delete without VENDOR.DELETE (purchase -> 403), allows ADMIN (204)', async () => {
    const denied = await request(app).delete(`/api/vendors/${createdId}?rowVersion=${createdVersion}`).set(hdr(purchaseUser));
    expect(denied.status).toBe(403);

    const ok = await request(app).delete(`/api/vendors/${createdId}?rowVersion=${createdVersion}`).set(hdr(adminUser));
    expect(ok.status).toBe(204);

    // Soft-deleted: now invisible to reads.
    const gone = await request(app).get(`/api/vendors/${createdId}`).set(hdr(purchaseUser));
    expect(gone.status).toBe(404);
  });
});
