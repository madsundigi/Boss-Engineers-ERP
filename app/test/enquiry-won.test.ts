import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';
import { OutboxRelay } from '../src/outbox/relay';

/**
 * Cross-module trigger: an enquiry reaching WON (via the API) -> auto-seed a
 * Project FROM the enquiry. Walks NEW -> QUALIFIED -> QUOTED -> WON over HTTP so
 * the 'enquiry.won' outbox event is emitted in the same tx as the WON UPDATE,
 * then drains the relay and asserts a proj.project carrying that enquiry_id
 * exists — and that a re-drive (idempotency on enquiry_id) does NOT duplicate it.
 * Runs only when DATABASE_URL is set.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('enquiry.won -> Project auto-seed (cross-module outbox)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let salesUser: number;
  let enqId: number;
  let machineType: string;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = createApp(pool);
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=${companyId}`)).bu_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // A stamped machine_type so the seeded project name is recognizable and unique.
    machineType = `WONMACH-${Date.now()}`;
    const e = await request(app).post('/api/enquiries').set(hdr(salesUser)).send({
      customerName: `WON Lead ${Date.now()}`, email: 'won.lead@example.com',
      machineType,
    });
    expect(e.status).toBe(201);
    enqId = e.body.enquiryId;
    let v = e.body.rowVersion;

    // NEW -> QUALIFIED -> QUOTED (each transition bumps row_version).
    const qual = await request(app).post(`/api/enquiries/${enqId}/status`).set(hdr(salesUser))
      .send({ status: 'QUALIFIED', rowVersion: v });
    expect(qual.status).toBe(200); v = qual.body.rowVersion;
    const quoted = await request(app).post(`/api/enquiries/${enqId}/status`).set(hdr(salesUser))
      .send({ status: 'QUOTED', rowVersion: v });
    expect(quoted.status).toBe(200); v = quoted.body.rowVersion;

    // QUOTED -> WON: this emits enquiry.won in the same tx as the status UPDATE.
    const won = await request(app).post(`/api/enquiries/${enqId}/status`).set(hdr(salesUser))
      .send({ status: 'WON', rowVersion: v });
    expect(won.status).toBe(200);
    expect(won.body.status).toBe('WON');
  });

  afterAll(async () => { await pool.end(); });

  it('seeds a Project FROM the enquiry after the relay drains the event', async () => {
    // No project yet — the handler runs only when the outbox relay drains.
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM proj.project WHERE enquiry_id = $1 AND company_id = $2`,
      [enqId, companyId]);
    expect(before.rows[0].n).toBe(0);

    await (app.locals.outboxRelay as OutboxRelay).drain();

    const res = await pool.query(
      `SELECT project_no, project_name, customer_id, contract_value, quotation_id, status
         FROM proj.project WHERE enquiry_id = $1 AND company_id = $2`,
      [enqId, companyId]);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].project_no).toMatch(/^PRJ\//);
    expect(res.rows[0].project_name).toBe(machineType);   // machine_type -> project name
    // contract_value = enquiry.target_value || 0; the intake API never sets
    // target_value, so a lead-sourced project starts at 0 (priced later).
    expect(Number(res.rows[0].contract_value)).toBe(0);
    expect(res.rows[0].quotation_id).toBeNull();          // seeded from the enquiry, not a quote
    expect(res.rows[0].status).toBe('PLANNING');
    expect(Number(res.rows[0].customer_id)).toBeGreaterThan(0); // free-text lead promoted to a master
  });

  it('is idempotent — re-draining does not create a second project', async () => {
    // Re-enqueue + re-drive the same event; the enquiry_id probe must short-circuit.
    await pool.query(
      `INSERT INTO mdm.outbox_event (event_type, aggregate_type, aggregate_id, company_id, payload, created_by)
       VALUES ('enquiry.won', 'ENQUIRY', $1, $2, $3, $4)`,
      [enqId, companyId, JSON.stringify({ enquiryId: enqId }), salesUser]);
    await (app.locals.outboxRelay as OutboxRelay).drain();

    const res = await pool.query(
      `SELECT count(*)::int AS n FROM proj.project WHERE enquiry_id = $1 AND company_id = $2`,
      [enqId, companyId]);
    expect(res.rows[0].n).toBe(1);
  });
});
