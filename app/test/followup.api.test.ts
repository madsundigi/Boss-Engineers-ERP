import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { enquiryRouter } from '../src/modules/enquiry/enquiry.routes';
import { followupRouter } from '../src/modules/followup/followup.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * Covers the enquiry deal-assignment + follow-up trail feature: assign surfaces
 * assignedTo/assignedToName; the trail auto-increments seq; VIRTUAL requires a
 * channel and PHYSICAL a location; PATCH DONE stamps completedAt (409 on a stale
 * row version); the alerting dashboard returns PENDING rows with a derived
 * urgency + summary; a past-dated follow-up reads 'MISSED', today reads 'DUE'.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/enquiries', enquiryRouter(pool));
  app.use('/api/followups', followupRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Follow-up API (integration) — assignment + follow-up trail, urgency, RBAC', () => {
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

  let enquiryId: number;       // throwaway enquiry the trail hangs off
  let followupId: number;      // the first follow-up created via the API
  let followupVersion: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);

    // A throwaway enquiry to attach the follow-up trail to (created via the API
    // so the gapless enquiry_no is allocated exactly like production).
    const enq = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({
      customerName: 'Follow-up Trail Co', source: 'WEB',
    });
    enquiryId = enq.body.enquiryId;
  });

  afterAll(async () => { await pool.end(); });

  // ---------------------------------------------------------------------------
  // A) Enquiry assignment
  // ---------------------------------------------------------------------------

  it('assigns the enquiry to a salesperson (assignedTo + assignedToName surface)', async () => {
    const res = await request(app).post(`/api/enquiries/${enquiryId}/assign`).set(hdr(salesUser))
      .send({ userId: salesUser });
    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toBe(salesUser);
    expect(typeof res.body.assignedToName).toBe('string');
    expect(res.body.assignedToName.length).toBeGreaterThan(0);

    // the projection also surfaces assignedTo on a plain GET
    const got = await request(app).get(`/api/enquiries/${enquiryId}`).set(hdr(salesUser));
    expect(got.body.assignedTo).toBe(salesUser);
  });

  it('rejects assigning to a non-existent / inactive user (400)', async () => {
    const res = await request(app).post(`/api/enquiries/${enquiryId}/assign`).set(hdr(salesUser))
      .send({ userId: 99999999 });
    expect(res.status).toBe(400);
  });

  it('409s an assign with a stale rowVersion', async () => {
    const res = await request(app).post(`/api/enquiries/${enquiryId}/assign`).set(hdr(salesUser))
      .send({ userId: salesUser, rowVersion: 1 });
    expect(res.status).toBe(409);
  });

  it('denies assign without ENQUIRY.EDIT (stores_user -> 403)', async () => {
    const res = await request(app).post(`/api/enquiries/${enquiryId}/assign`).set(hdr(storesUser))
      .send({ userId: salesUser });
    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // B) Follow-up trail — create / seq / validation
  // ---------------------------------------------------------------------------

  it('creates follow-up #1 (seq=1, PENDING) and inherits the enquiry owner', async () => {
    const res = await request(app).post('/api/followups').set(hdr(salesUser)).send({
      enquiryId, followupType: 'VIRTUAL', channel: 'WHATSAPP',
      scheduledDate: '2026-08-01', notes: 'Intro message',
    });
    expect(res.status).toBe(201);
    expect(res.body.seq).toBe(1);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.followupType).toBe('VIRTUAL');
    expect(res.body.channel).toBe('WHATSAPP');
    expect(res.body.enquiryId).toBe(enquiryId);
    expect(res.body.enquiryNo).toMatch(/^ENQ\/MUM\//);
    expect(res.body.customerName).toBe('Follow-up Trail Co');
    expect(res.body.assignedTo).toBe(salesUser); // defaulted from the enquiry
    expect(res.body.assignedToName.length).toBeGreaterThan(0);
    followupId = res.body.followupId;
    followupVersion = res.body.rowVersion;
  });

  it('creates follow-up #2 (seq increments to 2)', async () => {
    const res = await request(app).post('/api/followups').set(hdr(salesUser)).send({
      enquiryId, followupType: 'PHYSICAL', location: 'Client HQ, Pune',
      scheduledDate: '2026-08-10',
    });
    expect(res.status).toBe(201);
    expect(res.body.seq).toBe(2);
    expect(res.body.followupType).toBe('PHYSICAL');
    expect(res.body.location).toBe('Client HQ, Pune');
  });

  it('rejects a VIRTUAL follow-up with no channel (400)', async () => {
    const res = await request(app).post('/api/followups').set(hdr(salesUser)).send({
      enquiryId, followupType: 'VIRTUAL', scheduledDate: '2026-08-15',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a PHYSICAL follow-up with no location (400)', async () => {
    const res = await request(app).post('/api/followups').set(hdr(salesUser)).send({
      enquiryId, followupType: 'PHYSICAL', scheduledDate: '2026-08-15',
    });
    expect(res.status).toBe(400);
  });

  it('404s a follow-up created against an unknown enquiry', async () => {
    const res = await request(app).post('/api/followups').set(hdr(salesUser)).send({
      enquiryId: 99999999, followupType: 'VIRTUAL', channel: 'EMAIL', scheduledDate: '2026-08-15',
    });
    expect(res.status).toBe(404);
  });

  it('denies create without ENQUIRY.EDIT (stores_user -> 403)', async () => {
    const res = await request(app).post('/api/followups').set(hdr(storesUser)).send({
      enquiryId, followupType: 'VIRTUAL', channel: 'EMAIL', scheduledDate: '2026-08-15',
    });
    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // B) Follow-up trail — list
  // ---------------------------------------------------------------------------

  it('lists the trail for the enquiry ordered by seq', async () => {
    const res = await request(app).get(`/api/followups?enquiryId=${enquiryId}`).set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(res.body.rows[0].seq).toBe(1);
    expect(res.body.rows[1].seq).toBe(2);
    // every read carries the derived urgency
    expect(res.body.rows[0].urgency).toBeDefined();
  });

  it('requires enquiryId on the list (400) and authentication (401)', async () => {
    const noParam = await request(app).get('/api/followups').set(hdr(salesUser));
    expect(noParam.status).toBe(400);
    const noAuth = await request(app).get(`/api/followups?enquiryId=${enquiryId}`);
    expect(noAuth.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // B) Follow-up trail — PATCH (complete + optimistic lock)
  // ---------------------------------------------------------------------------

  it('PATCH DONE stamps completedAt and 409s on a stale rowVersion', async () => {
    const done = await request(app).patch(`/api/followups/${followupId}`).set(hdr(salesUser))
      .send({ status: 'DONE', outcome: 'Customer responded, keen', rowVersion: followupVersion });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedAt).not.toBeNull();
    expect(done.body.outcome).toBe('Customer responded, keen');
    expect(done.body.urgency).toBe('DONE'); // DONE short-circuits the urgency CASE

    // the original version is now stale
    const stale = await request(app).patch(`/api/followups/${followupId}`).set(hdr(salesUser))
      .send({ status: 'CANCELLED', rowVersion: followupVersion });
    expect(stale.status).toBe(409);
  });

  it('404s a PATCH against an unknown follow-up', async () => {
    const res = await request(app).patch('/api/followups/99999999').set(hdr(salesUser))
      .send({ status: 'CANCELLED', rowVersion: 1 });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // B) Dashboard + derived urgency (MISSED / DUE)
  // ---------------------------------------------------------------------------

  it('dashboard returns PENDING rows with urgency + a summary; past=MISSED, today=DUE', async () => {
    // Seed two deterministic PENDING follow-ups on the throwaway enquiry: one
    // dated in the past (-> MISSED) and one dated today (-> DUE). The owning
    // superuser connection bypasses RLS, so company_id is set explicitly. seq is
    // allocated as max+1 to respect uq_enquiry_followup_seq.
    const seed = async (scheduled: string): Promise<number> => {
      const r = await pool.query(
        `INSERT INTO sales.enquiry_followup
           (company_id, bu_id, enquiry_id, seq, followup_type, channel, scheduled_date,
            status, assigned_to, created_by)
         VALUES ($1,$2,$3,
            COALESCE((SELECT max(seq) FROM sales.enquiry_followup WHERE enquiry_id=$3 AND NOT is_deleted),0)+1,
            'VIRTUAL','EMAIL',$4::date,'PENDING',$5,$5)
         RETURNING followup_id`,
        [companyId, buId, enquiryId, scheduled, salesUser]);
      return Number(r.rows[0].followup_id);
    };
    const missedId = await seed('2020-01-01');                 // long past
    const today = new Date().toISOString().slice(0, 10);       // YYYY-MM-DD
    const dueId = await seed(today);

    const res = await request(app).get('/api/followups/dashboard').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.summary).toEqual(expect.objectContaining({
      due: expect.any(Number), upcoming: expect.any(Number), missed: expect.any(Number),
    }));
    // rows are ordered by scheduled_date ASC (camelCase scheduledDate on the wire).
    const dates = (res.body.rows as Array<{ scheduledDate: string }>).map((r) => r.scheduledDate);
    expect(dates).toEqual([...dates].sort());

    const byId = (id: number) =>
      (res.body.rows as Array<{ followupId: number; urgency: string; daysRemaining: number }>)
        .find((r) => r.followupId === id);
    const missed = byId(missedId);
    const due = byId(dueId);
    expect(missed).toBeDefined();
    expect(missed!.urgency).toBe('MISSED');
    expect(missed!.daysRemaining).toBeLessThan(0);
    expect(due).toBeDefined();
    expect(due!.urgency).toBe('DUE');
    expect(due!.daysRemaining).toBe(0);

    // the summary counted at least our two seeded urgencies
    expect(res.body.summary.missed).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.due).toBeGreaterThanOrEqual(1);
  });

  it('dashboard?mine=true scopes to the caller and stores_user (no ENQUIRY.VIEW) is denied 403', async () => {
    const mine = await request(app).get('/api/followups/dashboard?mine=true').set(hdr(salesUser));
    expect(mine.status).toBe(200);
    // every returned row is owned by the caller
    for (const r of mine.body.rows as Array<{ assignedTo: number }>) {
      expect(r.assignedTo).toBe(salesUser);
    }
    const denied = await request(app).get('/api/followups/dashboard').set(hdr(storesUser));
    expect(denied.status).toBe(403);
  });
});
