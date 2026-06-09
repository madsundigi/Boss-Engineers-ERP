import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { dashboardRouter } from '../src/modules/dashboard/dashboard.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * M16 is READ-ONLY: it owns no table and writes nothing. The DB may be nearly
 * empty, so these tests assert that each KPI key is present and a number >= 0
 * (never a specific magnitude), and that RBAC is enforced: every read needs
 * DASHBOARD.VIEW (held by ~all roles) while the export needs DASHBOARD.EXPORT
 * (CEO + FINANCE only) — so a VIEW-only role is forbidden from the export.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/dashboard', dashboardRouter(pool));
  app.use(errorMiddleware);
  return app;
}

// Every numeric KPI key the summary must expose on a fresh DB.
const SCALAR_KEYS = [
  'activeProjects', 'orderBook', 'wipWorkOrders', 'dispatchesMtd',
  'arOutstanding', 'apOutstanding', 'openNcrs', 'avgMarginPct', 'deliveryAtRisk',
  'revenue', 'fatPassRate', 'productionEfficiency', 'openServiceTickets',
] as const;

d('Dashboard API (integration) — read-only KPIs, funnel, export RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let ceoUser: number;
  let salesUser: number;

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
    // ceo_user -> CEO (DASHBOARD.VIEW + EXPORT); sales_user -> SALES (DASHBOARD.VIEW only).
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  it('GET /kpis (200) returns an object with every numeric KPI key (>= 0)', async () => {
    const res = await request(app).get('/api/dashboard/kpis').set(hdr(ceoUser));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    for (const key of SCALAR_KEYS) {
      expect(body).toHaveProperty(key);
      expect(typeof body[key]).toBe('number');
      expect(body[key] as number).toBeGreaterThanOrEqual(0);
    }
    // nested sales pipeline object: all four fields present and numeric (>= 0).
    const sp = body.salesPipeline as Record<string, unknown>;
    for (const key of ['openEnquiries', 'openEnquiryValue', 'openQuotations', 'openQuotationValue']) {
      expect(typeof sp[key]).toBe('number');
      expect(sp[key] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('GET /kpis allows a VIEW-only role (sales) to read', async () => {
    const res = await request(app).get('/api/dashboard/kpis').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(typeof res.body.activeProjects).toBe('number');
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/dashboard/kpis');
    expect(res.status).toBe(401);
  });

  it('GET /sales-funnel (200) returns the four ordered stages as counts', async () => {
    const res = await request(app).get('/api/dashboard/sales-funnel').set(hdr(ceoUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const stages = (res.body as Array<{ stage: string; count: number }>).map((r) => r.stage);
    expect(stages).toEqual(['ENQUIRY', 'QUOTATION', 'WON', 'PROJECT']);
    for (const row of res.body as Array<{ count: number }>) {
      expect(typeof row.count).toBe('number');
      expect(row.count).toBeGreaterThanOrEqual(0);
    }
  });

  it('GET /sales-funnel requires authentication (401)', async () => {
    const res = await request(app).get('/api/dashboard/sales-funnel');
    expect(res.status).toBe(401);
  });

  it('GET /kpis/export (200, text/csv) as ceo_user (DASHBOARD.EXPORT)', async () => {
    const res = await request(app).get('/api/dashboard/kpis/export').set(hdr(ceoUser));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toBe('Metric,Value');
    expect(res.text).toContain('activeProjects');
  });

  it('DENIES the export to a VIEW-only role (sales -> 403)', async () => {
    const res = await request(app).get('/api/dashboard/kpis/export').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('requires authentication (401) for the export', async () => {
    const res = await request(app).get('/api/dashboard/kpis/export');
    expect(res.status).toBe(401);
  });
});
