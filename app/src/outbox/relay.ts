import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from './outbox';

/**
 * OutboxRelay — polls mdm.outbox_event for PENDING events and dispatches each to
 * its registered handler. Each event is claimed with FOR UPDATE SKIP LOCKED (so
 * multiple relay instances don't double-process), processed inside that
 * transaction, then marked PROCESSED. On handler failure the attempt count is
 * incremented with exponential backoff; after max_attempts the event is
 * dead-lettered (status DEAD). Unknown event types are skipped (PROCESSED).
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: Map<string, OutboxHandler>,
  ) {}

  /** Process at most one due event. Returns true if one was claimed. */
  async processOne(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT event_id, event_type, aggregate_type, aggregate_id, company_id,
                payload, attempts, max_attempts, created_by
           FROM mdm.outbox_event
          WHERE status = 'PENDING' AND available_at <= now()
          ORDER BY available_at, event_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      if (res.rowCount === 0) { await client.query('COMMIT'); return false; }

      const r = res.rows[0];
      const rec: OutboxRecord = {
        eventId: Number(r.event_id), eventType: r.event_type, aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id == null ? null : Number(r.aggregate_id),
        companyId: r.company_id == null ? null : Number(r.company_id),
        payload: r.payload ?? {}, attempts: r.attempts, maxAttempts: r.max_attempts,
        createdBy: r.created_by == null ? null : Number(r.created_by),
      };

      try {
        const handler = this.handlers.get(rec.eventType);
        if (handler) await handler(rec); // unknown type -> skip (mark processed)
        await client.query(
          `UPDATE mdm.outbox_event SET status='PROCESSED', processed_at=now() WHERE event_id=$1`,
          [rec.eventId]);
        await client.query('COMMIT');
      } catch (err) {
        const attempts = rec.attempts + 1;
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
        if (attempts >= rec.maxAttempts) {
          await client.query(
            `UPDATE mdm.outbox_event SET status='DEAD', attempts=$2, last_error=$3, processed_at=now() WHERE event_id=$1`,
            [rec.eventId, attempts, msg]);
        } else {
          const backoffSec = Math.min(300, 2 ** attempts);
          await client.query(
            `UPDATE mdm.outbox_event
                SET attempts=$2, last_error=$3, available_at = now() + ($4 || ' seconds')::interval
              WHERE event_id=$1`,
            [rec.eventId, attempts, msg, backoffSec]);
        }
        await client.query('COMMIT');
      }
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Drain all currently-due events (used by tests and on-demand flushes). */
  async drain(maxIterations = 200): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.processOne())) break;
    }
  }

  /** Background poller for the running server. */
  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.processOne().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}
