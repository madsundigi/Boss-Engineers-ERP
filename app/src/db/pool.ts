import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { env } from '../config/env';
import { RequestContext } from '../common/request-context';

// Return SQL DATE (oid 1082) as a plain 'YYYY-MM-DD' string rather than a
// timezone-shifted JS Date — avoids off-by-one date bugs across all modules.
types.setTypeParser(1082, (v) => v);

/** Minimal queryable surface satisfied by both Pool and PoolClient. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * Non-superuser role whose Row-Level Security policies enforce tenant isolation.
 * Every request transaction drops into it via `SET LOCAL ROLE` so RLS actually
 * applies (a superuser/owner connection would otherwise bypass RLS — BUG-01).
 * In production the app must connect as a login user that is a MEMBER of this
 * role (`GRANT erp_app TO <login_user>`); in dev/test a superuser can SET ROLE.
 */
const APP_DB_ROLE = 'erp_app';

export function createPool(): Pool {
  const url = env.databaseUrl;
  // Managed Postgres (Render/Neon/etc.) requires TLS. Force it for any non-local
  // host or when the URL asks for it; rejectUnauthorized:false accepts the
  // provider's cert (the connection is still encrypted). Local dev/test is plain.
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const wantsSsl = /sslmode=(require|verify|prefer)/.test(url) || (!isLocal && !env.isTest);
  return new Pool({
    connectionString: url,
    max: 10,
    ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

/** Drop to the RLS-enforced role and push the request identity into session GUCs
 *  (all LOCAL to the transaction; reverts on COMMIT/ROLLBACK). */
async function applyTenantContext(client: Queryable, ctx: RequestContext): Promise<void> {
  await client.query(`SET LOCAL ROLE ${APP_DB_ROLE}`);
  await client.query(
    `SELECT set_config('app.user_id', $1, true),
            set_config('app.client_ip', $2, true),
            set_config('app.session_id', $3, true),
            set_config('app.company_id', $4, true)`,
    [String(ctx.userId), ctx.clientIp, ctx.sessionId, String(ctx.companyId)],
  );
}

/**
 * Run write work in a transaction as the RLS-enforced role with the request
 * identity in session GUCs. The DB audit triggers read these to attribute
 * CREATE/EDIT/DELETE to the acting user — defence in depth.
 */
export async function runInContext<T>(
  pool: Pool,
  ctx: RequestContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, ctx);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Read-only sibling of runInContext: same RLS role + tenant GUC so RLS applies
 * to reads as well (not just writes). Use for every SELECT path.
 */
export async function runRead<T>(
  pool: Pool,
  ctx: RequestContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await applyTenantContext(client, ctx);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
