import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { portalRouter } from '../src/modules/portal/portal.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts portalRouter at /api/portal exactly as the composition root does
 * (createApp wires `app.use('/api/portal', portalRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * The portal AUTO-SCOPES to the caller's linkage: in beforeAll we link sales_user
 * to the test customer (CUST-TEST) and purchase_user to the test vendor
 * (VEND-TEST) via the sec.app_user.customer_id / vendor_id columns added in
 * migration 040. sales_user therefore acts as a CUSTOMER portal user (SALES holds
 * PORTAL.VC) and purchase_user as a VENDOR portal user (PURCHASE holds PORTAL.VC).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/portal', portalRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Portal API (integration) — customer/vendor self-service, auto-scoping, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let salesUser: number;     // linked to the customer -> customer portal user
  let purchaseUser: number;  // linked to the vendor   -> vendor portal user
  let customerId: number;
  let vendorId: number;
  let otherVendorId: number;
  let ownPoId: number;       // a PO belonging to VEND-TEST (acknowledge succeeds)
  let otherPoId: number;     // a PO belonging to another vendor (acknowledge 404s)

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
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    purchaseUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='purchase_user'`)).user_id);

    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    vendorId = Number((await one(
      `SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST' AND company_id=$1`, [companyId])).vendor_id);

    const currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);

    // A second vendor so an acknowledge of someone else's PO can be checked (404).
    otherVendorId = Number((await one(
      `INSERT INTO mdm.vendor (company_id, vendor_code, vendor_name, is_approved)
       VALUES ($1, 'VEND-PORTAL-OTHER', 'Other Vendor Pvt Ltd', true)
       ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = EXCLUDED.vendor_name
       RETURNING vendor_id`, [companyId])).vendor_id);

    // LINK the portal users to their partners (the access model under test). The
    // harness connects as the owning superuser, so RLS does not filter these.
    await pool.query(`UPDATE sec.app_user SET customer_id=$1, vendor_id=NULL WHERE username='sales_user'`, [customerId]);
    await pool.query(`UPDATE sec.app_user SET vendor_id=$1, customer_id=NULL WHERE username='purchase_user'`, [vendorId]);

    // A project + invoice + dispatch for the customer so the customer reads return rows.
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-PORTAL-TEST', 'Portal Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, salesUser]);
    const projectId = Number(proj.project_id);

    await pool.query(
      `INSERT INTO fin.invoice (company_id, invoice_no, project_id, customer_id, currency_id, total_amount, status)
       VALUES ($1, 'INV-PORTAL-TEST', $2, $3, $4, 5000, 'SENT')
       ON CONFLICT (invoice_no) DO NOTHING`, [companyId, projectId, customerId, currencyId]);

    await pool.query(
      `INSERT INTO log.dispatch (company_id, dispatch_no, project_id, customer_id, status)
       VALUES ($1, 'DSP-PORTAL-TEST', $2, $3, 'RELEASED')
       ON CONFLICT (dispatch_no) DO NOTHING`, [companyId, projectId, customerId]);

    // Two POs: one for VEND-TEST (ack succeeds), one for the other vendor (ack 404s).
    ownPoId = Number((await one(
      `INSERT INTO scm.purchase_order (company_id, po_no, vendor_id, currency_id, total_amount, status)
       VALUES ($1, 'PO-PORTAL-OWN', $2, $3, 12000, 'APPROVED')
       ON CONFLICT (po_no) DO UPDATE SET total_amount = EXCLUDED.total_amount
       RETURNING po_id`, [companyId, vendorId, currencyId])).po_id);
    otherPoId = Number((await one(
      `INSERT INTO scm.purchase_order (company_id, po_no, vendor_id, currency_id, total_amount, status)
       VALUES ($1, 'PO-PORTAL-OTHER', $2, $3, 7000, 'APPROVED')
       ON CONFLICT (po_no) DO UPDATE SET total_amount = EXCLUDED.total_amount
       RETURNING po_id`, [companyId, otherVendorId, currencyId])).po_id);

    // A GRN + a vendor payment for VEND-TEST so those vendor reads return rows.
    await pool.query(
      `INSERT INTO scm.goods_receipt (company_id, grn_no, po_id, vendor_id, status)
       VALUES ($1, 'GRN-PORTAL-TEST', $2, $3, 'POSTED')
       ON CONFLICT (grn_no) DO NOTHING`, [companyId, ownPoId, vendorId]);
    await pool.query(
      `INSERT INTO fin.vendor_payment (company_id, vpay_no, vendor_id, amount)
       VALUES ($1, 'VPAY-PORTAL-TEST', $2, 3000)
       ON CONFLICT (vpay_no) DO NOTHING`, [companyId, vendorId]);
  });

  afterAll(async () => {
    // Unlink the shared seed users so other suites see them as internal users again.
    await pool.query(`UPDATE sec.app_user SET customer_id=NULL, vendor_id=NULL WHERE username IN ('sales_user','purchase_user')`);
    await pool.end();
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/portal/me');
    expect(res.status).toBe(401);
  });

  // --- as the customer-linked caller (sales_user) ---

  it('GET /me -> kind customer for the customer-linked caller', async () => {
    const res = await request(app).get('/api/portal/me').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('customer');
    expect(res.body.customerId).toBe(customerId);
    expect(res.body.name).toBe('Test Customer Ltd');
  });

  it('GET /projects, /dispatches, /invoices, /tickets -> 200 (auto-scoped)', async () => {
    const projects = await request(app).get('/api/portal/projects').set(hdr(salesUser));
    expect(projects.status).toBe(200);
    expect(Array.isArray(projects.body)).toBe(true);
    expect(projects.body.some((p: { projectNo: string }) => p.projectNo === 'PRJ-PORTAL-TEST')).toBe(true);

    const dispatches = await request(app).get('/api/portal/dispatches').set(hdr(salesUser));
    expect(dispatches.status).toBe(200);
    expect(dispatches.body.some((d2: { dispatchNo: string }) => d2.dispatchNo === 'DSP-PORTAL-TEST')).toBe(true);

    const invoices = await request(app).get('/api/portal/invoices').set(hdr(salesUser));
    expect(invoices.status).toBe(200);
    expect(Array.isArray(invoices.body.rows)).toBe(true);
    expect(invoices.body.outstandingTotal).toBeGreaterThanOrEqual(5000);

    const tickets = await request(app).get('/api/portal/tickets').set(hdr(salesUser));
    expect(tickets.status).toBe(200);
    expect(Array.isArray(tickets.body)).toBe(true);
  });

  it('POST /tickets -> 201 with an auto-generated TKT number, OPEN', async () => {
    const res = await request(app).post('/api/portal/tickets').set(hdr(salesUser))
      .send({ priority: 'HIGH', subject: 'Pump is leaking on site' });
    expect(res.status).toBe(201);
    expect(res.body.ticketNo).toMatch(/^TKT\//);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.priority).toBe('HIGH');
  });

  it('denies a customer caller the VENDOR endpoints (403)', async () => {
    const po = await request(app).get('/api/portal/purchase-orders').set(hdr(salesUser));
    expect(po.status).toBe(403);
  });

  // --- as the vendor-linked caller (purchase_user) ---

  it('GET /me -> kind vendor for the vendor-linked caller', async () => {
    const res = await request(app).get('/api/portal/me').set(hdr(purchaseUser));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('vendor');
    expect(res.body.vendorId).toBe(vendorId);
  });

  it('GET /purchase-orders, /grns, /payments -> 200 (auto-scoped to the vendor)', async () => {
    const po = await request(app).get('/api/portal/purchase-orders').set(hdr(purchaseUser));
    expect(po.status).toBe(200);
    expect(po.body.some((p: { poNo: string }) => p.poNo === 'PO-PORTAL-OWN')).toBe(true);
    // the other vendor's PO must NOT be visible
    expect(po.body.some((p: { poNo: string }) => p.poNo === 'PO-PORTAL-OTHER')).toBe(false);

    const grns = await request(app).get('/api/portal/grns').set(hdr(purchaseUser));
    expect(grns.status).toBe(200);
    expect(grns.body.some((g: { grnNo: string }) => g.grnNo === 'GRN-PORTAL-TEST')).toBe(true);

    const payments = await request(app).get('/api/portal/payments').set(hdr(purchaseUser));
    expect(payments.status).toBe(200);
    expect(payments.body.some((p: { vpayNo: string }) => p.vpayNo === 'VPAY-PORTAL-TEST')).toBe(true);
  });

  it('POST /purchase-orders/:id/acknowledge -> 200 on the vendor own PO', async () => {
    const res = await request(app).post(`/api/portal/purchase-orders/${ownPoId}/acknowledge`).set(hdr(purchaseUser));
    expect(res.status).toBe(200);
    expect(res.body.poId).toBe(ownPoId);
    expect(res.body.acknowledgedAt).not.toBeNull();
  });

  it('POST /purchase-orders/:id/acknowledge -> 404 on another vendor PO', async () => {
    const res = await request(app).post(`/api/portal/purchase-orders/${otherPoId}/acknowledge`).set(hdr(purchaseUser));
    expect(res.status).toBe(404);
  });

  it('denies a vendor caller the CUSTOMER endpoints (403)', async () => {
    const projects = await request(app).get('/api/portal/projects').set(hdr(purchaseUser));
    expect(projects.status).toBe(403);
  });
});
