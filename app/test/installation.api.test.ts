import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { installationRouter } from '../src/modules/installation/installation.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts installationRouter at /api/installations exactly as the
 * composition root does (createApp wires `app.use('/api/installations',
 * installationRouter(pool))`); here we mount a minimal equivalent so the module
 * is testable independently of app.ts.
 *
 * Site lifecycle: PLANNED -> IN_PROGRESS -> COMMISSIONED (SAT PASS/FAIL) ->
 * ACCEPTED -> CLOSED. Acceptance is gated on a PASSED SAT + zero open punch items
 * and emits 'installation.accepted' (warranty clock start downstream).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/installations', installationRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Installation API (integration) — create, commission, gated acceptance, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let installUser: number;
  let salesUser: number;
  let projectId: number;
  let customerId: number;

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
    installUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='install_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the installation references (project_id is a NOT NULL FK on
    // svc.installation and is not in the base seed). The test connects as the
    // owning superuser, so RLS does not filter these inserts. A pm_user_id is
    // required.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-INST-TEST', 'Installation Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, installUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates an installation (201) with an auto-generated INST number, in PLANNED', async () => {
    const res = await request(app).post('/api/installations').set(hdr(installUser)).send({
      projectId,
      siteAddress: 'Plot 7, MIDC, Pune',
      plannedDate: '2026-06-20',
    });
    expect(res.status).toBe(201);
    expect(typeof res.body.installNo).toBe('string');
    expect(res.body.installNo).toMatch(/^INST/);
    expect(res.body.status).toBe('PLANNED');
    expect(res.body.satResult).toBe('PENDING');
    createdId = res.body.installId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without INSTALLATION.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post('/api/installations').set(hdr(salesUser)).send({ projectId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing project / bad date', async () => {
    const r1 = await request(app).post('/api/installations').set(hdr(installUser)).send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/installations').set(hdr(installUser))
      .send({ projectId, plannedDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/installations');
    expect(res.status).toBe(401);
  });

  it('lists installations (200) and allows the SALES view-only role to read', async () => {
    const res = await request(app).get('/api/installations?status=PLANNED').set(hdr(installUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/installations').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/installations/${createdId}`).set(hdr(installUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    const no = await request(app).get('/api/installations/99999999').set(hdr(installUser));
    expect(no.status).toBe(404);
  });

  it('round-trips siteEngineerId on create and progressPct on update', async () => {
    // site_engineer_id FKs sec.app_user; install_user is a real seeded user.
    const created = await request(app).post('/api/installations').set(hdr(installUser)).send({
      projectId, siteAddress: 'Plot 9, MIDC', siteEngineerId: installUser, plannedDate: '2026-07-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.siteEngineerId).toBe(installUser);
    expect(created.body.progressPct).toBeNull();

    // PATCH the progress while still PLANNED (an editable status).
    const patched = await request(app).patch(`/api/installations/${created.body.installId}`).set(hdr(installUser))
      .send({ progressPct: 45.5, rowVersion: created.body.rowVersion });
    expect(patched.status).toBe(200);
    expect(Number(patched.body.progressPct)).toBeCloseTo(45.5, 2);
    expect(patched.body.siteEngineerId).toBe(installUser);

    // re-read confirms persistence
    const reread = await request(app).get(`/api/installations/${created.body.installId}`).set(hdr(installUser));
    expect(reread.status).toBe(200);
    expect(Number(reread.body.progressPct)).toBeCloseTo(45.5, 2);
    expect(reread.body.siteEngineerId).toBe(installUser);
  });

  it('rejects an out-of-range progressPct (400)', async () => {
    const created = await request(app).post('/api/installations').set(hdr(installUser)).send({ projectId });
    expect(created.status).toBe(201);
    const bad = await request(app).patch(`/api/installations/${created.body.installId}`).set(hdr(installUser))
      .send({ progressPct: 150, rowVersion: created.body.rowVersion });
    expect(bad.status).toBe(400);
  });

  it('BLOCKS acceptance before commissioning / SAT pass (409)', async () => {
    // still PLANNED — cannot accept (must commission with a PASS first)
    const res = await request(app).post(`/api/installations/${createdId}/accept`).set(hdr(installUser))
      .send({ acceptanceCertNo: 'AC-EARLY', rowVersion: createdVersion });
    expect(res.status).toBe(409);
  });

  it('runs the happy path PLANNED -> IN_PROGRESS -> COMMISSIONED(PASS) -> ACCEPTED', async () => {
    const started = await request(app).post(`/api/installations/${createdId}/start`).set(hdr(installUser))
      .send({ rowVersion: createdVersion });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('IN_PROGRESS');

    const commissioned = await request(app).post(`/api/installations/${createdId}/commission`).set(hdr(installUser))
      .send({ satResult: 'PASS', actualDate: '2026-06-21', rowVersion: started.body.rowVersion });
    expect(commissioned.status).toBe(200);
    expect(commissioned.body.status).toBe('COMMISSIONED');
    expect(commissioned.body.satResult).toBe('PASS');

    const accepted = await request(app).post(`/api/installations/${createdId}/accept`).set(hdr(installUser))
      .send({ acceptanceCertNo: 'AC-001', acceptedDate: '2026-06-22', rowVersion: commissioned.body.rowVersion });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect(accepted.body.acceptanceCertNo).toBe('AC-001');

    // the acceptance recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='INSTALLATION' AND aggregate_id=$1 AND event_type='installation.accepted'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.installNo).toMatch(/^INST/);
    expect(Number(evt.rows[0].payload.projectId)).toBe(projectId);
  });

  it('409 when trying to ACCEPT before a SAT pass (commission FAIL)', async () => {
    const create = await request(app).post('/api/installations').set(hdr(installUser)).send({ projectId });
    expect(create.status).toBe(201);
    const id = create.body.installId;
    const started = await request(app).post(`/api/installations/${id}/start`).set(hdr(installUser))
      .send({ rowVersion: create.body.rowVersion });
    const failed = await request(app).post(`/api/installations/${id}/commission`).set(hdr(installUser))
      .send({ satResult: 'FAIL', rowVersion: started.body.rowVersion });
    expect(failed.status).toBe(200);
    expect(failed.body.satResult).toBe('FAIL');
    const accept = await request(app).post(`/api/installations/${id}/accept`).set(hdr(installUser))
      .send({ acceptanceCertNo: 'AC-FAIL', rowVersion: failed.body.rowVersion });
    expect(accept.status).toBe(409);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/installations').set(hdr(installUser)).send({ projectId });
    expect(create.status).toBe(201);
    const id = create.body.installId;
    // start once so the original version is now stale
    await request(app).post(`/api/installations/${id}/start`).set(hdr(installUser))
      .send({ rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/installations/${id}/start`).set(hdr(installUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
