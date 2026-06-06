import { Queryable } from '../db/pool';

/** An event to record in the outbox, inside the caller's transaction. */
export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId?: number | null;
  companyId?: number | null;
  payload?: Record<string, unknown>;
  createdBy?: number | null;
}

/** A claimed outbox row handed to a handler. */
export interface OutboxRecord {
  eventId: number;
  eventType: string;
  aggregateType: string;
  aggregateId: number | null;
  companyId: number | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdBy: number | null;
}

export type OutboxHandler = (event: OutboxRecord) => Promise<void>;

/**
 * Insert an outbox event using the *caller's* transaction client, so the event
 * is committed atomically with the business state change (transactional outbox).
 */
export async function emitOutbox(client: Queryable, e: OutboxEventInput): Promise<void> {
  await client.query(
    `INSERT INTO mdm.outbox_event
       (event_type, aggregate_type, aggregate_id, company_id, payload, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.eventType, e.aggregateType, e.aggregateId ?? null, e.companyId ?? null,
     JSON.stringify(e.payload ?? {}), e.createdBy ?? null],
  );
}
