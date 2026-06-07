import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { bomRouter } from '../src/modules/bom/bom.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts bomRouter at /api/boms exactly as the composition root does
 * (createApp wires `app.use('/api/boms', bomRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC (db/08): PLANNING + PRODUCTION create/edit (BOM.VCE); QC + CEO + PURCHASE +
 * SERVICE read-only (BOM.V); FINANCE + SALES hold NO BOM permission (403 even on
 * read). Release/obsolete are guarded by BOM.EDIT (there is no BOM.APPROVE grant).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/boms', bomRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('BOM API (integration) — create, release, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let productionUser: number;
  let qcUser: number;
  let financeUser: number;
  let salesUser: number;
  let parentItemId: number;
  let componentItemId: number;
  let uomId: number;

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
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the BOM references. The seed ships one item (ITEM-TEST) + one uom
    // (NOS); use those for the parent and uom, and insert a distinct COMP-TEST item
    // for the component lines so parent != component. The test connects as the owning
    // superuser, so RLS does not filter these inserts.
    uomId = Number((await one(`SELECT uom_id FROM mdm.uom WHERE uom_code='NOS'`)).uom_id);
    parentItemId = Number((await one(
      `SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST' AND company_id=$1`, [companyId])).item_id);
    const comp = await one(
      `INSERT INTO mdm.item (company_id, item_code, item_name, item_category_id, item_type, base_uom_id, std_cost)
       SELECT $1, 'COMP-TEST', 'Test Component', cat.category_id, 'RAW', $2, 50
       FROM mdm.item_category cat WHERE cat.cat_code='RAW'
       ON CONFLICT (item_code) DO UPDATE SET item_name = EXCLUDED.item_name
       RETURNING item_id`, [companyId, uomId]);
    componentItemId = Number(comp.item_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a BOM (201) with an auto-generated BOM number, in DRAFT, with one line', async () => {
    const res = await request(app).post('/api/boms').set(hdr(planningUser)).send({
      parentItemId, bomType: 'EBOM', revision: 'R-CREATE',
      lines: [{ componentItemId, qtyPer: 2, uomId, scrapPct: 5, isCritical: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.bomNo).toMatch(/^BOM\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.bomType).toBe('EBOM');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].componentItemId).toBe(componentItemId);
    createdId = res.body.bomId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without BOM.CREATE (qc -> 403, view-only)', async () => {
    const res = await request(app).post('/api/boms').set(hdr(qcUser))
      .send({ parentItemId, bomType: 'EBOM', revision: 'R-QC' });
    expect(res.status).toBe(403);
  });

  it('denies even read to a role without any BOM permission (finance -> 403)', async () => {
    const res = await request(app).get('/api/boms').set(hdr(financeUser));
    expect(res.status).toBe(403);
    const asSales = await request(app).get('/api/boms').set(hdr(salesUser));
    expect(asSales.status).toBe(403);
  });

  it('rejects invalid bodies (400): missing bom_type, qty_per<=0, duplicate component', async () => {
    const r1 = await request(app).post('/api/boms').set(hdr(planningUser))
      .send({ parentItemId, revision: 'R-X' }); // missing bomType
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/boms').set(hdr(planningUser))
      .send({ parentItemId, bomType: 'EBOM', revision: 'R-Y', lines: [{ componentItemId, qtyPer: 0, uomId }] });
    expect(r2.status).toBe(400);
    const r3 = await request(app).post('/api/boms').set(hdr(planningUser)).send({
      parentItemId, bomType: 'EBOM', revision: 'R-Z',
      lines: [{ componentItemId, qtyPer: 1, uomId }, { componentItemId, qtyPer: 2, uomId }],
    });
    expect(r3.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/boms');
    expect(res.status).toBe(401);
  });

  it('lists BOMs (200) and allows the PRODUCTION role to read', async () => {
    const res = await request(app).get('/api/boms?status=DRAFT').set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asProd = await request(app).get('/api/boms').set(hdr(productionUser));
    expect(asProd.status).toBe(200);
  });

  it('fetches one (200) with nested lines and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/boms/${createdId}`).set(hdr(planningUser));
    expect(ok.status).toBe(200);
    expect(ok.body.parentItemId).toBe(parentItemId);
    expect(ok.body.lines).toHaveLength(1);
    const no = await request(app).get('/api/boms/99999999').set(hdr(planningUser));
    expect(no.status).toBe(404);
  });

  it('releases a DRAFT BOM with lines (200, RELEASED) and records bom.released', async () => {
    const rel = await request(app).post(`/api/boms/${createdId}/release`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(rel.status).toBe(200);
    expect(rel.body.status).toBe('RELEASED');

    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='BOM' AND aggregate_id=$1 AND event_type='bom.released'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.bomNo).toMatch(/^BOM\//);
  });

  it('BLOCKS release of a BOM with no lines (409)', async () => {
    const create = await request(app).post('/api/boms').set(hdr(planningUser))
      .send({ parentItemId, bomType: 'MBOM', revision: 'R-EMPTY' }); // no lines
    expect(create.status).toBe(201);
    const res = await request(app).post(`/api/boms/${create.body.bomId}/release`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(res.status).toBe(409);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/boms').set(hdr(planningUser)).send({
      parentItemId, bomType: 'EBOM', revision: 'R-STALE',
      lines: [{ componentItemId, qtyPer: 1, uomId }],
    });
    expect(create.status).toBe(201);
    const id = create.body.bomId;
    // a successful edit bumps the row version, so the original is now stale
    const edit = await request(app).patch(`/api/boms/${id}`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion, revision: 'R-STALE2' });
    expect(edit.status).toBe(200);
    const stale = await request(app).post(`/api/boms/${id}/release`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
