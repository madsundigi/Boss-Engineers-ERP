import { Pool } from 'pg';
import { OutboxRelay } from '../src/outbox/relay';
import { OutboxHandler } from '../src/outbox/outbox';

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('OutboxRelay (transactional outbox)', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });
  // Other suites leave inert PENDING events in the shared test outbox; clear them so
  // this suite's bounded drain() reliably reaches its own freshly-inserted event
  // (no test relies on the relay processing those — they're never drained in tests).
  beforeEach(async () => { await pool.query(`DELETE FROM mdm.outbox_event WHERE status = 'PENDING'`); });

  async function insertEvent(type: string, maxAttempts = 5): Promise<number> {
    const r = await pool.query(
      `INSERT INTO mdm.outbox_event(event_type, aggregate_type, company_id, payload, max_attempts)
       VALUES ($1, 'TEST', 1, '{}'::jsonb, $2) RETURNING event_id`, [type, maxAttempts]);
    return Number(r.rows[0].event_id);
  }
  async function statusOf(id: number) {
    const r = await pool.query('SELECT status, attempts FROM mdm.outbox_event WHERE event_id=$1', [id]);
    return { status: r.rows[0].status as string, attempts: Number(r.rows[0].attempts) };
  }

  it('marks an event PROCESSED when its handler succeeds', async () => {
    const id = await insertEvent('test.ok');
    const handler: OutboxHandler = async () => undefined;
    await new OutboxRelay(pool, new Map([['test.ok', handler]])).drain();
    expect((await statusOf(id)).status).toBe('PROCESSED');
  });

  it('dead-letters an event after exhausting retries', async () => {
    const id = await insertEvent('test.flaky', 1); // 1 attempt -> DEAD on first failure
    const handler: OutboxHandler = async () => { throw new Error('boom'); };
    await new OutboxRelay(pool, new Map([['test.flaky', handler]])).drain();
    const s = await statusOf(id);
    expect(s.status).toBe('DEAD');
    expect(s.attempts).toBe(1);
  });

  it('retries with backoff before dead-lettering (attempt recorded, not yet DEAD)', async () => {
    const id = await insertEvent('test.retry', 5);
    const handler: OutboxHandler = async () => { throw new Error('transient'); };
    await new OutboxRelay(pool, new Map([['test.retry', handler]])).drain();
    const s = await statusOf(id);
    expect(s.status).toBe('PENDING'); // back to PENDING, scheduled in the future
    expect(s.attempts).toBe(1);
  });

  it('never silently drops an event with no registered handler (dead-letters it instead)', async () => {
    const id = await insertEvent('test.unhandled', 1); // max_attempts=1 -> DEAD on first miss
    await new OutboxRelay(pool, new Map()).drain();
    const s = await statusOf(id);
    expect(s.status).toBe('DEAD'); // visible/alertable, not silently PROCESSED
    expect(s.attempts).toBe(1);
  });
});
