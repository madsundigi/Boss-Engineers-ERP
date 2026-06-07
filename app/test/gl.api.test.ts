import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { glRouter } from '../src/modules/gl/gl.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts glRouter at /api/gl exactly as the composition root does
 * (createApp wires `app.use('/api/gl', glRouter(pool))`); here we mount a minimal
 * equivalent so the module is testable independently of app.ts.
 *
 * GL is a DOUBLE-ENTRY, APPEND-ONLY, PARTITIONED ledger: FINANCE posts journals
 * and costs (GL.VCEDAX); CEO is view/export only (GL.VX -> 403 on post); SALES has
 * no GL permission (403). posting_date defaults to today (within the p202606
 * monthly partition) — we never pass a far-future date.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/gl', glRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('GL API (integration) — double-entry posting, cost ledger, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let salesUser: number;
  let ceoUser: number;
  let projectId: number;
  let customerId: number;
  let cashGlId: number;
  let salesGlId: number;

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
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);

    // A project for the project-cost-ledger tests (project_id is a NOT NULL FK on
    // fin.project_cost_ledger). The test connects as the owning superuser, so RLS
    // does not filter these inserts. A pm_user_id is required on proj.project.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-GL-TEST', 'GL Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, financeUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let journalId: number;

  it('creates two GL accounts as FINANCE (201): a CASH asset + a SALES income account', async () => {
    const suffix = Date.now().toString().slice(-6); // unique gl_code per run (uq_gl per company)
    const cash = await request(app).post('/api/gl/accounts').set(hdr(financeUser))
      .send({ glCode: `CASH-${suffix}`, glName: 'Cash at Bank', accountType: 'ASSET' });
    expect(cash.status).toBe(201);
    expect(cash.body.accountType).toBe('ASSET');
    expect(cash.body.isActive).toBe(true);
    cashGlId = cash.body.glId;

    const sales = await request(app).post('/api/gl/accounts').set(hdr(financeUser))
      .send({ glCode: `SALES-${suffix}`, glName: 'Sales Revenue', accountType: 'INCOME' });
    expect(sales.status).toBe(201);
    salesGlId = sales.body.glId;

    // duplicate gl_code -> 409 (uq_gl unique per company)
    const dup = await request(app).post('/api/gl/accounts').set(hdr(financeUser))
      .send({ glCode: `CASH-${suffix}`, glName: 'Dup', accountType: 'ASSET' });
    expect([400, 409]).toContain(dup.status);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/gl/journals');
    expect(res.status).toBe(401);
  });

  it('denies posting to a role without GL.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/gl/journals').set(hdr(salesUser)).send({
      narration: 'x', lines: [{ glId: cashGlId, debit: 100 }, { glId: salesGlId, credit: 100 }],
    });
    expect(res.status).toBe(403);
  });

  it('denies posting to a view/export-only role (ceo -> 403)', async () => {
    const res = await request(app).post('/api/gl/journals').set(hdr(ceoUser)).send({
      narration: 'x', lines: [{ glId: cashGlId, debit: 100 }, { glId: salesGlId, credit: 100 }],
    });
    expect(res.status).toBe(403);
  });

  it('posts a balanced journal (201) with an auto-generated JV number + outbox event', async () => {
    const res = await request(app).post('/api/gl/journals').set(hdr(financeUser)).send({
      narration: 'Cash sale of goods',
      sourceDocType: 'INVOICE',
      sourceDocId: 12345,
      lines: [
        { glId: cashGlId, debit: 1000 },
        { glId: salesGlId, credit: 1000 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.journalNo).toMatch(/^JV\//);
    expect(res.body.lines).toHaveLength(2);
    journalId = res.body.glEntryId;

    // the posting recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='GL_ENTRY' AND event_type='gl.journal.posted'
        ORDER BY event_id DESC LIMIT 1`);
    expect(evt.rowCount).toBe(1);
    expect(Number(evt.rows[0].payload.totalDebit)).toBe(1000);
  });

  it('rejects an unbalanced journal (400)', async () => {
    const res = await request(app).post('/api/gl/journals').set(hdr(financeUser)).send({
      narration: 'unbalanced',
      lines: [{ glId: cashGlId, debit: 1000 }, { glId: salesGlId, credit: 900 }],
    });
    expect(res.status).toBe(400);
  });

  it('fetches one journal (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/gl/journals/${journalId}`).set(hdr(financeUser));
    expect(ok.status).toBe(200);
    expect(ok.body.journalNo).toMatch(/^JV\//);
    expect(ok.body.lines).toHaveLength(2);
    const no = await request(app).get('/api/gl/journals/99999999').set(hdr(financeUser));
    expect(no.status).toBe(404);
  });

  it('lists journals (200) and allows the CEO view role to read', async () => {
    const res = await request(app).get('/api/gl/journals?sourceDocType=INVOICE').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asCeo = await request(app).get('/api/gl/journals').set(hdr(ceoUser));
    expect(asCeo.status).toBe(200);
  });

  it('returns a balanced trial balance (200): total debits == total credits', async () => {
    const res = await request(app).get('/api/gl/trial-balance').set(hdr(financeUser));
    expect(res.status).toBe(200);
    const totalDebit = res.body.reduce((s: number, r: { totalDebit: number }) => s + Number(r.totalDebit), 0);
    const totalCredit = res.body.reduce((s: number, r: { totalCredit: number }) => s + Number(r.totalCredit), 0);
    // every posted journal balances, so the whole trial balance must balance.
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThanOrEqual(1000);
  });

  it('posts a project cost (201) and summarises it by type x stage (200)', async () => {
    const post = await request(app).post('/api/gl/costs').set(hdr(financeUser)).send({
      projectId, costType: 'MATERIAL', costStage: 'ACTUAL', amount: 5000,
      refDocType: 'GRN', refDocId: 42,
    });
    expect(post.status).toBe(201);
    expect(post.body.costType).toBe('MATERIAL');
    expect(Number(post.body.amount)).toBe(5000);

    const sum = await request(app).get(`/api/gl/projects/${projectId}/cost-summary`).set(hdr(financeUser));
    expect(sum.status).toBe(200);
    const material = sum.body.find((r: { costType: string; costStage: string }) =>
      r.costType === 'MATERIAL' && r.costStage === 'ACTUAL');
    expect(material).toBeDefined();
    expect(Number(material.amount)).toBeGreaterThanOrEqual(5000);
  });
});
