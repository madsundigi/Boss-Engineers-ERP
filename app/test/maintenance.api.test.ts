import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { maintenanceRouter } from '../src/modules/maintenance/maintenance.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts maintenanceRouter at /api/maintenance exactly as the composition
 * root does (createApp wires `app.use('/api/maintenance', maintenanceRouter(pool))`);
 * here we mount a minimal equivalent so the module is testable independently of
 * app.ts. Sub-resources live under /assets and /work-orders.
 *
 * RBAC: PRODUCTION runs the register + work orders (MAINTENANCE.VCEDA), STORES
 * maintains assets (MAINTENANCE.VCE); SALES has no MAINTENANCE grant at all, so
 * create is 403.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/maintenance', maintenanceRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Maintenance API (integration) — assets, work-order lifecycle, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let productionUser: number;
  let storesUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with uq_maint_asset_code.
  const assetCode = `AST-${Date.now()}`;

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
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let assetId: number;
  let assetVersion: number;
  let mwoId: number;
  let mwoVersion: number;

  // --- Asset register ---
  it('creates an asset (201) as production_user, ACTIVE by default', async () => {
    const res = await request(app).post('/api/maintenance/assets').set(hdr(productionUser)).send({
      assetCode, assetName: 'CNC Lathe', assetType: 'MACHINE', location: 'Shop A',
    });
    expect(res.status).toBe(201);
    expect(res.body.assetCode).toBe(assetCode);
    expect(res.body.status).toBe('ACTIVE');
    assetId = res.body.assetId;
    assetVersion = res.body.rowVersion;
  });

  it('denies create without MAINTENANCE.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/maintenance/assets').set(hdr(salesUser))
      .send({ assetCode: `${assetCode}-X`, assetName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing asset name', async () => {
    const res = await request(app).post('/api/maintenance/assets').set(hdr(productionUser))
      .send({ assetCode: `${assetCode}-Y` });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/maintenance/assets');
    expect(res.status).toBe(401);
  });

  it('lists assets (200) and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/maintenance/assets?q=${assetCode}`).set(hdr(productionUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/maintenance/assets/${assetId}`).set(hdr(productionUser));
    expect(ok.status).toBe(200);
    expect(ok.body.assetCode).toBe(assetCode);

    const no = await request(app).get('/api/maintenance/assets/99999999').set(hdr(productionUser));
    expect(no.status).toBe(404);
  });

  // --- Maintenance work order ---
  it('creates a work order (201) with an auto-generated MWO number, in OPEN', async () => {
    const res = await request(app).post('/api/maintenance/work-orders').set(hdr(productionUser)).send({
      assetId, woType: 'PREVENTIVE', scheduledDate: '2026-06-10', notes: 'quarterly service',
    });
    expect(res.status).toBe(201);
    expect(res.body.mwoNo).toMatch(/^MWO\//);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.assetId).toBe(assetId);
    mwoId = res.body.mwoId;
    mwoVersion = res.body.rowVersion;
  });

  it('rejects an invalid work order (400): bad wo_type', async () => {
    const res = await request(app).post('/api/maintenance/work-orders').set(hdr(productionUser))
      .send({ assetId, woType: 'NOPE' });
    expect(res.status).toBe(400);
  });

  it('fetches a work order (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/maintenance/work-orders/${mwoId}`).set(hdr(productionUser));
    expect(ok.status).toBe(200);
    expect(ok.body.woType).toBe('PREVENTIVE');
    const no = await request(app).get('/api/maintenance/work-orders/99999999').set(hdr(productionUser));
    expect(no.status).toBe(404);
  });

  it('starts the work order (OPEN -> IN_PROGRESS) and puts the asset UNDER_MAINTENANCE', async () => {
    const start = await request(app).post(`/api/maintenance/work-orders/${mwoId}/start`).set(hdr(productionUser))
      .send({ rowVersion: mwoVersion });
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('IN_PROGRESS');
    mwoVersion = start.body.rowVersion;

    const asset = await request(app).get(`/api/maintenance/assets/${assetId}`).set(hdr(productionUser));
    expect(asset.body.status).toBe('UNDER_MAINTENANCE');
  });

  it('completes the work order (IN_PROGRESS -> DONE): asset back to ACTIVE + outbox event', async () => {
    const done = await request(app).post(`/api/maintenance/work-orders/${mwoId}/complete`).set(hdr(productionUser))
      .send({ rowVersion: mwoVersion });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedDate).not.toBeNull();

    // the asset returns to service.
    const asset = await request(app).get(`/api/maintenance/assets/${assetId}`).set(hdr(productionUser));
    expect(asset.body.status).toBe('ACTIVE');

    // the completion recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='MAINTENANCE_WO' AND aggregate_id=$1 AND event_type='maintenance.completed'`,
      [mwoId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.mwoNo).toMatch(/^MWO\//);
    expect(evt.rows[0].payload.assetId).toBe(assetId);
  });

  it('lists work orders (200) filtered by asset and status', async () => {
    const res = await request(app).get(`/api/maintenance/work-orders?assetId=${assetId}&status=DONE`).set(hdr(productionUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // Raise a fresh WO, edit it once so the original version is now stale.
    const create = await request(app).post('/api/maintenance/work-orders').set(hdr(productionUser))
      .send({ assetId, woType: 'BREAKDOWN' });
    expect(create.status).toBe(201);
    const id = create.body.mwoId;
    const first = await request(app).patch(`/api/maintenance/work-orders/${id}`).set(hdr(productionUser))
      .send({ notes: 'investigating', rowVersion: create.body.rowVersion });
    expect(first.status).toBe(200);
    const stale = await request(app).patch(`/api/maintenance/work-orders/${id}`).set(hdr(productionUser))
      .send({ notes: 'still investigating', rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
