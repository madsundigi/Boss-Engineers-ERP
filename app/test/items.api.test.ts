import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { itemsRouter } from '../src/modules/items/items.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts itemsRouter at /api/items exactly as the composition root does
 * (createApp wires `app.use('/api/items', itemsRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC (db/08): STORES & PLANNING maintain the catalog (ITEM.VCE), ADMIN owns it
 * (ITEM.VCEDX — only ADMIN can DELETE); SALES is read-only (ITEM.V), so create is
 * 403. The category (RAW) and uom (NOS) are seeded by db/06 + app/test/seed.sql.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/items', itemsRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Items API (integration) — master-data CRUD, RBAC, optimistic concurrency', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let categoryId: number;
  let uomId: number;
  let storesUser: number;
  let adminUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with the unique item_code.
  const itemCode = `IT-${Date.now()}`;

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
    categoryId = Number((await one(`SELECT category_id FROM mdm.item_category WHERE cat_code='RAW'`)).category_id);
    uomId = Number((await one(`SELECT uom_id FROM mdm.uom WHERE uom_code='NOS'`)).uom_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    adminUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='admin_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates an item (201) as stores_user', async () => {
    const res = await request(app).post('/api/items').set(hdr(storesUser)).send({
      itemCode, itemName: 'Induction Coil Assembly', categoryId, type: 'RAW',
      baseUomId: uomId, reorderLevel: 10, isCritical: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.itemCode).toBe(itemCode);
    expect(res.body.type).toBe('RAW');
    expect(res.body.isCritical).toBe(true);
    expect(res.body.reorderLevel).toBe(10);
    createdId = res.body.itemId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without ITEM.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/items').set(hdr(salesUser)).send({
      itemCode: `${itemCode}-X`, itemName: 'Nope', categoryId, type: 'RAW', baseUomId: uomId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required fields', async () => {
    const res = await request(app).post('/api/items').set(hdr(storesUser))
      .send({ itemCode: `${itemCode}-Y`, itemName: 'Incomplete' });
    expect(res.status).toBe(400);
  });

  it('409 on a duplicate item_code', async () => {
    const res = await request(app).post('/api/items').set(hdr(storesUser)).send({
      itemCode, itemName: 'Duplicate', categoryId, type: 'RAW', baseUomId: uomId,
    });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('lists items (200, free-text q) and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/items?q=${itemCode}`).set(hdr(storesUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.rows.some((r: { itemCode: string }) => r.itemCode === itemCode)).toBe(true);

    const ok = await request(app).get(`/api/items/${createdId}`).set(hdr(storesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.itemCode).toBe(itemCode);

    const no = await request(app).get('/api/items/99999999').set(hdr(storesUser));
    expect(no.status).toBe(404);
  });

  it('updates under the current row version, then 409s on the stale one', async () => {
    const ok = await request(app).patch(`/api/items/${createdId}`).set(hdr(storesUser))
      .send({ itemName: 'Induction Coil Assembly v2', rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    expect(ok.body.itemName).toBe('Induction Coil Assembly v2');
    expect(ok.body.rowVersion).toBe(createdVersion + 1);

    // The original version is now stale -> optimistic-concurrency conflict.
    const stale = await request(app).patch(`/api/items/${createdId}`).set(hdr(storesUser))
      .send({ itemName: 'Induction Coil Assembly v3', rowVersion: createdVersion });
    expect(stale.status).toBe(409);

    createdVersion = ok.body.rowVersion;
  });

  it('denies delete without ITEM.DELETE (stores -> 403)', async () => {
    const res = await request(app).delete(`/api/items/${createdId}?rowVersion=${createdVersion}`)
      .set(hdr(storesUser));
    expect(res.status).toBe(403);
  });

  it('soft-deletes the item (204) as admin_user; it is then gone (404)', async () => {
    const del = await request(app).delete(`/api/items/${createdId}?rowVersion=${createdVersion}`)
      .set(hdr(adminUser));
    expect(del.status).toBe(204);

    const gone = await request(app).get(`/api/items/${createdId}`).set(hdr(storesUser));
    expect(gone.status).toBe(404);
  });
});
