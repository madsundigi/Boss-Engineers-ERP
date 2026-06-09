import { Pool } from 'pg';
import { runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { SearchHit } from './search.types';

/** Raw row shape every entity query selects, then maps to a SearchHit. */
interface HitRow {
  id: string | number;
  no: string | null;
  title: string | null;
  subtitle: string | null;
}

/**
 * SearchRepository — READ-ONLY cross-module lookup. It owns no table: every method
 * runs inside a single `runRead` transaction (RLS role + app.company_id GUC) and
 * SELECTs from one module's table with a small LIMIT. In addition to RLS, each query
 * filters `company_id = $1` explicitly where the column exists. scm.serial_number has
 * no company_id of its own, so it is scoped by joining proj.project (and bounded by
 * RLS + LIMIT). `NOT is_deleted` is applied wherever that column exists.
 *
 * The match is a case-insensitive substring (`ILIKE '%'||$2||'%'`) on the relevant
 * number/name columns. Each method returns at most `limit` lightweight hits.
 */
export class SearchRepository {
  constructor(private readonly pool: Pool) {}

  /** Enquiries by enquiry_no or customer name. path -> 'enquiries'. */
  async searchEnquiries(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT e.enquiry_id   AS id,
                e.enquiry_no    AS no,
                e.customer_name AS title,
                e.status        AS subtitle
           FROM sales.enquiry e
          WHERE e.company_id = $1
            AND NOT e.is_deleted
            AND (e.enquiry_no ILIKE '%'||$2||'%' OR e.customer_name ILIKE '%'||$2||'%')
          ORDER BY e.enquiry_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, 'enquiries');
    });
  }

  /** Quotations by quotation_no or customer name. path -> 'quotations'. */
  async searchQuotations(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT qo.quotation_id  AS id,
                qo.quotation_no   AS no,
                qo.customer_name  AS title,
                qo.status         AS subtitle
           FROM sales.quotation qo
          WHERE qo.company_id = $1
            AND NOT qo.is_deleted
            AND (qo.quotation_no ILIKE '%'||$2||'%' OR qo.customer_name ILIKE '%'||$2||'%')
          ORDER BY qo.quotation_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, 'quotations');
    });
  }

  /** Projects by project_no or project_name. path -> 'projects'. */
  async searchProjects(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT p.project_id   AS id,
                p.project_no    AS no,
                p.project_name  AS title,
                p.status        AS subtitle
           FROM proj.project p
          WHERE p.company_id = $1
            AND NOT p.is_deleted
            AND (p.project_no ILIKE '%'||$2||'%' OR p.project_name ILIKE '%'||$2||'%')
          ORDER BY p.project_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, 'projects');
    });
  }

  /**
   * Serial numbers by serial_no. scm.serial_number has no company_id and no
   * is_deleted; it is company-scoped via its project (LEFT JOIN so unassigned
   * serials still surface) — when assigned, the row's project must belong to the
   * caller's company. path -> null (no standalone serial screen).
   */
  async searchSerials(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT s.serial_id AS id,
                s.serial_no  AS no,
                s.serial_no  AS title,
                s.status     AS subtitle
           FROM scm.serial_number s
           LEFT JOIN proj.project p ON p.project_id = s.project_id
          WHERE (s.project_id IS NULL OR p.company_id = $1)
            AND s.serial_no ILIKE '%'||$2||'%'
          ORDER BY s.serial_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, null);
    });
  }

  /** Service tickets by ticket_no or customer name. path -> 'service-tickets'. */
  async searchServiceTickets(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT t.ticket_id AS id,
                t.ticket_no  AS no,
                cu.customer_name AS title,
                t.status     AS subtitle
           FROM svc.service_ticket t
           JOIN mdm.customer cu ON cu.customer_id = t.customer_id
          WHERE t.company_id = $1
            AND NOT t.is_deleted
            AND (t.ticket_no ILIKE '%'||$2||'%' OR cu.customer_name ILIKE '%'||$2||'%')
          ORDER BY t.ticket_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, 'service-tickets');
    });
  }

  /** Customers by customer_code or customer_name. path -> null (no standalone screen). */
  async searchCustomers(ctx: RequestContext, q: string, limit: number): Promise<SearchHit[]> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query<HitRow>(
        `SELECT cu.customer_id   AS id,
                cu.customer_code  AS no,
                cu.customer_name  AS title,
                cu.status         AS subtitle
           FROM mdm.customer cu
          WHERE cu.company_id = $1
            AND NOT cu.is_deleted
            AND (cu.customer_code ILIKE '%'||$2||'%' OR cu.customer_name ILIKE '%'||$2||'%')
          ORDER BY cu.customer_id DESC
          LIMIT $3`,
        [ctx.companyId, q, limit],
      );
      return mapHits(r.rows, null);
    });
  }
}

/** Map raw rows to SearchHit, stamping the (shared) deep-link path for the group. */
function mapHits(rows: HitRow[], path: string | null): SearchHit[] {
  return rows.map((row) => ({
    id: Number(row.id),
    no: row.no ?? '',
    title: row.title ?? '',
    subtitle: row.subtitle ?? null,
    path,
  }));
}
