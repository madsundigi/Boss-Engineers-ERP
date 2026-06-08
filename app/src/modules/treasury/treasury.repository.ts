import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import {
  CashflowForecast, CashflowForecastListResult, CashflowSummaryRow, WorkingCapitalPosition,
} from './treasury.types';
import { CashflowDirection, CashflowCategory } from './treasury.constants';
import { ListQueryDto } from './treasury.dto';

// Columns of fin.cashflow_forecast (migration 034). Append-only — there is no
// row_version / is_deleted / updated_* column.
const COLS = `cf_id, company_id, bu_id, forecast_date, period_label, direction,
  category, amount, project_id, note, created_at, created_by`;

function mapForecast(r: QueryResultRow): CashflowForecast {
  return {
    cfId: Number(r.cf_id),
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    forecastDate: r.forecast_date,
    periodLabel: (r.period_label as string) ?? null,
    direction: r.direction as CashflowDirection,
    category: (r.category as CashflowCategory) ?? null,
    amount: Number(r.amount),
    projectId: r.project_id == null ? null : Number(r.project_id),
    note: (r.note as string) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at as string),
    createdBy: r.created_by == null ? null : Number(r.created_by),
  };
}

/** Fields accepted by an append. */
export interface ForecastInput {
  forecastDate?: string;
  periodLabel: string;
  direction: CashflowDirection;
  category?: string;
  amount: number;
  projectId?: number;
  note?: string;
}

export class TreasuryRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Append a new immutable cash-flow forecast row. company_id = ctx.companyId and
   * bu_id = ctx.buId so the row satisfies the per-company RLS policy. No optimistic
   * concurrency — the table is append-only (a correction is a new offsetting row).
   */
  async insert(ctx: RequestContext, f: ForecastInput): Promise<CashflowForecast> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.cashflow_forecast
           (company_id, bu_id, forecast_date, period_label, direction,
            category, amount, project_id, note, created_by)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLS}`,
        [
          ctx.companyId, ctx.buId, f.forecastDate ?? null, f.periodLabel, f.direction,
          f.category ?? null, f.amount, f.projectId ?? null, f.note ?? null, ctx.userId,
        ]);
      return mapForecast(res.rows[0]);
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<CashflowForecastListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.direction) { params.push(q.direction); where.push(`direction = $${params.length}`); }
    if (q.periodLabel) { params.push(q.periodLabel); where.push(`period_label = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.cashflow_forecast WHERE ${w}`, params)).rows[0].c);
      // Newest first: forecast_date then cf_id (snapshot order).
      const rows = await c.query(
        `SELECT ${COLS} FROM fin.cashflow_forecast WHERE ${w}
          ORDER BY forecast_date DESC, cf_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapForecast), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Net cash by period_label: SUM(amount) FILTER inflow minus SUM(amount) FILTER
   * outflow, grouped by period_label, chronologically ordered. Optional project filter.
   */
  async summary(ctx: RequestContext, projectId?: number): Promise<CashflowSummaryRow[]> {
    const params: unknown[] = [ctx.companyId];
    let extra = '';
    if (projectId) { params.push(projectId); extra = `AND project_id = $${params.length}`; }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT period_label,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'INFLOW'), 0)::float  AS inflow,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'OUTFLOW'), 0)::float AS outflow
           FROM fin.cashflow_forecast
          WHERE company_id = $1 ${extra}
          GROUP BY period_label
          ORDER BY period_label NULLS LAST`, params);
      return res.rows.map((r) => {
        const inflow = Number(r.inflow);
        const outflow = Number(r.outflow);
        return { periodLabel: (r.period_label as string) ?? null, inflow, outflow, net: inflow - outflow };
      });
    });
  }

  /**
   * Working-capital position: a point-in-time read combining the live AR / AP ledgers
   * with the forecast. arOutstanding = open AR invoice totals minus what has been
   * allocated against them; apOutstanding = open vendor-bill totals; netForecast =
   * forecast inflow minus outflow. All COALESCE'd to 0 and cast to float so an empty
   * company never returns null. company_id is filtered explicitly (and RLS-scoped).
   */
  async position(ctx: RequestContext): Promise<WorkingCapitalPosition> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT
           COALESCE((
             SELECT SUM(i.total_amount)
               FROM fin.invoice i
              WHERE i.company_id = $1 AND i.status NOT IN ('PAID','CANCELLED')
           ), 0)::float AS ar_gross,
           COALESCE((
             SELECT SUM(pa.allocated_amount)
               FROM fin.payment_allocation pa
               JOIN fin.invoice i ON i.invoice_id = pa.invoice_id
              WHERE i.company_id = $1 AND i.status NOT IN ('PAID','CANCELLED')
           ), 0)::float AS ar_allocated,
           COALESCE((
             SELECT SUM(vi.total_amount)
               FROM fin.vendor_invoice vi
              WHERE vi.company_id = $1 AND vi.status NOT IN ('PAID','DISPUTED')
           ), 0)::float AS ap_outstanding,
           COALESCE((
             SELECT SUM(amount) FILTER (WHERE direction = 'INFLOW')
                  - SUM(amount) FILTER (WHERE direction = 'OUTFLOW')
               FROM fin.cashflow_forecast
              WHERE company_id = $1
           ), 0)::float AS net_forecast`,
        [ctx.companyId]);
      const row = res.rows[0];
      const arOutstanding = Number(row.ar_gross) - Number(row.ar_allocated);
      const apOutstanding = Number(row.ap_outstanding);
      const netForecast = Number(row.net_forecast);
      return {
        arOutstanding,
        apOutstanding,
        netForecast,
        workingCapitalGap: arOutstanding - apOutstanding,
      };
    });
  }
}
