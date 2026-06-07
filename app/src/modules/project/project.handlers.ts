import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead } from '../../db/pool';
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

    // Read the won quotation (customer_id is a real FK on sales.quotation).
    const q = await runRead(pool, ctx0, async (c) => {
      const r = await c.query(
        `SELECT quotation_no, customer_id, subject, total_price, total_cost
           FROM sales.quotation WHERE quotation_id = $1 AND company_id = $2`,
        [quotationId, ctx0.companyId]);
      return r.rowCount ? r.rows[0] : null;
    });
    if (!q || q.customer_id == null) return; // cannot seed a project without a customer

    const buId = await resolveBuId(pool, ctx0);
    if (buId == null) return;
    const ctx = systemContext(e, buId);
    if (!ctx.userId) return; // pm_user_id is NOT NULL; need a real acting user

    await repo.create(ctx, {
      projectName: q.subject || `Project — ${q.quotation_no}`,
      customerId: Number(q.customer_id),
      pmUserId: ctx.userId,
      contractValue: Number(q.total_price ?? 0),
      budgetCost: Number(q.total_cost ?? 0),
      quotationId,
    }, {
      eventType: 'project.created', aggregateType: 'PROJECT',
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { quotationId, customerId: Number(q.customer_id), seededFrom: 'quotation.won' },
    });
  };
}
