import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead, runInContext } from '../../db/pool';

/**
 * Cross-module trigger: 'installation.accepted' (Customer Acceptance Certificate)
 * -> notify FINANCE to raise the final invoice (FRD M12: CAC is the final-billing
 * trigger). We do not auto-create the invoice (amount/scope is a finance decision)
 * — instead every active FINANCE user gets an actionable notification, including
 * the contract's outstanding final milestone amount when a contract exists.
 *
 * Idempotent via the notification link `installation:<id>`: if one already exists
 * for this installation, re-delivery is a no-op.
 */
function systemContext(e: OutboxRecord): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId: null, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

export function installationAcceptedBillingHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const installId = e.aggregateId;
    const ctx = systemContext(e);
    const link = `installation:${installId}`;

    const info = await runRead(pool, ctx, async (c) => {
      const inst = await c.query(
        `SELECT project_id, acceptance_cert_no FROM svc.installation WHERE install_id = $1 AND company_id = $2`,
        [installId, ctx.companyId]);
      if (!inst.rowCount) return null;
      const projectId = Number(inst.rows[0].project_id);
      const ms = await c.query(
        `SELECT m.amount, m.name
           FROM sales.customer_contract cc
           JOIN sales.contract_milestone m ON m.contract_id = cc.contract_id
          WHERE cc.project_id = $1 AND cc.company_id = $2 AND m.status = 'PENDING'
          ORDER BY m.sort_order DESC NULLS LAST, m.milestone_id DESC LIMIT 1`,
        [projectId, ctx.companyId]);
      const fin = await c.query(
        `SELECT DISTINCT u.user_id
           FROM sec.app_user u
           JOIN sec.user_role ur ON ur.user_id = u.user_id
           JOIN sec.role r       ON r.role_id = ur.role_id
          WHERE r.role_code = 'FINANCE' AND u.is_active AND NOT u.is_deleted`);
      return {
        projectId,
        cert: inst.rows[0].acceptance_cert_no as string | null,
        milestone: ms.rowCount ? ms.rows[0] : null,
        financeUserIds: fin.rows.map((r) => Number(r.user_id)),
      };
    });
    if (!info || info.financeUserIds.length === 0) return;

    await runInContext(pool, ctx, async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM sec.notification WHERE company_id = $1 AND link = $2 LIMIT 1`,
        [ctx.companyId, link]);
      if (dup.rowCount) return; // already notified for this CAC
      const amt = info.milestone ? ` (final milestone "${info.milestone.name}": ${info.milestone.amount})` : '';
      const title = `Final billing due — project ${info.projectId} accepted${info.cert ? ` (CAC ${info.cert})` : ''}`;
      const body = `Customer acceptance recorded. Please raise the final invoice${amt}.`;
      for (const uid of info.financeUserIds) {
        await c.query(
          `INSERT INTO sec.notification (company_id, user_id, category, title, body, link, created_by)
           VALUES ($1, $2, 'APPROVAL', $3, $4, $5, $6)`,
          [ctx.companyId, uid, title, body, link, ctx.userId || null]);
      }
    });
  };
}
