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
      mobile: '+91 98200 11122', machineType: 'EOT Crane', application: 'Steel plant bay',
      quantity: 2, budget: 1500000, salesExecutive: 'S. Mehta', followUpDate: '2026-07-15',
      remarks: 'Site visit pending',
    });
    expect(res.status).toBe(201);
    expect(res.body.enquiryNo).toMatch(/^ENQ\/MUM\//);
    expect(res.body.status).toBe('NEW');
    // the additional intake fields round-trip through create
    expect(res.body.machineType).toBe('EOT Crane');
    expect(res.body.quantity).toBe(2);
    expect(res.body.budget).toBe(1500000);
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
    // QUALIFIED -> WON is not a legal transition (must go via QUOTED first).
    const bad = await request(app).post(`/api/enquiries/${createdId}/status`).set(hdr(salesUser))
      .send({ status: 'WON', rowVersion: ok.body.rowVersion });
    expect(bad.status).toBe(409);
  });

  it('exports CSV (200) for ENQUIRY.EXPORT holders', async () => {
    const res = await request(app).get('/api/enquiries/export').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Enquiry No');
  });

  describe('list filters (multi-field, AND-combined)', () => {
    // A per-run stamp keeps the fixtures idempotent: every run seeds fresh rows
    // and every assertion is scoped to this stamp, so rows from earlier runs (or
    // the suite above) never leak into the counts.
    const stamp = `F${Date.now()}`;
    const mtAlpha = `${stamp}-ALPHA`;
    const mtBeta = `${stamp}-BETA`;
    let alphaId: number; // machineType=ALPHA, customer A, follow-up 2026-08-01, assigned salesUser
    let betaId: number; //  machineType=BETA,  customer B, follow-up 2026-09-15, assigned storesUser, then QUALIFIED

    const seed = async (over: Record<string, unknown>) => {
      const res = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({
        customerName: 'seed', source: 'WEB', ...over,
      });
      expect(res.status).toBe(201);
      return res.body as { enquiryId: number; rowVersion: number };
    };

    beforeAll(async () => {
      const a = await seed({
        customerName: `${stamp} Alpha Customer`, machineType: mtAlpha, followUpDate: '2026-08-01',
      });
      alphaId = a.enquiryId;
      const b = await seed({
        customerName: `${stamp} Beta Customer`, machineType: mtBeta, followUpDate: '2026-09-15',
      });
      betaId = b.enquiryId;
      // assigned_to: alpha -> salesUser, beta -> storesUser (exact-match filter target)
      const asgA = await request(app).post(`/api/enquiries/${alphaId}/assign`).set(hdr(salesUser)).send({ userId: salesUser });
      expect(asgA.status).toBe(200);
      const asgB = await request(app).post(`/api/enquiries/${betaId}/assign`).set(hdr(salesUser)).send({ userId: storesUser });
      expect(asgB.status).toBe(200);
      // give beta a non-NEW status so the status+machineType combo test is meaningful
      const qual = await request(app).post(`/api/enquiries/${betaId}/status`).set(hdr(salesUser))
        .send({ status: 'QUALIFIED', rowVersion: asgB.body.rowVersion });
      expect(qual.status).toBe(200);
    });

    const list = (qs: string) =>
      request(app).get(`/api/enquiries?pageSize=200&${qs}`).set(hdr(salesUser));

    it('machineType is a partial, case-insensitive match', async () => {
      const res = await list(`machineType=${mtAlpha.toLowerCase()}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId]);
      expect(res.body.rows[0].machineType).toBe(mtAlpha);
    });

    it('enquiryNo narrows by partial enquiry number', async () => {
      const full = (await request(app).get(`/api/enquiries/${alphaId}`).set(hdr(salesUser))).body.enquiryNo as string;
      const frag = full.slice(-6); // gapless serial tail is unique to this row
      const res = await list(`enquiryNo=${encodeURIComponent(frag)}`);
      expect(res.status).toBe(200);
      expect(res.body.rows.map((r: any) => r.enquiryId)).toContain(alphaId);
      expect(res.body.rows.every((r: any) => r.enquiryNo.includes(frag))).toBe(true);
    });

    it('customerName is a partial, case-insensitive match', async () => {
      // scope to this run's two rows via the stamp, then narrow by the per-row token
      const both = await list(`customerName=${stamp}`);
      expect(both.body.total).toBe(2);
      const res = await list(`customerName=${stamp} alpha`);
      expect(res.body.total).toBe(1);
      expect(res.body.rows[0].enquiryId).toBe(alphaId);
    });

    it('assignedTo is an exact assignee-id match', async () => {
      const sales = await list(`customerName=${stamp}&assignedTo=${salesUser}`);
      expect(sales.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId]);
      expect(sales.body.rows[0].assignedTo).toBe(salesUser);
      const stores = await list(`customerName=${stamp}&assignedTo=${storesUser}`);
      expect(stores.body.rows.map((r: any) => r.enquiryId)).toEqual([betaId]);
    });

    it('followUpFrom / followUpTo bound the follow-up date (inclusive)', async () => {
      const from = await list(`customerName=${stamp}&followUpFrom=2026-09-01`);
      expect(from.body.rows.map((r: any) => r.enquiryId)).toEqual([betaId]);
      const to = await list(`customerName=${stamp}&followUpTo=2026-08-31`);
      expect(to.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId]);
      // inclusive endpoints: a window covering exactly 2026-08-01 keeps alpha
      const window = await list(`customerName=${stamp}&followUpFrom=2026-08-01&followUpTo=2026-08-01`);
      expect(window.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId]);
    });

    it('combines two filters with AND (machineType + status)', async () => {
      // beta is QUALIFIED with mtBeta -> matches; alpha is NEW -> excluded by status
      const hit = await list(`machineType=${stamp}&status=QUALIFIED`);
      expect(hit.body.rows.map((r: any) => r.enquiryId)).toEqual([betaId]);
      // alpha's machineType with QUALIFIED status matches nothing (alpha is NEW)
      const miss = await list(`machineType=${mtAlpha}&status=QUALIFIED`);
      expect(miss.body.total).toBe(0);
    });

    it('accepts the new sort columns (machine_type, follow_up_date)', async () => {
      const byFollowUp = await list(`customerName=${stamp}&sort=follow_up_date&dir=asc`);
      expect(byFollowUp.status).toBe(200);
      expect(byFollowUp.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId, betaId]);
      const byMachine = await list(`customerName=${stamp}&sort=machine_type&dir=asc`);
      expect(byMachine.status).toBe(200);
      expect(byMachine.body.rows.map((r: any) => r.enquiryId)).toEqual([alphaId, betaId]);
    });
  });

  it('RLS isolates tenants even on an unfiltered query (BUG-01 fix)', async () => {
    // Under the erp_app role, an UNFILTERED scan still returns 0 rows for a
    // different company and >0 for the correct one — proving RLS is enforced,
    // not just the app-level WHERE company_id filter.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE erp_app');
      await c.query(`SELECT set_config('app.company_id', '999999', true)`);
      const wrong = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM sales.enquiry');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [String(companyId)]);
      const right = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM sales.enquiry');
      await c.query('COMMIT');
      expect(wrong.rows[0].n).toBe(0);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      c.release();
    }
  });
});
