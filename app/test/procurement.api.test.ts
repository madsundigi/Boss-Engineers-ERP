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

    // ...and it rolled into the on-hand BALANCE (scm.item_stock), not just the ledger,
    // so the stock screen + material availability reflect the received goods.
    const bal = await pool.query<{ on_hand: string }>(
      `SELECT qty_on_hand AS on_hand FROM scm.item_stock
        WHERE company_id=$1 AND item_id=$2 AND warehouse_id=$3`, [companyId, itemId, warehouseId]);
    expect(bal.rowCount).toBeGreaterThan(0);
    expect(Number(bal.rows[0].on_hand)).toBeGreaterThanOrEqual(RECEIVE_QTY);
  });

  it('one-click receive: POST /purchase-orders/:poId/receive takes in ALL outstanding qty, second call 409s', async () => {
    const FULL_QTY = 9;

    // Buyer raises + CEO approves a fresh PO (independent lines from the other test).
    const createPo = await request(app).post('/api/procurement/purchase-orders').set(hdr(purchaseUser)).send({
      vendorId,
      lines: [{ itemId, qty: FULL_QTY, unitRate: UNIT_RATE }],
    });
    expect(createPo.status).toBe(201);
    const poId = createPo.body.poId as number;
    const poLineId = createPo.body.lines[0].poLineId as number;

    const approve = await request(app).post(`/api/procurement/purchase-orders/${poId}/approve`).set(hdr(ceoUser))
      .send({ rowVersion: createPo.body.rowVersion });
    expect(approve.status).toBe(200);

    // No warehouse in the body -> the GRN lands in the bu's default warehouse, which
    // defaultWarehouseForBu resolves as the first active warehouse by id (not
    // necessarily this suite's fixture — the inventory suite seeds a lower-id one).
    const defWh = Number((await pool.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM mdm.warehouse WHERE bu_id=$1 AND is_active ORDER BY warehouse_id LIMIT 1`,
      [buId],
    )).rows[0].warehouse_id);

    // Baselines: on-hand balance + GRN ledger count for the item BEFORE the receive.
    const balBefore = await pool.query<{ on_hand: string | null }>(
      `SELECT qty_on_hand AS on_hand FROM scm.item_stock
        WHERE company_id=$1 AND item_id=$2 AND warehouse_id=$3`, [companyId, itemId, defWh]);
    const onHandBefore = balBefore.rowCount ? Number(balBefore.rows[0].on_hand) : 0;
    const ledgerBefore = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scm.stock_transaction
        WHERE company_id=$1 AND item_id=$2 AND txn_type='GRN'`, [companyId, itemId]);

    // One click, NO body: warehouse defaults to the bu's first active warehouse.
    const recv = await request(app).post(`/api/procurement/purchase-orders/${poId}/receive`).set(hdr(storesUser)).send();
    expect(recv.status).toBe(201);
    expect(recv.body.status).toBe('POSTED');                 // same shape as a manual GRN create
    expect(recv.body.poId).toBe(poId);
    const grnId = recv.body.grnId as number;
    // The GRN received the FULL outstanding qty on the only line, in the default warehouse.
    expect(recv.body.lines).toHaveLength(1);
    expect(recv.body.lines[0].poLineId).toBe(poLineId);
    expect(Number(recv.body.lines[0].receivedQty)).toBe(FULL_QTY);
    expect(Number(recv.body.lines[0].warehouseId)).toBe(defWh);

    // Stock ledger: exactly one new positive 'GRN' row carrying the full qty + GRN ref.
    const ledgerAfter = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scm.stock_transaction
        WHERE company_id=$1 AND item_id=$2 AND txn_type='GRN'`, [companyId, itemId]);
    expect(ledgerAfter.rows[0].n).toBe(ledgerBefore.rows[0].n + 1);
    const txn = await pool.query(
      `SELECT qty, warehouse_id, ref_doc_id FROM scm.stock_transaction
        WHERE ref_doc_type='GRN' AND ref_doc_id=$1`, [grnId]);
    expect(txn.rowCount).toBe(1);
    expect(Number(txn.rows[0].qty)).toBe(FULL_QTY);
    expect(Number(txn.rows[0].warehouse_id)).toBe(defWh);

    // On-hand BALANCE rolled up by the full qty.
    const balAfter = await pool.query<{ on_hand: string }>(
      `SELECT qty_on_hand AS on_hand FROM scm.item_stock
        WHERE company_id=$1 AND item_id=$2 AND warehouse_id=$3`, [companyId, itemId, defWh]);
    expect(Number(balAfter.rows[0].on_hand)).toBe(onHandBefore + FULL_QTY);

    // po_line.received_qty now equals the ordered qty (line fully closed).
    const line = await pool.query<{ received_qty: string }>(
      `SELECT received_qty FROM scm.po_line WHERE po_line_id=$1`, [poLineId]);
    expect(Number(line.rows[0].received_qty)).toBe(FULL_QTY);

    // Second one-click: nothing left to receive -> 409.
    const again = await request(app).post(`/api/procurement/purchase-orders/${poId}/receive`).set(hdr(storesUser)).send();
    expect(again.status).toBe(409);
  });

  it('one-click receive denies without GRN.CREATE (403) as sales_user', async () => {
    const res = await request(app).post('/api/procurement/purchase-orders/1/receive').set(hdr(salesUser)).send();
    expect(res.status).toBe(403);
  });

  it('denies receiving a GRN without GRN.CREATE (403) as sales_user', async () => {
    // sales_user holds no GRN permission, so the receive is blocked at the guard.
    const res = await request(app).post('/api/procurement/grn').set(hdr(salesUser)).send({
      poId: 1, warehouseId, lines: [{ itemId, receivedQty: 1 }],
    });
    expect(res.status).toBe(403);
  });
});
