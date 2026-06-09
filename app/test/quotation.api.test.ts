import request from 'supertest';
import { Pool } from 'pg';
import { Express } from 'express';
import { createApp } from '../src/app';
import { OutboxTransport } from '../src/services/email.service';
import { OutboxRelay } from '../src/outbox/relay';

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  res.setEncoding('binary'); let data = '';
  res.on('data', (c: string) => (data += c));
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
}

d('Quotation API (integration) — versioning, approval, PDF, email, enquiry sync', () => {
  let pool: Pool; let app: Express; let outbox: OutboxTransport;
  let companyId: number, buId: number, sales: number, finance: number, dual: number;
  let enqId: number, quoteId: number, v: number;

  const hdr = (u: number) => ({ 'x-user-id': String(u), 'x-company-id': String(companyId), 'x-bu-id': String(buId) });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    outbox = new OutboxTransport();
    app = createApp(pool, { emailTransport: outbox });
    const one = async (s: string) => (await pool.query(s)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=${companyId}`)).bu_id);
    sales = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    finance = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    dual = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='dual_user'`)).user_id);

    // a QUALIFIED enquiry to quote from
    const e = await request(app).post('/api/enquiries').set(hdr(sales))
      .send({ customerName: 'Tata Projects Ltd', email: 'r.iyer@tp.com', requirement: '2x 50T EOT cranes' });
    enqId = e.body.enquiryId;
    await request(app).post(`/api/enquiries/${enqId}/status`).set(hdr(sales)).send({ status: 'QUALIFIED', rowVersion: e.body.rowVersion });
  });

  afterAll(async () => { await pool.end(); });

  it('converts a QUALIFIED enquiry into a DRAFT quotation and syncs the enquiry to QUOTED', async () => {
    const res = await request(app).post(`/api/quotations/from-enquiry/${enqId}`).set(hdr(sales)).send({});
    expect(res.status).toBe(201);
    expect(res.body.quotationNo).toMatch(/^QTN\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.enquiryId).toBe(enqId);
    quoteId = res.body.quotationId; v = res.body.rowVersion;
    const enq = await request(app).get(`/api/enquiries/${enqId}`).set(hdr(sales));
    expect(enq.body.status).toBe('QUOTED');
  });

  it('prices the quote from lines and discount', async () => {
    const res = await request(app).patch(`/api/quotations/${quoteId}`).set(hdr(sales)).send({
      rowVersion: v, totalCost: 8000000, discountPct: 5,
      lines: [{ description: 'EOT Crane 50T', qty: 2, unitPrice: 5000000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalPrice).toBe(9500000); // 10,000,000 less 5%
    expect(res.body.marginPct).toBeCloseTo(15.79, 1);
    v = res.body.rowVersion;
  });

  it('round-trips commercial terms (taxPct + warranty/delivery/payment) on create', async () => {
    const res = await request(app).post('/api/quotations').set(hdr(sales)).send({
      customerName: 'Terms Co', totalCost: 100, discountPct: 0,
      taxPct: 18, deliveryTerms: 'Ex-works 6 weeks', paymentTerms: '50% advance, 50% on delivery',
      warrantyTerms: '12 months from commissioning',
      lines: [{ description: 'Hoist 5T', qty: 1, unitPrice: 200 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.taxPct).toBe(18);
    expect(res.body.warrantyTerms).toBe('12 months from commissioning');
    expect(res.body.deliveryTerms).toBe('Ex-works 6 weeks');
    expect(res.body.paymentTerms).toBe('50% advance, 50% on delivery');
  });

  it('submits for approval', async () => {
    const res = await request(app).post(`/api/quotations/${quoteId}/submit`).set(hdr(sales)).send({ rowVersion: v });
    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('PENDING_APPROVAL');
    expect(typeof res.body.requiresApproval).toBe('boolean');
    v = res.body.quotation.rowVersion;
  });

  it('blocks approval without QUOTATION.APPROVE (sales -> 403), allows finance', async () => {
    const denied = await request(app).post(`/api/quotations/${quoteId}/approve`).set(hdr(sales)).send({ rowVersion: v });
    expect(denied.status).toBe(403);
    const ok = await request(app).post(`/api/quotations/${quoteId}/approve`).set(hdr(finance)).send({ rowVersion: v });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    v = ok.body.rowVersion;
  });

  it('blocks self-approval — Segregation of Duties (creator approves own quote -> 403)', async () => {
    // dual_user holds BOTH SALES (create/edit) and FINANCE (approve) roles — the only
    // way one user can both create and approve. Standard roles can't (FINANCE has no
    // CREATE), so this is the case the code-level SoD check defends against.
    const created = await request(app).post('/api/quotations').set(hdr(dual)).send({
      customerName: 'SoD Test Co', totalCost: 100, discountPct: 0,
      lines: [{ description: 'Widget', qty: 1, unitPrice: 200 }],
    });
    expect(created.status).toBe(201);
    const sodId = created.body.quotationId; let sodV = created.body.rowVersion;

    const submitted = await request(app).post(`/api/quotations/${sodId}/submit`).set(hdr(dual)).send({ rowVersion: sodV });
    expect(submitted.status).toBe(200);
    expect(submitted.body.quotation.status).toBe('PENDING_APPROVAL');
    sodV = submitted.body.quotation.rowVersion;

    // same user that created it tries to approve -> 403 (SoD), despite holding APPROVE.
    const self = await request(app).post(`/api/quotations/${sodId}/approve`).set(hdr(dual)).send({ rowVersion: sodV });
    expect(self.status).toBe(403);
  });

  it('sends the quotation — marks SENT, queues delivery, relay emails the PDF (transactional outbox)', async () => {
    const res = await request(app).post(`/api/quotations/${quoteId}/send`).set(hdr(sales)).send({ rowVersion: v });
    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('SENT');
    expect(res.body.queued).toBe(true);
    v = res.body.quotation.rowVersion;

    // email has NOT been sent yet — it's queued in the outbox, dispatched after commit.
    const before = outbox.outbox.length;
    await (app.locals.outboxRelay as OutboxRelay).drain();
    expect(outbox.outbox.length).toBe(before + 1);
    const msg = outbox.outbox[outbox.outbox.length - 1];
    expect(msg.attachments?.[0].filename).toMatch(/\.pdf$/);
    expect(msg.attachments?.[0].content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('serves the PDF document', async () => {
    const res = await request(app).get(`/api/quotations/${quoteId}/pdf`).set(hdr(sales)).buffer().parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('marks WON and syncs the enquiry to CONVERTED', async () => {
    const res = await request(app).post(`/api/quotations/${quoteId}/won`).set(hdr(sales)).send({ rowVersion: v });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('WON');
    const enq = await request(app).get(`/api/enquiries/${enqId}`).set(hdr(sales));
    expect(enq.body.status).toBe('CONVERTED');
    v = res.body.rowVersion;
  });

  it('keeps a revision history and refuses to revise a WON quote', async () => {
    const revs = await request(app).get(`/api/quotations/${quoteId}/revisions`).set(hdr(sales));
    expect(revs.status).toBe(200);
    expect(Array.isArray(revs.body)).toBe(true);
    expect(revs.body.length).toBeGreaterThanOrEqual(1);
    const bad = await request(app).post(`/api/quotations/${quoteId}/revise`).set(hdr(sales)).send({ rowVersion: v, reason: 'x' });
    expect(bad.status).toBe(409);
  });
});
