import { Pool } from 'pg';
import { runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { SalesPipeline, FunnelRow } from './dashboard.types';
import {
  WO_TERMINAL_STATUSES,
  INVOICE_CLOSED_STATUSES,
  VENDOR_INVOICE_EXCLUDED_STATUSES,
} from './dashboard.constants';

/** Active-project rollup: count + Σ contract_value (the order book). */
export interface ActiveProjectStats {
  count: number;
  orderBook: number;
}

/** The raw KPI parts the repository fetches; the service assembles them into KpiSummary. */
export interface KpiParts {
  salesPipeline: SalesPipeline;
  activeProjects: ActiveProjectStats;
  wipWorkOrders: number;
  dispatchesMtd: number;
  arOutstanding: number;
  apOutstanding: number;
  openNcrs: number;
  avgMarginPct: number;
  deliveryAtRisk: number;
}

/**
 * DashboardRepository — READ-ONLY cross-module aggregation (M16). It owns no table:
 * every method runs inside a single `runRead` transaction (RLS role + app.company_id
 * GUC) and SELECTs from other modules' tables. In addition to RLS, each query filters
 * `company_id = $1` explicitly where the column exists, so the figures are correct even
 * for the non-RLS aggregation tables (fin.payment_allocation, fin.margin_snapshot have
 * no company_id of their own and are reached via their parent invoice / project).
 *
 * Every KPI is wrapped in COALESCE(...,0) and cast to float8 so an empty table yields
 * the JS number 0 (never NULL, never an error). A brand-new company returns all zeros.
 */
export class DashboardRepository {
  constructor(private readonly pool: Pool) {}

  /** Fetch every KPI part in one read transaction (a few independent aggregates). */
  async fetchKpiParts(ctx: RequestContext): Promise<KpiParts> {
    return runRead(this.pool, ctx, async (c) => {
      const cid = ctx.companyId;
      const [
        salesPipeline, activeProjects, wipWorkOrders, dispatchesMtd,
        arOutstanding, apOutstanding, openNcrs, avgMarginPct, deliveryAtRisk,
      ] = await Promise.all([
        this.salesPipeline(c, cid),
        this.activeProjects(c, cid),
        this.wipWorkOrders(c, cid),
        this.dispatchesMtd(c, cid),
        this.arOutstanding(c, cid),
        this.apOutstanding(c, cid),
        this.openNcrs(c, cid),
        this.avgMarginPct(c, cid),
        this.deliveryAtRisk(c, cid),
      ]);
      return {
        salesPipeline, activeProjects, wipWorkOrders, dispatchesMtd,
        arOutstanding, apOutstanding, openNcrs, avgMarginPct, deliveryAtRisk,
      };
    });
  }

  /** Funnel stage counts, all in one read transaction. */
  async fetchSalesFunnel(ctx: RequestContext): Promise<FunnelRow[]> {
    return runRead(this.pool, ctx, async (c) => {
      const cid = ctx.companyId;
      const enquiries = await this.scalarCount(
        c, `SELECT count(*) AS n FROM sales.enquiry WHERE company_id = $1`, [cid]);
      const quotations = await this.scalarCount(
        c, `SELECT count(*) AS n FROM sales.quotation WHERE company_id = $1`, [cid]);
      const won = await this.scalarCount(
        c, `SELECT count(*) AS n FROM sales.quotation WHERE company_id = $1 AND status = 'WON'`, [cid]);
      const projects = await this.scalarCount(
        c, `SELECT count(*) AS n FROM proj.project WHERE company_id = $1`, [cid]);
      return [
        { stage: 'ENQUIRY', count: enquiries },
        { stage: 'QUOTATION', count: quotations },
        { stage: 'WON', count: won },
        { stage: 'PROJECT', count: projects },
      ];
    });
  }

  // --- individual KPI queries (each defensive: COALESCE + explicit company filter) ---

  private async salesPipeline(c: Queryable, cid: number): Promise<SalesPipeline> {
    // Open enquiries (status='OPEN') + their target value; open (non-terminal)
    // quotations + their total_price (the indicative pipeline value).
    const enq = await c.query<{ cnt: string; val: number }>(
      `SELECT count(*)::text AS cnt,
              COALESCE(SUM(target_value), 0)::float8 AS val
         FROM sales.enquiry
        WHERE company_id = $1 AND status = 'OPEN'`, [cid]);
    const quo = await c.query<{ cnt: string; val: number }>(
      `SELECT count(*)::text AS cnt,
              COALESCE(SUM(total_price), 0)::float8 AS val
         FROM sales.quotation
        WHERE company_id = $1 AND status NOT IN ('WON', 'LOST')`, [cid]);
    return {
      openEnquiries: Number(enq.rows[0].cnt),
      openEnquiryValue: Number(enq.rows[0].val),
      openQuotations: Number(quo.rows[0].cnt),
      openQuotationValue: Number(quo.rows[0].val),
    };
  }

  private async activeProjects(c: Queryable, cid: number): Promise<ActiveProjectStats> {
    // Count + order book (Σ contract_value) of ACTIVE projects in one pass.
    const r = await c.query<{ cnt: string; book: number }>(
      `SELECT count(*)::text AS cnt,
              COALESCE(SUM(contract_value), 0)::float8 AS book
         FROM proj.project
        WHERE company_id = $1 AND status = 'ACTIVE'`, [cid]);
    return { count: Number(r.rows[0].cnt), orderBook: Number(r.rows[0].book) };
  }

  private async wipWorkOrders(c: Queryable, cid: number): Promise<number> {
    return this.scalarCount(
      c,
      `SELECT count(*) AS n FROM mfg.work_order
        WHERE company_id = $1 AND status <> ALL($2::text[])`,
      [cid, [...WO_TERMINAL_STATUSES]]);
  }

  private async dispatchesMtd(c: Queryable, cid: number): Promise<number> {
    // RELEASED dispatches whose dispatch_date falls in the current calendar month.
    return this.scalarCount(
      c,
      `SELECT count(*) AS n FROM log.dispatch
        WHERE company_id = $1 AND status = 'RELEASED'
          AND dispatch_date >= date_trunc('month', current_date)::date
          AND dispatch_date <  (date_trunc('month', current_date) + interval '1 month')::date`,
      [cid]);
  }

  private async arOutstanding(c: Queryable, cid: number): Promise<number> {
    // Σ open-invoice total_amount MINUS Σ allocated receipts against those invoices.
    // payment_allocation has no company_id; it is bounded via its parent invoice.
    const r = await c.query<{ amt: number }>(
      `SELECT COALESCE(SUM(i.total_amount), 0)::float8
              - COALESCE((
                  SELECT SUM(pa.allocated_amount)
                    FROM fin.payment_allocation pa
                    JOIN fin.invoice ii ON ii.invoice_id = pa.invoice_id
                   WHERE ii.company_id = $1
                     AND ii.status <> ALL($2::text[])
                ), 0)::float8 AS amt
         FROM fin.invoice i
        WHERE i.company_id = $1 AND i.status <> ALL($2::text[])`,
      [cid, [...INVOICE_CLOSED_STATUSES]]);
    return Number(r.rows[0].amt);
  }

  private async apOutstanding(c: Queryable, cid: number): Promise<number> {
    const r = await c.query<{ amt: number }>(
      `SELECT COALESCE(SUM(total_amount), 0)::float8 AS amt
         FROM fin.vendor_invoice
        WHERE company_id = $1 AND status <> ALL($2::text[])`,
      [cid, [...VENDOR_INVOICE_EXCLUDED_STATUSES]]);
    return Number(r.rows[0].amt);
  }

  private async openNcrs(c: Queryable, cid: number): Promise<number> {
    return this.scalarCount(
      c,
      `SELECT count(*) AS n FROM qms.ncr WHERE company_id = $1 AND status <> 'CLOSED'`,
      [cid]);
  }

  private async avgMarginPct(c: Queryable, cid: number): Promise<number> {
    // Latest margin_snapshot per project (DISTINCT ON), then average margin_pct over
    // those rows. margin_snapshot has no company_id, so it is scoped via proj.project.
    const r = await c.query<{ avg: number }>(
      `SELECT COALESCE(AVG(latest.margin_pct), 0)::float8 AS avg
         FROM (
           SELECT DISTINCT ON (ms.project_id) ms.margin_pct
             FROM fin.margin_snapshot ms
             JOIN proj.project p ON p.project_id = ms.project_id
            WHERE p.company_id = $1
            ORDER BY ms.project_id, ms.snapshot_date DESC, ms.snapshot_id DESC
         ) latest`,
      [cid]);
    return Number(r.rows[0].avg);
  }

  private async deliveryAtRisk(c: Queryable, cid: number): Promise<number> {
    // Projects whose MOST RECENT delivery_forecast is HIGH risk (latest snapshot wins).
    const r = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT DISTINCT ON (df.project_id) df.risk_level
           FROM proj.delivery_forecast df
          WHERE df.company_id = $1
          ORDER BY df.project_id, df.forecast_date DESC, df.forecast_id DESC
       ) latest
       WHERE latest.risk_level = 'HIGH'`,
      [cid]);
    return Number(r.rows[0].n);
  }

  /** Run a `SELECT count(*) AS n ...` and return it as a JS number (0 on empty). */
  private async scalarCount(c: Queryable, sql: string, params: unknown[]): Promise<number> {
    const r = await c.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  }
}
