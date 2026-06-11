import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';
import { ProductionRepository } from '../src/modules/production/production.repository';
import { RequestContext } from '../src/common/request-context';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * Focus: "Machine Completion -> Serial No. Creation". When a work order is
 * COMPLETED, one serial per produced unit must be created in scm.serial_number
 * (status WIP), linked to the WO via mfg.as_built and pegged to the WO's project.
 * The whole lifecycle runs as production_user (PRODUCTION role -> WORK_ORDER
 * VCEDAX). Project/item fixtures the base seed lacks are created via the owning
 * superuser connection (bypasses RLS).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Production API (integration) — completion creates a serial per produced unit', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let productionUser: number;
  let itemId: number;
  let projectId: number;
  let customerId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  // Drive create -> release -> confirm -> complete and return the completed body.
  async function runWo(qty: number): Promise<{ woId: number; woNo: string; rowVersion: number }> {
    const create = await request(app).post('/api/work-orders').set(hdr(productionUser)).send({
      projectId, itemId, qty,
      operations: [{ opSeq: 1, workCenterId, stdTimeMin: 60 }],
    });
    expect(create.status).toBe(201);
    const woId = create.body.woId as number;
    const woOpId = create.body.operations[0].woOpId as number;

    const rel = await request(app).post(`/api/work-orders/${woId}/release`).set(hdr(productionUser))
      .send({ materialReady: true, rowVersion: create.body.rowVersion });
    expect(rel.status).toBe(200);

    const conf = await request(app).post(`/api/work-orders/${woId}/confirm`).set(hdr(productionUser))
      .send({ woOpId, producedQty: qty, actualHours: 1, operationDone: true, rowVersion: rel.body.rowVersion });
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('IN_PROGRESS');

    const done = await request(app).post(`/api/work-orders/${woId}/complete`).set(hdr(productionUser))
      .send({ rowVersion: conf.body.rowVersion });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    return { woId, woNo: done.body.woNo as string, rowVersion: done.body.rowVersion as number };
  }

  let workCenterId: number;
  // Auto-fill fixtures: a RELEASED BOM (2 component lines) + an active routing
  // (2 operations), both on the WO's finished-goods item, so a WO created with just
  // bomId / routingId can explode / load them.
  let bomId: number;
  let compItemId1: number;
  let compItemId2: number;
  let routingId: number;
  let routingWc1: number;
  let routingWc2: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = createApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    itemId = Number((await one(`SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST'`)).item_id);
    customerId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    // Project fixture (work_order.project_id is a NOT NULL FK, not in the base seed).
    projectId = Number((await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-WO-TEST', 'Work Order Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, productionUser])).project_id);

    // A work centre for the routing operation (confirm requires an operation).
    workCenterId = Number((await one(
      `INSERT INTO mdm.work_center (bu_id, wc_code, wc_name)
       VALUES ($1, 'WC-WOTEST', 'WO Test Work Center')
       ON CONFLICT (wc_code) DO UPDATE SET wc_name = EXCLUDED.wc_name
       RETURNING wc_id`, [buId])).wc_id);

    // ---- BOM auto-fill fixture --------------------------------------------------
    // Two distinct component items (reuse the seeded NOS uom + RAW category). The
    // test connects as the owning superuser, so RLS does not filter these inserts.
    const uomId = Number((await one(`SELECT uom_id FROM mdm.uom WHERE uom_code='NOS'`)).uom_id);
    const mkComp = async (code: string) => Number((await one(
      `INSERT INTO mdm.item (company_id, item_code, item_name, item_category_id, item_type, base_uom_id, std_cost)
       SELECT $1, $2, $2, cat.category_id, 'RAW', $3, 10
       FROM mdm.item_category cat WHERE cat.cat_code='RAW'
       ON CONFLICT (item_code) DO UPDATE SET item_name = EXCLUDED.item_name
       RETURNING item_id`, [companyId, code, uomId])).item_id);
    compItemId1 = await mkComp('COMP-WO-AF-1');
    compItemId2 = await mkComp('COMP-WO-AF-2');

    // A RELEASED BOM whose parent is the WO's finished item. qty_per 2 (no scrap)
    // and 3 with 10% scrap so the explode exercises the scrap factor.
    bomId = Number((await one(
      `INSERT INTO mdm.bom_header
         (company_id, bu_id, bom_no, parent_item_id, bom_type, revision, status)
       VALUES ($1, $2, $4, $3, 'MBOM', 'WOAUTO', 'RELEASED')
       ON CONFLICT (parent_item_id, bom_type, revision)
         DO UPDATE SET status = 'RELEASED'
       RETURNING bom_id`, [companyId, buId, itemId, `BOM-WO-AF-${companyId}`])).bom_id);
    await pool.query(`DELETE FROM mdm.bom_line WHERE bom_id = $1`, [bomId]);
    await pool.query(
      `INSERT INTO mdm.bom_line (bom_id, component_item_id, qty_per, uom_id, scrap_pct)
       VALUES ($1, $2, 2, $4, 0), ($1, $3, 3, $4, 10)`,
      [bomId, compItemId1, compItemId2, uomId]);

    // ---- Routing auto-fill fixture ---------------------------------------------
    routingWc1 = workCenterId;
    routingWc2 = Number((await one(
      `INSERT INTO mdm.work_center (bu_id, wc_code, wc_name)
       VALUES ($1, 'WC-WOTEST-2', 'WO Test Work Center 2')
       ON CONFLICT (wc_code) DO UPDATE SET wc_name = EXCLUDED.wc_name
       RETURNING wc_id`, [buId])).wc_id);
    routingId = Number((await one(
      `INSERT INTO mdm.routing (item_id, revision, is_active)
       VALUES ($1, 'WO-AF', true)
       ON CONFLICT (item_id, revision) DO UPDATE SET is_active = true
       RETURNING routing_id`, [itemId])).routing_id);
    await pool.query(`DELETE FROM mdm.routing_operation WHERE routing_id = $1`, [routingId]);
    await pool.query(
      `INSERT INTO mdm.routing_operation (routing_id, op_seq, work_center_id, std_time_min)
       VALUES ($1, 10, $2, 45), ($1, 20, $3, 90)`,
      [routingId, routingWc1, routingWc2]);
  });

  afterAll(async () => { await pool.end(); });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).post('/api/work-orders').send({});
    expect(res.status).toBe(401);
  });

  it('completing a WO with qty=N creates N WIP serials for the item+project, linked via as_built', async () => {
    const N = 3;
    const { woId, woNo } = await runWo(N);

    // N serials exist, one per unit, pegged to the WO's item + project, status WIP.
    const serials = await pool.query(
      `SELECT s.serial_no, s.status, s.project_id, s.item_id
         FROM scm.serial_number s
         JOIN mfg.as_built a ON a.serial_id = s.serial_id
        WHERE a.wo_id = $1 ORDER BY s.serial_no`, [woId]);
    expect(serials.rowCount).toBe(N);
    for (const row of serials.rows) {
      expect(row.status).toBe('WIP');
      expect(Number(row.project_id)).toBe(projectId);
      expect(Number(row.item_id)).toBe(itemId);
      expect(String(row.serial_no).startsWith(woNo)).toBe(true);
    }
    // serial_no format: ${wo_no}-NNN, 1-based zero-padded.
    expect(serials.rows.map((r) => r.serial_no)).toEqual([
      `${woNo}-001`, `${woNo}-002`, `${woNo}-003`,
    ]);

    // the completion emitted a workorder.completed outbox event carrying the count.
    const evt = await pool.query(
      `SELECT payload FROM mdm.outbox_event
        WHERE aggregate_type='WORK_ORDER' AND aggregate_id=$1 AND event_type='workorder.completed'`,
      [woId]);
    expect(evt.rowCount).toBe(1);
    expect(Number(evt.rows[0].payload.serials)).toBe(N);
  });

  it('is idempotent — re-running completion does not create duplicate serials', async () => {
    const N = 2;
    const { woId, woNo, rowVersion } = await runWo(N);

    const countSerials = async () => Number((await pool.query(
      `SELECT count(*)::text c FROM mfg.as_built WHERE wo_id = $1`, [woId])).rows[0].c);
    expect(await countSerials()).toBe(N);

    // Re-invoke the repository complete() directly on the already-COMPLETED WO
    // (simulating a retry of the completion body). The as_built idempotency guard
    // must short-circuit serial creation: still exactly N, no duplicates.
    const repo = new ProductionRepository(pool);
    const ctx: RequestContext = {
      userId: productionUser, username: 'production_user', companyId, buId,
      clientIp: '127.0.0.1', sessionId: 'idem-test', permissions: new Set(),
    };
    const asBuilt = [
      { serialNo: `${woNo}-001` }, { serialNo: `${woNo}-002` },
    ];
    const again = await repo.complete(ctx, woId, rowVersion, itemId, projectId, asBuilt);
    expect(again).not.toBeNull();
    expect(again!.status).toBe('COMPLETED');

    expect(await countSerials()).toBe(N); // unchanged — no double-create
  });

  it('honours an explicit as-built list (serial genealogy) over auto-generation', async () => {
    // Build a WO to IN_PROGRESS, then complete with a caller-supplied serial.
    const create = await request(app).post('/api/work-orders').set(hdr(productionUser)).send({
      projectId, itemId, qty: 1,
      operations: [{ opSeq: 1, workCenterId, stdTimeMin: 30 }],
    });
    const woId = create.body.woId as number;
    const woOpId = create.body.operations[0].woOpId as number;
    const rel = await request(app).post(`/api/work-orders/${woId}/release`).set(hdr(productionUser))
      .send({ materialReady: true, rowVersion: create.body.rowVersion });
    const conf = await request(app).post(`/api/work-orders/${woId}/confirm`).set(hdr(productionUser))
      .send({ woOpId, producedQty: 1, actualHours: 1, operationDone: true, rowVersion: rel.body.rowVersion });

    const explicit = `MACHINE-SN-${woId}`;
    const done = await request(app).post(`/api/work-orders/${woId}/complete`).set(hdr(productionUser))
      .send({ rowVersion: conf.body.rowVersion, asBuilt: [{ serialNo: explicit }] });
    expect(done.status).toBe(200);

    const serials = await pool.query(
      `SELECT s.serial_no FROM scm.serial_number s
         JOIN mfg.as_built a ON a.serial_id = s.serial_id
        WHERE a.wo_id = $1`, [woId]);
    expect(serials.rows.map((r) => r.serial_no)).toEqual([explicit]);
  });

  // ---- BOM / routing auto-fill on create -------------------------------------
  it('auto-explodes the BOM into materials when bomId is given but no materials', async () => {
    const qty = 4;
    const res = await request(app).post('/api/work-orders').set(hdr(productionUser))
      .send({ projectId, itemId, qty, bomId }); // no materials, no operations
    expect(res.status).toBe(201);

    // requiredQty = qty_per * qty * (1 + scrap_pct/100):
    //   comp1: 2 * 4 * 1.00 = 8 ; comp2: 3 * 4 * 1.10 = 13.2
    const mats = (res.body.materials as { itemId: number; requiredQty: number }[])
      .slice().sort((a, b) => a.itemId - b.itemId);
    expect(mats).toEqual([
      { woMatId: expect.any(Number), itemId: compItemId1, requiredQty: 8, issuedQty: 0 },
      { woMatId: expect.any(Number), itemId: compItemId2, requiredQty: 13.2, issuedQty: 0 },
    ]);
    // bom_id is persisted on the header; operations stay empty (no routingId given).
    expect(res.body.bomId).toBe(bomId);
    expect(res.body.operations).toEqual([]);
  });

  it('auto-loads the routing operations when routingId is given but no operations', async () => {
    const res = await request(app).post('/api/work-orders').set(hdr(productionUser))
      .send({ projectId, itemId, qty: 2, routingId }); // no operations, no materials
    expect(res.status).toBe(201);

    const ops = (res.body.operations as { opSeq: number; workCenterId: number; stdTimeMin: number }[])
      .map((o) => ({ opSeq: o.opSeq, workCenterId: o.workCenterId, stdTimeMin: o.stdTimeMin }));
    expect(ops).toEqual([
      { opSeq: 10, workCenterId: routingWc1, stdTimeMin: 45 },
      { opSeq: 20, workCenterId: routingWc2, stdTimeMin: 90 },
    ]);
    expect(res.body.routingId).toBe(routingId);
    expect(res.body.materials).toEqual([]); // no bomId -> no material auto-fill
  });

  it('honours explicit materials over the BOM (explicit wins, no auto-explode)', async () => {
    const res = await request(app).post('/api/work-orders').set(hdr(productionUser)).send({
      projectId, itemId, qty: 4, bomId, // bomId present, but materials supplied:
      materials: [{ itemId: compItemId1, requiredQty: 1 }],
    });
    expect(res.status).toBe(201);
    const mats = res.body.materials as { itemId: number; requiredQty: number }[];
    expect(mats).toHaveLength(1);
    expect(mats[0]).toMatchObject({ itemId: compItemId1, requiredQty: 1 });
  });

  it('does not auto-fill from a non-RELEASED BOM (falls back to no materials)', async () => {
    // A DRAFT BOM on a fresh finished item must NOT be exploded.
    const uomId = Number((await pool.query(`SELECT uom_id FROM mdm.uom WHERE uom_code='NOS'`)).rows[0].uom_id);
    const draftBom = Number((await pool.query(
      `INSERT INTO mdm.bom_header (company_id, bu_id, bom_no, parent_item_id, bom_type, revision, status)
       VALUES ($1, $2, $4, $3, 'MBOM', 'WO-DRAFT', 'DRAFT')
       ON CONFLICT (parent_item_id, bom_type, revision) DO UPDATE SET status = 'DRAFT'
       RETURNING bom_id`, [companyId, buId, itemId, `BOM-WO-DRAFT-${companyId}`])).rows[0].bom_id);
    await pool.query(
      `INSERT INTO mdm.bom_line (bom_id, component_item_id, qty_per, uom_id, scrap_pct)
       VALUES ($1, $2, 5, $3, 0) ON CONFLICT (bom_id, component_item_id) DO NOTHING`,
      [draftBom, compItemId1, uomId]);

    const res = await request(app).post('/api/work-orders').set(hdr(productionUser))
      .send({ projectId, itemId, qty: 2, bomId: draftBom });
    expect(res.status).toBe(201);
    expect(res.body.materials).toEqual([]); // DRAFT bom is not a usable baseline
  });
});
