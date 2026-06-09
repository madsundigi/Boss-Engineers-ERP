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
 * Acts as 'stores_user' (STORES role holds INVENTORY VCEDAX) for the happy paths,
 * and 'sales_user' (no INVENTORY permission) to prove the RBAC deny. Fixtures the
 * suite needs but the base seed lacks (a warehouse + a project + an on-hand stock
 * balance) are created here via the owning superuser connection (bypasses RLS).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Inventory API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let storesUser: number;
  let salesUser: number;
  let itemId: number;
  let warehouseId: number;
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
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    itemId = Number((await one(`SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST'`)).item_id);

    // Set known Minimum + Reorder levels on the test item so the stock projection
    // can assert both surface (mdm.item is master data; no API to set them here).
    await pool.query(
      `UPDATE mdm.item SET min_level = 5, reorder_level = 20 WHERE item_id = $1`,
      [itemId],
    );

    // Warehouse fixture (scoped to the MUM business unit).
    warehouseId = Number((await one(
      `INSERT INTO mdm.warehouse (bu_id, wh_code, wh_name)
       VALUES ($1, 'WH-INVTEST', 'Inventory Test Warehouse')
       ON CONFLICT (bu_id, wh_code) DO UPDATE SET wh_name = EXCLUDED.wh_name
       RETURNING warehouse_id`,
      [buId],
    )).warehouse_id);

    // Project fixture (needs a customer + a PM user).
    const custId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST'`)).customer_id);
    projectId = Number((await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PROJ-INVTEST', 'Inventory Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`,
      [companyId, custId, storesUser],
    )).project_id);

    // Seed an on-hand free-stock balance (project_id NULL) so reserve/issue have stock.
    // UPDATE-then-INSERT keeps this idempotent across re-runs without relying on the
    // base unique index matching NULL bin/batch/project (NULLs are DISTINCT there).
    const seed = await pool.query(
      `UPDATE scm.item_stock SET qty_on_hand = 100, qty_reserved = 0, company_id = $1
        WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3
          AND project_id IS NULL AND bin_id IS NULL AND batch_id IS NULL`,
      [companyId, itemId, warehouseId],
    );
    if (!seed.rowCount) {
      await pool.query(
        `INSERT INTO scm.item_stock (company_id, item_id, warehouse_id, project_id, qty_on_hand, qty_reserved, avg_cost)
         VALUES ($1, $2, $3, NULL, 100, 0, 100)`,
        [companyId, itemId, warehouseId],
      );
    }
  });

  afterAll(async () => { await pool.end(); });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/inventory/stock');
    expect(res.status).toBe(401);
  });

  it('lists stock (200) with free vs reserved', async () => {
    const res = await request(app).get(`/api/inventory/stock?itemId=${itemId}&warehouseId=${warehouseId}`).set(hdr(storesUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const row = res.body.rows.find((r: { itemId: number }) => r.itemId === itemId);
    expect(row).toBeDefined();
    expect(row.qtyAvailable).toBe(row.qtyOnHand - row.qtyReserved);
    // Minimum Level + Reorder Level surface from mdm.item on the stock screen.
    expect(row.minLevel).toBe(5);
    expect(row.reorderLevel).toBe(20);
  });

  it('denies stock list without INVENTORY.VIEW (403) as sales_user', async () => {
    const res = await request(app).get('/api/inventory/stock').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('rejects an invalid adjustment body (400): missing item / bad qty', async () => {
    const r1 = await request(app).post('/api/inventory/adjustments').set(hdr(storesUser))
      .send({ warehouseId, qty: 5 }); // missing itemId
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/inventory/adjustments').set(hdr(storesUser))
      .send({ itemId, warehouseId, qty: -3 }); // qty must be > 0
    expect(r2.status).toBe(400);
  });

  it('creates a stock receipt adjustment (201) and posts it via /approve', async () => {
    const create = await request(app).post('/api/inventory/adjustments').set(hdr(storesUser)).send({
      itemId, warehouseId, adjType: 'RECEIPT', qty: 25, unitCost: 100, reason: 'Opening receipt',
    });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('DRAFT');
    const adjId = create.body.adjId;
    const ver = create.body.rowVersion;

    const approve = await request(app).post(`/api/inventory/adjustments/${adjId}/approve`).set(hdr(storesUser))
      .send({ rowVersion: ver });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('POSTED');

    // a stale row-version re-approve now conflicts (409)
    const again = await request(app).post(`/api/inventory/adjustments/${adjId}/approve`).set(hdr(storesUser))
      .send({ rowVersion: ver });
    expect(again.status).toBe(409);
  });

  it('reserves stock against a project (201)', async () => {
    const res = await request(app).post('/api/inventory/reservations').set(hdr(storesUser)).send({
      projectId, itemId, warehouseId, qty: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.reservationId).toBeGreaterThan(0);
    expect(res.body.projectId).toBe(projectId);
  });

  it('issues stock to a project (201) and blocks an over-issue (409)', async () => {
    const ok = await request(app).post('/api/inventory/issues').set(hdr(storesUser)).send({
      projectId, itemId, warehouseId, qty: 10, unitCost: 100,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.issueNo).toMatch(/^MI-/);

    const over = await request(app).post('/api/inventory/issues').set(hdr(storesUser)).send({
      projectId, itemId, warehouseId, qty: 999999, unitCost: 100,
    });
    expect(over.status).toBe(409);
  });

  it('denies issuing without INVENTORY.CREATE (403) as sales_user', async () => {
    const res = await request(app).post('/api/inventory/issues').set(hdr(salesUser)).send({
      projectId, itemId, warehouseId, qty: 1,
    });
    expect(res.status).toBe(403);
  });

  it('lists the critical-item register (200)', async () => {
    const res = await request(app).get('/api/inventory/critical-items').set(hdr(storesUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('RLS isolates stock from another company even on an unfiltered scan (BUG-01 pattern)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE erp_app');
      await c.query(`SELECT set_config('app.company_id', '999999', true)`);
      const wrong = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM scm.item_stock');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [String(companyId)]);
      const right = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM scm.item_stock');
      await c.query('COMMIT');
      expect(wrong.rows[0].n).toBe(0);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      c.release();
    }
  });
});
