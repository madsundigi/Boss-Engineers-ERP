import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead, runInContext } from '../../db/pool';

/**
 * Cross-module trigger: 'dispatch.released' -> start WARRANTY for each shipped
 * serial (FRD M11: dispatch triggers the warranty start date).
 *
 * For every dispatch_line carrying a serial_id, create an svc.warranty starting
 * on the dispatch date for the standard duration. Idempotent: a serial that
 * already has a warranty is skipped (NOT EXISTS), so re-delivery never
 * duplicates.
 */
const DEFAULT_WARRANTY_MONTHS = 12;

function systemContext(e: OutboxRecord): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId: null, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

export function dispatchReleasedWarrantyHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const dispatchId = e.aggregateId;
    const ctx = systemContext(e);

    const data = await runRead(pool, ctx, async (c) => {
      const d = await c.query(
        `SELECT project_id, customer_id, dispatch_date, dispatch_no
           FROM log.dispatch WHERE dispatch_id = $1 AND company_id = $2`,
        [dispatchId, ctx.companyId]);
      if (!d.rowCount) return null;
      const lines = await c.query(
        `SELECT serial_id FROM log.dispatch_line WHERE dispatch_id = $1 AND serial_id IS NOT NULL`,
        [dispatchId]);
      return { row: d.rows[0], serialIds: lines.rows.map((r) => Number(r.serial_id)) };
    });
    if (!data || data.serialIds.length === 0) return; // nothing serialised -> nothing to warrant

    const terms = `${DEFAULT_WARRANTY_MONTHS}-month standard warranty (dispatch ${data.row.dispatch_no})`;
    await runInContext(pool, ctx, async (c) => {
      for (const serialId of data.serialIds) {
        await c.query(
          `INSERT INTO svc.warranty (company_id, serial_id, project_id, customer_id, start_date, end_date, terms, status)
           SELECT $1, $2, $3, $4, $5::date,
                  ($5::date + ($6 || ' months')::interval)::date, $7, 'ACTIVE'
            WHERE NOT EXISTS (
              SELECT 1 FROM svc.warranty w WHERE w.serial_id = $2 AND w.company_id = $1)`,
          [ctx.companyId, serialId, data.row.project_id, data.row.customer_id,
           data.row.dispatch_date, String(DEFAULT_WARRANTY_MONTHS), terms]);
      }
    });
  };
}
