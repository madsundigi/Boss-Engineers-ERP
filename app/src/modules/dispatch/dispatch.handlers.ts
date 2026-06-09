import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead, runInContext } from '../../db/pool';

/**
 * Cross-module trigger: 'fat.passed' -> open the Dispatch QUALITY gate.
 *
 * FAT clearance is the quality gate for dispatch (FRD M10->M11). When a FAT
 * passes, any DRAFT dispatch linked to that FAT (log.dispatch.fat_id) gets its
 * quality_cleared_* stamped, so it then only needs the commercial gate to be
 * released. Idempotent: only touches dispatches whose quality gate is still open
 * (quality_cleared_by IS NULL), so re-delivery is a no-op.
 */
function systemContext(e: OutboxRecord): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId: null, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

export function fatPassedClearQualityHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null || !e.createdBy) return; // need the FAT id + an actor for attribution
    const fatId = e.aggregateId;
    const ctx = systemContext(e);
    await runInContext(pool, ctx, async (c) => {
      await c.query(
        `UPDATE log.dispatch
            SET quality_cleared_by = $1, quality_cleared_at = now(),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE fat_id = $2 AND company_id = $3
            AND status = 'DRAFT' AND quality_cleared_by IS NULL AND NOT is_deleted`,
        [ctx.userId, fatId, ctx.companyId]);
    });
  };
}

/**
 * Cross-module trigger: 'dispatch.released' -> notify the customer that their
 * shipment has been dispatched (flowchart: "Dispatch feeds Customer
 * Notifications"). FRD §11 binds an external customer to its portal users via
 * sec.app_user.customer_id (migration 040_portal): so the recipients are this
 * dispatch's customer's PORTAL users — the people who watch the self-service
 * portal and should learn the shipment is on its way. (Path 1 of the brief: the
 * portal customer-user linkage exists, so we notify the customer directly rather
 * than asking an internal SALES owner to relay it.)
 *
 * Idempotent via the notification link `dispatch-shipped:<id>`: if one already
 * exists for this dispatch, re-delivery is a no-op. A customer with no linked
 * portal users simply has nobody to notify (no-op).
 */
export function dispatchReleasedNotifyCustomerHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const dispatchId = e.aggregateId;
    const ctx = systemContext(e);
    const link = `dispatch-shipped:${dispatchId}`;

    const info = await runRead(pool, ctx, async (c) => {
      const d = await c.query(
        `SELECT dispatch_no, customer_id, project_id
           FROM log.dispatch WHERE dispatch_id = $1 AND company_id = $2`,
        [dispatchId, ctx.companyId]);
      if (!d.rowCount) return null;
      const customerId = d.rows[0].customer_id == null ? null : Number(d.rows[0].customer_id);
      if (customerId == null) return null; // no customer -> nobody to notify
      const cust = await c.query(
        `SELECT customer_name FROM mdm.customer WHERE customer_id = $1 AND company_id = $2`,
        [customerId, ctx.companyId]);
      const portal = await c.query(
        `SELECT DISTINCT u.user_id
           FROM sec.app_user u
          WHERE u.customer_id = $1 AND u.is_active AND NOT u.is_deleted`,
        [customerId]);
      return {
        dispatchNo: d.rows[0].dispatch_no as string,
        customerName: cust.rowCount ? (cust.rows[0].customer_name as string) : null,
        portalUserIds: portal.rows.map((r) => Number(r.user_id)),
      };
    });
    if (!info || info.portalUserIds.length === 0) return; // no portal recipients -> nothing to do

    await runInContext(pool, ctx, async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM sec.notification WHERE company_id = $1 AND link = $2 LIMIT 1`,
        [ctx.companyId, link]);
      if (dup.rowCount) return; // already notified for this dispatch
      const who = info.customerName ? ` for ${info.customerName}` : '';
      const title = `Dispatch ${info.dispatchNo} shipped`;
      const body = `Your shipment${who} (dispatch ${info.dispatchNo}) has been dispatched.`;
      for (const uid of info.portalUserIds) {
        await c.query(
          `INSERT INTO sec.notification (company_id, user_id, category, title, body, link, created_by)
           VALUES ($1, $2, 'INFO', $3, $4, $5, $6)`,
          [ctx.companyId, uid, title, body, link, ctx.userId || null]);
      }
    });
  };
}
