/**
 * Minimal, idempotent migration runner (DAT-01).
 * - Records every applied migration in public.schema_migration (filename + sha256).
 * - Applies each pending app/migrations/*.sql (sorted) in its own transaction.
 * - Refuses to continue if an already-applied file's checksum changed (drift).
 * Baseline schema (db/00_run_all.sql) is applied once before this runner.
 * Usage:  DATABASE_URL=... npm run migrate
 */
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  // Migrations do DDL (ALTER / CREATE POLICY / GRANT) so they must run as the
  // table OWNER, not the restricted erp_app_login the app uses at runtime.
  // Prefer an explicit owner URL when provided (e.g. Render's MIGRATE_DATABASE_URL).
  const connectionString = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  // Managed Postgres (Render/Neon/etc.) requires TLS. Force it for any non-local
  // host (rejectUnauthorized:false accepts the provider's cert — the link is still
  // encrypted). Local dev/test (localhost/127.0.0.1) connects plain.
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString ?? '');
  const wantsSsl = !isLocal || /sslmode=(require|verify|prefer)/.test(connectionString ?? '');
  const pool = new Pool({
    connectionString,
    ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const appliedRes = await pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM public.schema_migration');
    const applied = new Map(appliedRes.rows.map((r) => [r.filename, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    let appliedCount = 0;

    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      if (applied.has(f)) {
        if (applied.get(f) !== checksum) {
          throw new Error(`Migration "${f}" changed after being applied (checksum drift). Refusing to run.`);
        }
        // eslint-disable-next-line no-console
        console.log(`=  skip    ${f}`);
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migration(filename, checksum) VALUES ($1, $2)', [f, checksum]);
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`+  applied ${f}`);
        appliedCount++;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration "${f}" failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Done. ${appliedCount} applied, ${files.length - appliedCount} already up to date.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e?.message ?? e));
  process.exit(1);
});
