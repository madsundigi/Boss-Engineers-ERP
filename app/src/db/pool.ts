import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';
import { RequestContext } from '../common/request-context';

/** Minimal queryable surface satisfied by both Pool and PoolClient. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export function createPool(): Pool {
  return new Pool({ connectionString: env.databaseUrl, max: 10 });
}

/**
 * Run write work inside a transaction with the request identity pushed into
 * PostgreSQL session GUCs. The DB audit triggers (audit.fn_audit) read these to
 * attribute CREATE/EDIT/DELETE events to the acting user — defence in depth, the
 * trail cannot be forged from the client.
 */
export async function runInContext<T>(
  pool: Pool,
  ctx: RequestContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.client_ip', $2, true),
              set_config('app.session_id', $3, true),
              set_config('app.company_id', $4, true)`,
      [String(ctx.userId), ctx.clientIp, ctx.sessionId, String(ctx.companyId)],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
