import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { qualityRouter } from '../src/modules/quality/quality.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts qualityRouter at /api/inspections exactly as the composition
 * root does (createApp wires `app.use('/api/inspections', qualityRouter(pool))`);
 * here we mount a minimal equivalent so the module is testable independently.
 *
 * QMS Quality: QC owns the surface (record results, calibrate, export);
 * PRODUCTION/STORES can raise inspections + record results (INSPECTION.VC);
 * SALES has no INSPECTION permission (403). A FAIL overall result emits the
 * 'inspection.failed' transactional-outbox event so a downstream NCR can be raised.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/inspections', qualityRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Quality (QMS) API (integration) — inspection lifecycle, calibration, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let qcUser: number;
  let productionUser: number;
  let salesUser: number;
  let storesUser: number;
  let itemId: number;
  let projectId: number;

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
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);

    // Master data the inspection references. The test connects as the owning
    // superuser, so RLS does not filter these inserts. project_id is referenced
    // by some inspections; a pm_user_id is required on proj.project.
    itemId = Number((await one(
      `SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST' AND company_id=$1`, [companyId])).item_id);
    const customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-QMS-TEST', 'QMS Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, qcUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;
  let lineId: number;

  it('creates an inspection (201) as QC with an auto-generated INSP number, in PENDING', async () => {
    const res = await request(app).post('/api/inspections').set(hdr(qcUser)).send({
      inspType: 'INCOMING', sourceDocType: 'GRN', itemId, projectId,
      lines: [{ itemId, parameter: 'OD diameter', sampleQty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.inspNo).toMatch(/^INSP\//);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.result).toBeNull();
    expect(res.body.lines).toHaveLength(1);
    createdId = res.body.inspectionId;
    createdVersion = res.body.rowVersion;
    lineId = res.body.lines[0].inspLineId;
  });

  it('denies create without INSPECTION.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/inspections').set(hdr(salesUser)).send({
      inspType: 'INCOMING', itemId, lines: [{ itemId }],
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): no parameter lines / bad date', async () => {
    const r1 = await request(app).post('/api/inspections').set(hdr(qcUser)).send({ inspType: 'INCOMING', lines: [] });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/inspections').set(hdr(qcUser))
      .send({ inspType: 'INCOMING', inspDate: 'not-a-date', lines: [{ itemId }] });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/inspections');
    expect(res.status).toBe(401);
  });

  it('lists inspections (200) and 404s an unknown id', async () => {
    const list = await request(app).get('/api/inspections?status=PENDING&source=GRN').set(hdr(qcUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const ok = await request(app).get(`/api/inspections/${createdId}`).set(hdr(qcUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    const no = await request(app).get('/api/inspections/99999999').set(hdr(qcUser));
    expect(no.status).toBe(404);
  });

  it('records a FAIL result (200) and emits inspection.failed', async () => {
    const res = await request(app).post(`/api/inspections/${createdId}/results`).set(hdr(qcUser)).send({
      result: 'FAIL',
      lines: [{ inspLineId: lineId, acceptedQty: 0, rejectedQty: 5, result: 'FAIL' }],
      rowVersion: createdVersion,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAIL');
    expect(res.body.result).toBe('FAIL');

    // the FAIL recorded a transactional-outbox event for the downstream NCR raise.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='INSPECTION' AND aggregate_id=$1 AND event_type='inspection.failed'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.inspNo).toMatch(/^INSP\//);
    expect(evt.rows[0].payload.sourceDocType).toBe('GRN');
  });

  it('409 when recording results again on a now-terminal inspection', async () => {
    const fresh = await request(app).get(`/api/inspections/${createdId}`).set(hdr(qcUser));
    const res = await request(app).post(`/api/inspections/${createdId}/results`).set(hdr(qcUser)).send({
      result: 'PASS', lines: [{ inspLineId: lineId, result: 'PASS' }], rowVersion: fresh.body.rowVersion,
    });
    expect(res.status).toBe(409);
  });

  it('records a PASS result (200) on a separate inspection as PRODUCTION', async () => {
    const create = await request(app).post('/api/inspections').set(hdr(productionUser)).send({
      inspType: 'IN_PROCESS', itemId, lines: [{ itemId, parameter: 'Weld', sampleQty: 2 }],
    });
    expect(create.status).toBe(201);
    const id = create.body.inspectionId;
    const ln = create.body.lines[0].inspLineId;
    const res = await request(app).post(`/api/inspections/${id}/results`).set(hdr(productionUser)).send({
      result: 'PASS', lines: [{ inspLineId: ln, acceptedQty: 2, result: 'PASS' }], rowVersion: create.body.rowVersion,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PASS');
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/inspections').set(hdr(qcUser)).send({
      inspType: 'INCOMING', itemId, lines: [{ itemId, parameter: 'ID', sampleQty: 1 }],
    });
    expect(create.status).toBe(201);
    const id = create.body.inspectionId;
    const ln = create.body.lines[0].inspLineId;
    // record results once so the original version is now stale
    await request(app).post(`/api/inspections/${id}/results`).set(hdr(qcUser)).send({
      result: 'PASS', lines: [{ inspLineId: ln, result: 'PASS' }], rowVersion: create.body.rowVersion,
    });
    const stale = await request(app).post(`/api/inspections/${id}/results`).set(hdr(qcUser)).send({
      result: 'FAIL', lines: [{ inspLineId: ln, result: 'FAIL' }], rowVersion: create.body.rowVersion,
    });
    expect(stale.status).toBe(409);
  });

  // --- Calibration register --------------------------------------------------
  let gaugeId: number;

  it('registers a gauge (201) as QC', async () => {
    const code = `VC-${Date.now()}`;
    const res = await request(app).post('/api/inspections/gauges').set(hdr(qcUser)).send({
      gaugeCode: code, gaugeName: 'Vernier Caliper 0-150mm', gaugeType: 'CALIPER', location: 'QC Lab',
    });
    expect(res.status).toBe(201);
    expect(res.body.gaugeCode).toBe(code);
    expect(res.body.status).toBe('ACTIVE');
    gaugeId = res.body.gaugeId;
  });

  it('denies gauge registration without INSPECTION.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/inspections/gauges').set(hdr(salesUser))
      .send({ gaugeCode: 'X', gaugeName: 'Y' });
    expect(res.status).toBe(403);
  });

  it('records a calibration (201) and advances the gauge due date', async () => {
    const res = await request(app).post(`/api/inspections/gauges/${gaugeId}/calibrations`).set(hdr(qcUser)).send({
      calDate: '2026-06-07', dueDate: '2027-06-07', result: 'PASS', certificateNo: 'CERT-QMS-1',
    });
    expect(res.status).toBe(201);
    expect(res.body.gauge.lastCalDate).toBe('2026-06-07');
    expect(res.body.gauge.nextCalDue).toBe('2027-06-07');
    expect(res.body.record.result).toBe('PASS');
  });

  it('records an overdue calibration so the gauge becomes due, then lists due gauges (200)', async () => {
    // a past due date marks the gauge DUE and makes it appear in the due filter.
    const due = await request(app).post(`/api/inspections/gauges/${gaugeId}/calibrations`).set(hdr(qcUser)).send({
      calDate: '2024-01-01', dueDate: '2024-12-31', result: 'PASS',
    });
    expect(due.status).toBe(201);
    expect(due.body.gauge.status).toBe('DUE');

    const list = await request(app).get('/api/inspections/gauges?due=true').set(hdr(qcUser));
    expect(list.status).toBe(200);
    expect(list.body.rows.some((g: { gaugeId: number }) => g.gaugeId === gaugeId)).toBe(true);

    const hist = await request(app).get(`/api/inspections/gauges/${gaugeId}/calibrations`).set(hdr(qcUser));
    expect(hist.status).toBe(200);
    expect(hist.body.length).toBeGreaterThanOrEqual(2);
  });
});
