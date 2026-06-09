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
 * Focus: Procurement feeds Inventory. Receiving a GRN against a PO must append a
 * positive 'GRN' row to the immutable scm.stock_transaction ledger per line, so
 * on-hand stock goes up. The flow respects RBAC + Segregation of Duties using the
 * seeded role users (test/seed.sql):
 *   - purchase_user (PURCHASE) raises the PO            — PURCHASE_ORDER.CREATE
 *   - ceo_user      (CEO)      approves it (not creator)— PURCHASE_ORDER.APPROVE
 *   - stores_user   (STORES)   receives the GRN         — GRN.CREATE
 * Fixtures the base seed lacks (a warehouse for the MUM bu) are created here via
 * the owning superuser connection (bypasses RLS).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Procurement API (integration) — GRN posts inventory stock', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let purchaseUser: number;
  let ceoUser: number;
  let storesUser: number;
  let salesUser: number;
  let vendorId: number;
  let itemId: number;
  let warehouseId: number;

  const UNIT_RATE = 500;
  const RECEIVE_QTY = 7;

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
    purchaseUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='purchase_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    vendorId = Number((await one(`SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST'`)).vendor_id);
    itemId = Number((await one(`SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST'`)).item_id);

    // Warehouse fixture (scoped to the MUM business unit) — the GRN's receive
    // location. defaultWarehouseForBu picks this when no warehouseId is supplied.
    warehouseId = Number((await one(
      `INSERT INTO mdm.warehouse (bu_id, wh_code, wh_name)
       VALUES ($1, 'WH-PROCTEST', 'Procurement Test Warehouse')
       ON CONFLICT (bu_id, wh_code) DO UPDATE SET wh_name = EXCLUDED.wh_name
       RETURNING warehouse_id`,
      [buId],
    )).warehouse_id);
  });

  afterAll(async () => { await pool.end(); });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).post('/api/procurement/grn').send({});
    expect(res.status).toBe(401);
  });

  it('PO -> approve -> GRN appends a positive GRN stock_transaction per received line', async () => {
    // 1) Buyer raises a DRAFT PO on the approved test vendor.
    const createPo = await request(app).post('/api/procurement/purchase-orders').set(hdr(purchaseUser)).send({
      vendorId,
      lines: [{ itemId, qty: 10, unitRate: UNIT_RATE }],
    });
    expect(createPo.status).toBe(201);
    const poId = createPo.body.poId as number;
    const poLineId = createPo.body.lines[0].poLineId as number;

    // 2) CEO approves it (creator != approver -> SoD passes).
    const approve = await request(app).post(`/api/procurement/purchase-orders/${poId}/approve`).set(hdr(ceoUser))
      .send({ rowVersion: createPo.body.rowVersion });
    expect(approve.status).toBe(200);
    expect(approve.body.purchaseOrder.status).toBe('APPROVED');

    // Baseline ledger count for this GRN ref (should be exactly what we post).
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scm.stock_transaction
        WHERE company_id=$1 AND item_id=$2 AND txn_type='GRN'`, [companyId, itemId]);

    // 3) Stores receives part of the PO against the warehouse fixture.
    const grn = await request(app).post('/api/procurement/grn').set(hdr(storesUser)).send({
      poId,
      warehouseId,
      lines: [{ poLineId, itemId, receivedQty: RECEIVE_QTY }],
    });
    expect(grn.status).toBe(201);
    expect(grn.body.status).toBe('POSTED');
    const grnId = grn.body.grnId as number;

    // The receipt appended exactly one new GRN ledger row for the item.
    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scm.stock_transaction
        WHERE company_id=$1 AND item_id=$2 AND txn_type='GRN'`, [companyId, itemId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);

    // The posted row carries the right signed qty, warehouse, cost and GRN ref.
    const txn = await pool.query(
      `SELECT txn_type, qty, unit_cost, warehouse_id, ref_doc_type, ref_doc_id, created_by
         FROM scm.stock_transaction
        WHERE ref_doc_type='GRN' AND ref_doc_id=$1`, [grnId]);
    expect(txn.rowCount).toBe(1);
    const row = txn.rows[0];
    expect(row.txn_type).toBe('GRN');
    expect(Number(row.qty)).toBe(RECEIVE_QTY);          // positive — stock increases
    expect(Number(row.unit_cost)).toBe(UNIT_RATE);       // from the PO line
    expect(Number(row.warehouse_id)).toBe(warehouseId);  // GRN warehouse
    expect(Number(row.ref_doc_id)).toBe(grnId);          // ties back to the GRN
    expect(Number(row.created_by)).toBe(storesUser);
  });

  it('denies receiving a GRN without GRN.CREATE (403) as sales_user', async () => {
    // sales_user holds no GRN permission, so the receive is blocked at the guard.
    const res = await request(app).post('/api/procurement/grn').set(hdr(salesUser)).send({
      poId: 1, warehouseId, lines: [{ itemId, receivedQty: 1 }],
    });
    expect(res.status).toBe(403);
  });
});
