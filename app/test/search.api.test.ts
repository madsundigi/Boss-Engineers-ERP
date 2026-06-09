import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { searchRouter } from '../src/modules/search/search.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts searchRouter at /api/search exactly as the composition root does
 * (createApp wires `app.use('/api/search', searchRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * Central Search is READ-ONLY: it owns no table and writes nothing. The DB may be
 * nearly empty, so these tests assert the response SHAPE (query/groups/total, with
 * each group well-formed and total = Σ hits) rather than specific magnitudes, and
 * that RBAC is enforced: the route needs DASHBOARD.VIEW (held by ~all roles), each
 * group is additionally gated on a per-module VIEW permission, and a missing `q` is
 * rejected 400 by validation.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/search', searchRouter(pool));
  app.use(errorMiddleware);
  return app;
}

interface SearchHitBody { id: number; no: string; title: string; subtitle: string | null; path: string | null }
interface SearchGroupBody { type: string; label: string; hits: SearchHitBody[] }
interface SearchResultsBody { query: string; groups: SearchGroupBody[]; total: number }

d('Search API (integration) — global cross-entity search, RBAC, validation', () => {
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
    // ceo_user -> CEO (broad VIEW across modules); sales_user -> SALES (ENQUIRY/QUOTATION VIEW).
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  /** Assert a body matches the documented SearchResults shape and total invariant. */
  function expectWellFormed(body: SearchResultsBody) {
    expect(typeof body.query).toBe('string');
    expect(Array.isArray(body.groups)).toBe(true);
    expect(typeof body.total).toBe('number');

    let summed = 0;
    for (const g of body.groups) {
      expect(typeof g.type).toBe('string');
      expect(typeof g.label).toBe('string');
      expect(Array.isArray(g.hits)).toBe(true);
      expect(g.hits.length).toBeGreaterThan(0); // empty groups are omitted
      for (const h of g.hits) {
        expect(typeof h.id).toBe('number');
        expect(typeof h.no).toBe('string');
        expect(typeof h.title).toBe('string');
        // subtitle and path are nullable strings
        expect(['string', 'object']).toContain(typeof h.subtitle);
        expect(['string', 'object']).toContain(typeof h.path);
      }
      summed += g.hits.length;
    }
    expect(body.total).toBe(summed); // total = Σ hits across groups
  }

  it('GET /api/search?q=... (200) returns the documented grouped shape', async () => {
    const res = await request(app).get('/api/search').query({ q: 'a' }).set(hdr(ceoUser));
    expect(res.status).toBe(200);
    const body = res.body as SearchResultsBody;
    expect(body.query).toBe('a');
    expectWellFormed(body);
  });

  it('honours the limit param (per-group hit cap) and stays well-formed', async () => {
    const res = await request(app).get('/api/search').query({ q: 'a', limit: 1 }).set(hdr(ceoUser));
    expect(res.status).toBe(200);
    const body = res.body as SearchResultsBody;
    for (const g of body.groups) {
      expect(g.hits.length).toBeLessThanOrEqual(1);
    }
    expectWellFormed(body);
  });

  it('returns 400 when `q` is missing', async () => {
    const res = await request(app).get('/api/search').set(hdr(ceoUser));
    expect(res.status).toBe(400);
  });

  it('returns 400 when `q` is blank (trimmed to empty)', async () => {
    const res = await request(app).get('/api/search').query({ q: '   ' }).set(hdr(ceoUser));
    expect(res.status).toBe(400);
  });

  it('a SALES user only gets groups they are permitted to see', async () => {
    // SALES holds ENQUIRY.VIEW + QUOTATION.VIEW + PROJECT.VIEW (read) but NOT
    // SERVICE_TICKET.VIEW, so the service_ticket group must never appear.
    const res = await request(app).get('/api/search').query({ q: 'a' }).set(hdr(salesUser));
    expect(res.status).toBe(200);
    const body = res.body as SearchResultsBody;
    expect(body.groups.map((g) => g.type)).not.toContain('service_ticket');
    expectWellFormed(body);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/search').query({ q: 'a' });
    expect(res.status).toBe(401);
  });
});
