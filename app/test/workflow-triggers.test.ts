import { Pool } from 'pg';
import { OutboxRecord } from '../src/outbox/outbox';
import { fatPassedClearQualityHandler } from '../src/modules/dispatch/dispatch.handlers';
import { dispatchReleasedWarrantyHandler } from '../src/modules/service/service.handlers';
import { installationAcceptedBillingHandler } from '../src/modules/billing/billing.handlers';

/**
 * Cross-module workflow triggers (FRD §5/§7). Runs only when DATABASE_URL is set.
 * Each test seeds the source rows directly (owner bypasses RLS), invokes the
 * handler, asserts the downstream effect, then asserts re-delivery is idempotent.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Cross-module workflow triggers', () => {
  let pool: Pool;
  let companyId: number; let buId: number; let customerId: number; let projectId: number;
  let qcUser: number; let installUser: number; let financeUser: number;

  const rec = (over: Partial<OutboxRecord>): OutboxRecord => ({
    eventId: 1, eventType: 'x', aggregateType: 'X', aggregateId: 1, companyId,
    payload: {}, attempts: 0, maxAttempts: 5, createdBy: qcUser, ...over,
  });
  const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const itemId = `(SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST' LIMIT 1)`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    customerId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    installUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='install_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    projectId = Number((await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1,'PRJ-WF-TEST','Workflow Test',$2,$3,'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name=EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, qcUser])).project_id);
  });
  afterAll(async () => { await pool.end(); });

  it('fat.passed opens the linked DRAFT dispatch quality gate (idempotent)', async () => {
    const protoId = Number((await one(
      `INSERT INTO qms.fat_protocol (company_id, protocol_code, protocol_name)
       VALUES ($1,$2,'WF Test Protocol') RETURNING protocol_id`, [companyId, `FATP/WF/${Date.now()}`])).protocol_id);
    const fatId = Number((await one(
      `INSERT INTO qms.fat_execution (company_id, fat_no, project_id, protocol_id)
       VALUES ($1,$2,$3,$4) RETURNING fat_id`, [companyId, `FAT/WF/${Date.now()}`, projectId, protoId])).fat_id);
    const dispId = Number((await one(
      `INSERT INTO log.dispatch (company_id, bu_id, dispatch_no, project_id, customer_id, fat_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'DRAFT') RETURNING dispatch_id`,
      [companyId, buId, `DSP/WFQ/${Date.now()}`, projectId, customerId, fatId])).dispatch_id);

    await fatPassedClearQualityHandler(pool)(rec({ eventType: 'fat.passed', aggregateType: 'FAT', aggregateId: fatId, createdBy: qcUser }));
    expect(Number((await one(`SELECT quality_cleared_by FROM log.dispatch WHERE dispatch_id=$1`, [dispId])).quality_cleared_by)).toBe(qcUser);

    await fatPassedClearQualityHandler(pool)(rec({ aggregateId: fatId, createdBy: qcUser }));
    expect(Number((await one(`SELECT quality_cleared_by FROM log.dispatch WHERE dispatch_id=$1`, [dispId])).quality_cleared_by)).toBe(qcUser);
  });

  it('dispatch.released starts a warranty per shipped serial (idempotent)', async () => {
    const serialId = Number((await one(
      `INSERT INTO scm.serial_number (item_id, serial_no, project_id, status)
       VALUES (${itemId}, $1, $2, 'DISPATCHED') RETURNING serial_id`, [`SN-WF-${Date.now()}`, projectId])).serial_id);
    const dispId = Number((await one(
      `INSERT INTO log.dispatch (company_id, bu_id, dispatch_no, project_id, customer_id, status, dispatch_date)
       VALUES ($1,$2,$3,$4,$5,'RELEASED', CURRENT_DATE) RETURNING dispatch_id`,
      [companyId, buId, `DSP/WFW/${Date.now()}`, projectId, customerId])).dispatch_id);
    await pool.query(
      `INSERT INTO log.dispatch_line (dispatch_id, item_id, serial_id, qty) VALUES ($1, ${itemId}, $2, 1)`, [dispId, serialId]);

    await dispatchReleasedWarrantyHandler(pool)(rec({ eventType: 'dispatch.released', aggregateType: 'DISPATCH', aggregateId: dispId, payload: { dispatchNo: 'DSP/WFW' } }));
    expect((await one(`SELECT count(*)::int n FROM svc.warranty WHERE serial_id=$1`, [serialId])).n).toBe(1);

    await dispatchReleasedWarrantyHandler(pool)(rec({ aggregateId: dispId, payload: { dispatchNo: 'DSP/WFW' } }));
    expect((await one(`SELECT count(*)::int n FROM svc.warranty WHERE serial_id=$1`, [serialId])).n).toBe(1);
  });

  it('installation.accepted notifies Finance to raise the final invoice (idempotent)', async () => {
    const installId = Number((await one(
      `INSERT INTO svc.installation (company_id, install_no, project_id, status, acceptance_cert_no, accepted_date)
       VALUES ($1,$2,$3,'ACCEPTED','CAC-WF-1',CURRENT_DATE) RETURNING install_id`,
      [companyId, `INST/WF/${Date.now()}`, projectId])).install_id);
    const link = `installation:${installId}`;

    await installationAcceptedBillingHandler(pool)(rec({ eventType: 'installation.accepted', aggregateType: 'INSTALLATION', aggregateId: installId, createdBy: installUser }));
    expect((await one(`SELECT count(*)::int n FROM sec.notification WHERE link=$1 AND user_id=$2`, [link, financeUser])).n).toBe(1);

    await installationAcceptedBillingHandler(pool)(rec({ aggregateId: installId, createdBy: installUser }));
    expect((await one(`SELECT count(*)::int n FROM sec.notification WHERE link=$1 AND user_id=$2`, [link, financeUser])).n).toBe(1);
  });
});
