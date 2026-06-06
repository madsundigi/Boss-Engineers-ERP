/**
 * RequestContext — the authenticated, tenant-scoped identity for one request.
 * Sourced from the API gateway (verified JWT + tenant headers) in production.
 * It is propagated into PostgreSQL session GUCs (app.user_id, app.client_ip,
 * app.session_id, app.company_id) so the database audit triggers attribute every
 * change to the right user. Never trust the client body for these values.
 */
export interface RequestContext {
  userId: number;
  username: string;
  companyId: number;
  buId: number | null;
  clientIp: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
}

export function hasPermission(ctx: RequestContext, code: string): boolean {
  return ctx.permissions.has(code);
}
