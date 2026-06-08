import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { ehsRouter } from '../src/modules/ehs/ehs.routes';

/**
 * Integration tests for the EHS / Incident Register. Runs only when DATABASE_URL is
 * set. Mounts the router exactly as the composition root does.
 *
 * Anyone on the floor can REPORT (PRODUCTION has EHS.VC), so production_user creates;
 * QC owns the investigation + closure (EHS.VCEDA), so qc_user investigates + signs off.
 * SALES was NOT granted EHS, so sales_user is the 403-on-create probe.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/ehs', ehsRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('EHS / Incident Register API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let qcUser: number;
  let productionUser: number;
  let salesUser: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId), 'x-company-id': String(companyId), 'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let version: number;

  it('creates an incident (201) with an auto-generated INC number, in REPORTED', async () => {
    const res = await request(app).post('/api/ehs').set(hdr(productionUser)).send({
      incidentType: 'INJURY', severity: 'HIGH', location: 'Assembly Bay 3',
      description: 'Operator cut hand on a sheet-metal edge while loading the press.',
    });
    expect(res.status).toBe(201);
    expect(res.body.incidentNo).toMatch(/^INC\//);
    expect(res.body.status).toBe('REPORTED');
    expect(res.body.reportedBy).toBe(productionUser);
    expect(res.body.closedAt).toBeNull();
    createdId = res.body.incidentId;
    version = res.body.rowVersion;
  });

  it('denies create without EHS.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/ehs').set(hdr(salesUser))
      .send({ incidentType: 'OTHER', description: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): unknown type / missing description', async () => {
    const r1 = await request(app).post('/api/ehs').set(hdr(productionUser))
      .send({ incidentType: 'NOPE', description: 'x' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/ehs').set(hdr(productionUser))
      .send({ incidentType: 'SPILL' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/ehs');
    expect(res.status).toBe(401);
  });

  it('lists incidents (200) and fetches one (200), 404 unknown', async () => {
    const list = await request(app).get('/api/ehs?status=REPORTED').set(hdr(qcUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const ok = await request(app).get(`/api/ehs/${createdId}`).set(hdr(qcUser));
    expect(ok.status).toBe(200);
    expect(ok.body.incidentId).toBe(createdId);
    const no = await request(app).get('/api/ehs/99999999').set(hdr(qcUser));
    expect(no.status).toBe(404);
  });

  it('blocks close before a corrective action is recorded (400)', async () => {
    // move REPORTED -> INVESTIGATING as QC, then attempt close with no corrective action
    const inv = await request(app).post(`/api/ehs/${createdId}/start-investigation`).set(hdr(qcUser))
      .send({ rowVersion: version });
    expect(inv.status).toBe(200);
    expect(inv.body.status).toBe('INVESTIGATING');
    version = inv.body.rowVersion;

    const bad = await request(app).post(`/api/ehs/${createdId}/close`).set(hdr(qcUser))
      .send({ rowVersion: version });
    expect(bad.status).toBe(400);
  });

  it('records a corrective action then closes (QC sign-off) and emits ehs.incident.closed', async () => {
    const patch = await request(app).patch(`/api/ehs/${createdId}`).set(hdr(qcUser))
      .send({ correctiveAction: 'Installed edge guards; toolbox talk on PPE.', rowVersion: version });
    expect(patch.status).toBe(200);
    version = patch.body.rowVersion;

    const close = await request(app).post(`/api/ehs/${createdId}/close`).set(hdr(qcUser))
      .send({ rowVersion: version });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe('CLOSED');
    expect(close.body.closedAt).not.toBeNull();

    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='EHS_INCIDENT' AND aggregate_id=$1 AND event_type='ehs.incident.closed'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.incidentNo).toMatch(/^INC\//);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/ehs').set(hdr(productionUser))
      .send({ incidentType: 'NEARMISS', description: 'Forklift near-miss at the loading dock.' });
    expect(create.status).toBe(201);
    const id = create.body.incidentId;
    // advance the version once so the original is now stale
    await request(app).post(`/api/ehs/${id}/start-investigation`).set(hdr(qcUser))
      .send({ rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/ehs/${id}/start-investigation`).set(hdr(qcUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
