import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { documentRouter } from '../src/modules/dms/dms.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts documentRouter at /api/documents exactly as the composition root
 * does (createApp wires `app.use('/api/documents', documentRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * DMS — a versioned document repository. The file body lives in EXTERNAL object
 * storage (S3 / blob); these tests pass a fake storageKey pointer (no upload). The
 * DOCUMENT domain grants PLANNING/SALES create (VCE) and FINANCE read-only (V), so
 * a create as finance_user is denied 403.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/documents', documentRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Document Management API (integration) — versions, lifecycle, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let salesUser: number;
  let financeUser: number;

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
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a document (201) with an auto-generated DOC number, in DRAFT', async () => {
    const res = await request(app).post('/api/documents').set(hdr(planningUser)).send({
      title: 'General Arrangement Drawing',
      category: 'DRAWING',
      entityType: 'PROJECT',
      entityId: 101,
    });
    expect(res.status).toBe(201);
    expect(res.body.docNo).toMatch(/^DOC\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.currentVersion).toBe(0);
    expect(res.body.versions).toEqual([]);
    createdId = res.body.docId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without DOCUMENT.CREATE (finance -> 403, view-only)', async () => {
    const res = await request(app).post('/api/documents').set(hdr(financeUser))
      .send({ title: 'Spec Sheet' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing title / empty body', async () => {
    const r1 = await request(app).post('/api/documents').set(hdr(planningUser)).send({ category: 'DRAWING' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/documents').set(hdr(planningUser)).send({});
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/documents');
    expect(res.status).toBe(401);
  });

  it('BLOCKS activate before any version is added (409)', async () => {
    const res = await request(app).post(`/api/documents/${createdId}/activate`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(409);
  });

  it('adds a version then getById shows it + current_version=1', async () => {
    const add = await request(app).post(`/api/documents/${createdId}/versions`).set(hdr(planningUser))
      .send({
        storageKey: 's3://be-docs/proj-101/ga-rev-a.pdf',
        fileName: 'ga-rev-a.pdf', mimeType: 'application/pdf', sizeBytes: 524288,
        notes: 'Initial issue',
      });
    expect(add.status).toBe(201);
    expect(add.body.currentVersion).toBe(1);
    createdVersion = add.body.rowVersion;

    const get = await request(app).get(`/api/documents/${createdId}`).set(hdr(planningUser));
    expect(get.status).toBe(200);
    expect(get.body.currentVersion).toBe(1);
    expect(get.body.versions).toHaveLength(1);
    expect(get.body.versions[0].versionNo).toBe(1);
    expect(get.body.versions[0].storageKey).toBe('s3://be-docs/proj-101/ga-rev-a.pdf');

    // a second version increments to 2
    const add2 = await request(app).post(`/api/documents/${createdId}/versions`).set(hdr(planningUser))
      .send({ storageKey: 's3://be-docs/proj-101/ga-rev-b.pdf' });
    expect(add2.status).toBe(201);
    expect(add2.body.currentVersion).toBe(2);
    createdVersion = add2.body.rowVersion;
  });

  it('activates the document (200, status ACTIVE) once a version exists', async () => {
    const res = await request(app).post(`/api/documents/${createdId}/activate`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    createdVersion = res.body.rowVersion;
  });

  it('lists documents (200) and allows the SALES (VCE) role to read', async () => {
    const res = await request(app).get('/api/documents?category=DRAWING').set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/documents').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/documents/${createdId}`).set(hdr(planningUser));
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('General Arrangement Drawing');
    const no = await request(app).get('/api/documents/99999999').set(hdr(planningUser));
    expect(no.status).toBe(404);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // archive bumps the row version, so the original (now stale) version conflicts.
    const archive = await request(app).post(`/api/documents/${createdId}/archive`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(archive.status).toBe(200);
    const stale = await request(app).patch(`/api/documents/${createdId}`).set(hdr(planningUser))
      .send({ title: 'Renamed', rowVersion: createdVersion });
    expect(stale.status).toBe(409);
  });
});
