import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { fatProtocolRouter } from '../src/modules/fatprotocol/fatprotocol.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts fatProtocolRouter at /api/fat-protocols exactly as the composition
 * root does (`app.use('/api/fat-protocols', fatProtocolRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC: QC owns FAT master data (FAT.VCEDAX), so qc_user does the full CRUD; SALES
 * has FAT.VIEW only, so create is 403. The table has no row_version / is_deleted, so
 * there is no optimistic concurrency and DELETE is a HARD delete (cascading lines).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/fat-protocols', fatProtocolRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('FAT Protocol API (integration) — checklist master, nested params, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let qcUser: number;
  let salesUser: number;

  // Unique per run so re-running the suite never collides with the protocol_code UNIQUE.
  const protocolCode = `FAT-${Date.now()}`;

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
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => {
    if (createdId) {
      await pool.query(`DELETE FROM qms.fat_protocol WHERE protocol_id=$1`, [createdId]).catch(() => undefined);
    }
    await pool.end();
  });

  let createdId: number;

  it('creates a protocol with checklist params (201) as qc_user, active by default', async () => {
    const res = await request(app).post('/api/fat-protocols').set(hdr(qcUser)).send({
      protocolCode, protocolName: 'Induction Heater FAT', testType: 'FAT',
      params: [
        { seq: 1, paramName: 'Coil temperature rise', specMin: 0, specMax: 80, uom: 'degC' },
        { seq: 2, paramName: 'Insulation resistance', specMin: 1, uom: 'MOhm' },
        { seq: 3, paramName: 'Earth continuity (visual)' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.protocolCode).toBe(protocolCode);
    expect(res.body.isActive).toBe(true);
    expect(res.body.testType).toBe('FAT');
    expect(res.body.params).toHaveLength(3);
    expect(res.body.params[0].seq).toBe(1);
    expect(res.body.params[0].specMax).toBe(80);
    createdId = res.body.protocolId;
  });

  it('denies create without FAT.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/fat-protocols').set(hdr(salesUser))
      .send({ protocolCode: `${protocolCode}-X`, protocolName: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing protocol name', async () => {
    const res = await request(app).post('/api/fat-protocols').set(hdr(qcUser))
      .send({ protocolCode: `${protocolCode}-Y` });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate protocol_code (409)', async () => {
    const res = await request(app).post('/api/fat-protocols').set(hdr(qcUser))
      .send({ protocolCode, protocolName: 'Duplicate code' });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/fat-protocols');
    expect(res.status).toBe(401);
  });

  it('lists protocols (200) and fetches one with its lines (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/fat-protocols?q=${protocolCode}`).set(hdr(qcUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/fat-protocols/${createdId}`).set(hdr(qcUser));
    expect(ok.status).toBe(200);
    expect(ok.body.protocolCode).toBe(protocolCode);
    expect(Array.isArray(ok.body.params)).toBe(true);
    expect(ok.body.params).toHaveLength(3);

    const no = await request(app).get('/api/fat-protocols/99999999').set(hdr(qcUser));
    expect(no.status).toBe(404);
  });

  it('updates the header and REPLACES the checklist lines (200)', async () => {
    const res = await request(app).patch(`/api/fat-protocols/${createdId}`).set(hdr(qcUser)).send({
      protocolName: 'Induction Heater FAT v2',
      params: [
        { seq: 1, paramName: 'Output power', specMin: 95, specMax: 105, uom: 'kW' },
        { seq: 2, paramName: 'Frequency', specMin: 10, specMax: 30, uom: 'kHz' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.protocolName).toBe('Induction Heater FAT v2');
    expect(res.body.params).toHaveLength(2);
    expect(res.body.params[0].paramName).toBe('Output power');

    // The replacement is persisted (the old 3 lines are gone).
    const after = await request(app).get(`/api/fat-protocols/${createdId}`).set(hdr(qcUser));
    expect(after.body.params).toHaveLength(2);
  });

  it('rejects an inverted spec band on update (400)', async () => {
    const res = await request(app).patch(`/api/fat-protocols/${createdId}`).set(hdr(qcUser)).send({
      params: [{ seq: 1, paramName: 'Bad band', specMin: 50, specMax: 10 }],
    });
    expect(res.status).toBe(400);
  });

  it('hard-deletes the protocol (204), then it is gone (404)', async () => {
    const del = await request(app).delete(`/api/fat-protocols/${createdId}`).set(hdr(qcUser));
    expect(del.status).toBe(204);
    const gone = await request(app).get(`/api/fat-protocols/${createdId}`).set(hdr(qcUser));
    expect(gone.status).toBe(404);
    createdId = 0; // already removed; skip afterAll cleanup
  });
});
