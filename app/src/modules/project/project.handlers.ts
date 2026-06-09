import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead, runInContext } from '../../db/pool';
import { ProjectRepository } from './project.repository';

/**
 * Cross-module workflow trigger: 'quotation.won' -> seed a Project.
 *
 * The canonical ETO flow (FRD §5): winning a quotation instantiates the order as
 * a project. The relay invokes this AFTER the quotation has committed as WON; it
 * reuses ProjectRepository.create (gapless numbering + project.created event) so
 * no project SQL is duplicated.
 *
 * Idempotent: proj.project carries the source quotation_id, so a re-delivered
 * event finds the existing project and bails — never creating a duplicate.
 */

/** Non-interactive, tenant-scoped context for an outbox handler. */
function systemContext(e: OutboxRecord, buId: number | null): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

/** The company's first business unit — the project-numbering scope (ctx.buId). */
async function resolveBuId(pool: Pool, ctx: RequestContext): Promise<number | null> {
  return runRead(pool, ctx, async (c) => {
    const res = await c.query(
      `SELECT bu_id FROM mdm.business_unit WHERE company_id = $1 ORDER BY bu_id LIMIT 1`,
      [ctx.companyId]);
    return res.rowCount ? Number(res.rows[0].bu_id) : null;
  });
}

/**
 * Resolve the Customer master for a won quote: reuse an existing record with the
 * same name (case-insensitive, company-scoped), else create one from the captured
 * lead name. Returns null only when there is no name to identify a customer.
 * Runs as the app role (mdm grants allow the insert; the audit trigger captures it).
 * customer_code = name-derived prefix + short uuid suffix (kept within VARCHAR(20)).
 */
async function resolveOrCreateCustomer(
  pool: Pool, ctx: RequestContext, name: string,
): Promise<number | null> {
  if (!name) return null;
  return runInContext(pool, ctx, async (c) => {
    const found = await c.query(
      `SELECT customer_id FROM mdm.customer
        WHERE company_id = $1 AND lower(customer_name) = lower($2) AND NOT is_deleted
        ORDER BY customer_id LIMIT 1`,
      [ctx.companyId, name]);
    if (found.rowCount) return Number(found.rows[0].customer_id);

    const cur = await c.query(
      `SELECT currency_id FROM mdm.currency WHERE is_active
        ORDER BY (iso_code = 'INR') DESC, currency_id LIMIT 1`);
    if (!cur.rowCount) return null; // no currency configured -> cannot create a customer

    const ins = await c.query(
      `INSERT INTO mdm.customer (company_id, customer_code, customer_name, default_currency_id, created_by)
       VALUES ($1,
               COALESCE(NULLIF(upper(left(regexp_replace($2, '[^a-zA-Z0-9]', '', 'g'), 10)), ''), 'CUST')
                 || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
               $2, $3, $4)
       RETURNING customer_id`,
      [ctx.companyId, name, Number(cur.rows[0].currency_id), ctx.userId || null]);
    return Number(ins.rows[0].customer_id);
  });
}

export function quotationWonHandler(pool: Pool): OutboxHandler {
  const repo = new ProjectRepository(pool);
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const quotationId = e.aggregateId;
    const ctx0 = systemContext(e, null);

    // Idempotency: a project already seeded from this quotation?
    const exists = await runRead(pool, ctx0, async (c) => {
      const r = await c.query(
        `SELECT 1 FROM proj.project WHERE quotation_id = $1 AND company_id = $2 LIMIT 1`,
        [quotationId, ctx0.companyId]);
      return (r.rowCount ?? 0) > 0;
    });
    if (exists) return;

    // Read the won quotation. customer_id is the real FK; customer_name is the
    // free-text intake capture used when no master record was picked yet.
    const q = await runRead(pool, ctx0, async (c) => {
      const r = await c.query(
        `SELECT quotation_no, customer_id, customer_name, subject, total_price, total_cost
           FROM sales.quotation WHERE quotation_id = $1 AND company_id = $2`,
        [quotationId, ctx0.companyId]);
      return r.rowCount ? r.rows[0] : null;
    });
    if (!q) return;

    // A won quote MUST become a project (FRD §5). If it carries only a free-text
    // customer name (no master record was picked), promote that lead to a Customer
    // master — reuse one with the same name, else create it — and link the quote
    // back to it. (Previously this path silently skipped, leaving no project.)
    let customerId = q.customer_id == null ? null : Number(q.customer_id);
    if (customerId == null) {
      customerId = await resolveOrCreateCustomer(pool, ctx0, (q.customer_name ?? '').trim());
      if (customerId == null) return; // no name to identify a customer — cannot seed
      await runInContext(pool, ctx0, async (c) => {
        await c.query(
          `UPDATE sales.quotation SET customer_id = $1
             WHERE quotation_id = $2 AND company_id = $3 AND customer_id IS NULL`,
          [customerId, quotationId, ctx0.companyId]);
      });
    }

    const buId = await resolveBuId(pool, ctx0);
    if (buId == null) return;
    const ctx = systemContext(e, buId);
    if (!ctx.userId) return; // pm_user_id is NOT NULL; need a real acting user

    await repo.create(ctx, {
      projectName: q.subject || `Project — ${q.quotation_no}`,
      customerId,
      pmUserId: ctx.userId,
      contractValue: Number(q.total_price ?? 0),
      budgetCost: Number(q.total_cost ?? 0),
      quotationId,
    }, {
      eventType: 'project.created', aggregateType: 'PROJECT',
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { quotationId, customerId, seededFrom: 'quotation.won' },
    });
  };
}
