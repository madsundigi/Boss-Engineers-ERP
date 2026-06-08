import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runInContext } from '../../db/pool';

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
