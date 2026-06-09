import { Pool } from 'pg';
import { quotationWonHandler } from '../src/modules/project/project.handlers';
import { OutboxRecord } from '../src/outbox/outbox';

/**
 * Cross-module trigger: 'quotation.won' -> seed a Project. Runs only when
 * DATABASE_URL is set. Inserts a WON quotation directly (owner bypasses RLS),
 * invokes the handler, and asserts a project is created from it — then asserts a
 * re-delivery does NOT create a second project (idempotency on quotation_id).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('quotation.won -> Project auto-seed (cross-module outbox)', () => {
  let pool: Pool;
  let companyId: number;
  let customerId: number;
  let userId: number;
  let quotationId: number;

  const record = (): OutboxRecord => ({
    eventId: 1, eventType: 'quotation.won', aggregateType: 'QUOTATION',
    aggregateId: quotationId, companyId, payload: {}, attempts: 0, maxAttempts: 5,
    createdBy: userId,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    userId = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    const qno = `QTN/TEST/WON/${Date.now()}`;
    quotationId = Number((await one(
      `INSERT INTO sales.quotation (company_id, quotation_no, customer_name, customer_id, subject, total_price, total_cost, status)
       VALUES ($1, $2, 'CUST-TEST', $3, 'Won Test Quote', 1500000, 1100000, 'WON')
       RETURNING quotation_id`, [companyId, qno, customerId])).quotation_id);
  });

  afterAll(async () => { await pool.end(); });

  it('creates a Project carrying the source quotation_id, value, and customer', async () => {
    await quotationWonHandler(pool)(record());
    const res = await pool.query(
      `SELECT project_no, customer_id, contract_value, status
         FROM proj.project WHERE quotation_id = $1 AND company_id = $2`,
      [quotationId, companyId]);
    expect(res.rowCount).toBe(1);
    expect(Number(res.rows[0].customer_id)).toBe(customerId);
    expect(Number(res.rows[0].contract_value)).toBe(1500000);
    expect(res.rows[0].project_no).toMatch(/^PRJ\//);
    expect(res.rows[0].status).toBe('PLANNING');
  });

  it('is idempotent — a re-delivered event does not create a second project', async () => {
    await quotationWonHandler(pool)(record());
    const res = await pool.query(
      `SELECT count(*)::int AS n FROM proj.project WHERE quotation_id = $1 AND company_id = $2`,
      [quotationId, companyId]);
    expect(res.rows[0].n).toBe(1);
  });
});

/**
 * Free-text lead path: a WON quote that carries only customer_name (customer_id
 * NULL) must still seed a project — the handler promotes the lead to a Customer
 * master (reuse-by-name, else create), links the quote, then seeds the project.
 */
d('quotation.won with a free-text lead -> auto-creates the Customer master', () => {
  let pool: Pool;
  let companyId: number;
  let userId: number;
  let quotationId: number;
  const leadName = `ZZ Auto Lead ${Date.now()}`;
  const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const wonRec = (eventId: number, aggId: number): OutboxRecord => ({
    eventId, eventType: 'quotation.won', aggregateType: 'QUOTATION', aggregateId: aggId,
    companyId, payload: {}, attempts: 0, maxAttempts: 5, createdBy: userId,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    userId = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    quotationId = Number((await one(
      `INSERT INTO sales.quotation (company_id, quotation_no, customer_name, customer_id, subject, total_price, total_cost, status)
       VALUES ($1, $2, $3, NULL, 'Lead Quote', 900000, 700000, 'WON') RETURNING quotation_id`,
      [companyId, `QTN/TEST/LEAD/${Date.now()}`, leadName])).quotation_id);
  });
  afterAll(async () => { await pool.end(); });

  it('promotes the lead to a Customer master, links the quote, and seeds the project', async () => {
    await quotationWonHandler(pool)(wonRec(2, quotationId));

    const cust = await pool.query(
      `SELECT customer_id FROM mdm.customer WHERE company_id=$1 AND lower(customer_name)=lower($2) AND NOT is_deleted`,
      [companyId, leadName]);
    expect(cust.rowCount).toBe(1);
    const cid = Number(cust.rows[0].customer_id);

    const q = await pool.query(`SELECT customer_id FROM sales.quotation WHERE quotation_id=$1`, [quotationId]);
    expect(Number(q.rows[0].customer_id)).toBe(cid); // quote now linked to the new master

    const proj = await pool.query(
      `SELECT customer_id, contract_value FROM proj.project WHERE quotation_id=$1 AND company_id=$2`,
      [quotationId, companyId]);
    expect(proj.rowCount).toBe(1);
    expect(Number(proj.rows[0].customer_id)).toBe(cid);
    expect(Number(proj.rows[0].contract_value)).toBe(900000);
  });

  it('reuses the same master for a second free-text quote with the same name (no duplicate)', async () => {
    const q2 = Number((await one(
      `INSERT INTO sales.quotation (company_id, quotation_no, customer_name, customer_id, subject, total_price, total_cost, status)
       VALUES ($1, $2, $3, NULL, 'Lead Quote 2', 100000, 80000, 'WON') RETURNING quotation_id`,
      [companyId, `QTN/TEST/LEAD2/${Date.now()}`, leadName])).quotation_id);
    await quotationWonHandler(pool)(wonRec(3, q2));
    const n = (await one(
      `SELECT count(*)::int AS n FROM mdm.customer WHERE company_id=$1 AND lower(customer_name)=lower($2) AND NOT is_deleted`,
      [companyId, leadName])).n;
    expect(n).toBe(1); // still ONE master — reused, not duplicated
  });
});
