import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Enquiry API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let salesUser: number;
  let storesUser: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  let createdId: number;
  let createdVersion: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = createApp(pool);
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=${companyId}`)).bu_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  it('creates an enquiry (201) with an auto-generated number', async () => {
    const res = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({
      customerName: 'Tata Projects Ltd', contact: 'R. Iyer', email: 'r.iyer@tp.com',
      address: 'Mumbai', industry: 'EPC', source: 'REFERRAL', requirement: '2x 50T EOT cranes',
    });
    expect(res.status).toBe(201);
    expect(res.body.enquiryNo).toMatch(/^ENQ\/MUM\//);
    expect(res.body.status).toBe('NEW');
    createdId = res.body.enquiryId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without ENQUIRY.CREATE (403)', async () => {
    const res = await request(app).post('/api/enquiries').set(hdr(storesUser)).send({ customerName: 'X' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing name / bad email', async () => {
    const r1 = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({ contact: 'No Name' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({ customerName: 'A', email: 'nope' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/enquiries');
    expect(res.status).toBe(401);
  });

  it('lists enquiries (200)', async () => {
    const res = await request(app).get('/api/enquiries?status=NEW').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/enquiries/${createdId}`).set(hdr(salesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.customerName).toBe('Tata Projects Ltd');
    const no = await request(app).get('/api/enquiries/99999999').set(hdr(salesUser));
    expect(no.status).toBe(404);
  });

  it('qualifies via a valid transition and blocks an invalid one', async () => {
    const ok = await request(app).post(`/api/enquiries/${createdId}/status`).set(hdr(salesUser))
      .send({ status: 'QUALIFIED', rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('QUALIFIED');
    const bad = await request(app).post(`/api/enquiries/${createdId}/status`).set(hdr(salesUser))
      .send({ status: 'CONVERTED', rowVersion: ok.body.rowVersion });
    expect(bad.status).toBe(409);
  });

  it('exports CSV (200) for ENQUIRY.EXPORT holders', async () => {
    const res = await request(app).get('/api/enquiries/export').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Enquiry No');
  });
});
