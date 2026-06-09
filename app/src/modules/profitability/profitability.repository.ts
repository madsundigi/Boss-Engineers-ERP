import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  MarginSnapshot, MarginSnapshotListResult, PortfolioMarginRow, CostCategoryRow,
} from './profitability.types';
import { ListQueryDto } from './profitability.dto';
import { COST_STAGE } from './profitability.constants';

// Columns of fin.margin_snapshot (company_id added in migration 023 for RLS).
const COLS = `snapshot_id, project_id, snapshot_date, revenue, committed_cost,
  actual_cost, forecast_cost_eac, margin_pct, cpi, spi`;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function mapSnapshot(r: QueryResultRow): MarginSnapshot {
  return {
    snapshotId: Number(r.snapshot_id),
    projectId: Number(r.project_id),
    snapshotDate: r.snapshot_date,
    revenue: num(r.revenue),
    committedCost: num(r.committed_cost),
    actualCost: num(r.actual_cost),
    forecastCostEac: num(r.forecast_cost_eac),
    marginPct: numOrNull(r.margin_pct),
    cpi: numOrNull(r.cpi),
    spi: numOrNull(r.spi),
  };
}

/** Minimal project projection used to validate existence + scope the snapshot. */
export interface ProjectRef {
  projectId: number;
  companyId: number;
  status: string;
}

/**
 * The financial inputs aggregated from the source ledgers for one project, used
 * to derive a snapshot. Costs are summed from fin.project_cost_ledger by stage;
 * revenue is Σ taxable_amount of non-CANCELLED invoices.
 */
export interface ProjectFinancials {
  revenue: number;
  budgetCost: number;
  committedCost: number;
  actualCost: number;
}

/** Fields written by an append (margin_pct/cpi/spi derived by the service). */
export interface SnapshotInput {
  projectId: number;
  snapshotDate?: string;
  revenue: number;
  committedCost: number;
  actualCost: number;
  forecastCostEac: number;
  marginPct: number | null;
  cpi: number | null;
  spi: number | null;
}

export class ProfitabilityRepository {
  constructor(private readonly pool: Pool) {}

  /** Load a project (company-scoped by RLS); null -> service raises 404. */
  async findProject(ctx: RequestContext, projectId: number): Promise<ProjectRef | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT project_id, company_id, status FROM proj.project
          WHERE project_id = $1 AND is_deleted = false`,
        [projectId]);
      if (!res.rowCount) return null;
      const r = res.rows[0];
      return { projectId: Number(r.project_id), companyId: Number(r.company_id), status: r.status };
    });
  }

  /**
   * Aggregate the financial inputs for a project. Costs come from
   * fin.project_cost_ledger summed by cost_stage; revenue is Σ taxable_amount of
   * the project's non-CANCELLED invoices (we use invoice taxable_amount rather
   * than fin.revenue_recognition for a single, simple revenue basis).
   */
  async aggregateFinancials(ctx: RequestContext, projectId: number): Promise<ProjectFinancials> {
    return runRead(this.pool, ctx, async (c) => {
      const cost = await c.query<{ cost_stage: string; total: string }>(
        `SELECT cost_stage, COALESCE(SUM(amount), 0)::text AS total
           FROM fin.project_cost_ledger
          WHERE project_id = $1
          GROUP BY cost_stage`,
        [projectId]);
      const byStage: Record<string, number> = {};
      for (const row of cost.rows) byStage[row.cost_stage] = Number(row.total);

      const rev = await c.query<{ revenue: string }>(
        `SELECT COALESCE(SUM(taxable_amount), 0)::text AS revenue
           FROM fin.invoice
          WHERE project_id = $1 AND status <> 'CANCELLED'`,
        [projectId]);

      return {
        revenue: Number(rev.rows[0].revenue),
        budgetCost: byStage[COST_STAGE.BUDGET] ?? 0,
        committedCost: byStage[COST_STAGE.COMMITTED] ?? 0,
        actualCost: byStage[COST_STAGE.ACTUAL] ?? 0,
      };
    });
  }

  /**
   * Project cost broken down by CATEGORY (cost_type): one row per cost_type present
   * on the project's ledger with its summed amount, ordered by amount DESC. Scoped
   * by RLS plus an explicit company_id; aggregates across all stages (a category's
   * full ledger spend). An empty ledger yields [].
   */
  async costByCategory(ctx: RequestContext, projectId: number): Promise<CostCategoryRow[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ cost_type: string; amount: string }>(
        `SELECT cost_type, COALESCE(SUM(amount), 0)::text AS amount
           FROM fin.project_cost_ledger
          WHERE project_id = $1 AND company_id = $2
          GROUP BY cost_type
          ORDER BY SUM(amount) DESC, cost_type ASC`,
        [projectId, ctx.companyId]);
      return res.rows.map((r) => ({ category: r.cost_type, amount: Number(r.amount) }));
    });
  }

  /**
   * Append a new immutable margin snapshot. company_id = ctx.companyId so the row
   * satisfies the per-company RLS policy. Emits the 'margin.snapshot.created'
   * outbox event atomically with the insert (transactional outbox). No optimistic
   * concurrency — the table is append-only.
   */
  async insert(
    ctx: RequestContext, s: SnapshotInput, event?: OutboxEventInput,
  ): Promise<MarginSnapshot> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.margin_snapshot
           (company_id, project_id, snapshot_date, revenue, committed_cost,
            actual_cost, forecast_cost_eac, margin_pct, cpi, spi)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLS}`,
        [
          ctx.companyId, s.projectId, s.snapshotDate ?? null, s.revenue, s.committedCost,
          s.actualCost, s.forecastCostEac, s.marginPct, s.cpi, s.spi,
        ]);
      const row = mapSnapshot(res.rows[0]);
      if (event) await emitOutbox(c, event);
      return row;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<MarginSnapshotListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.fromDate) { params.push(q.fromDate); where.push(`snapshot_date >= $${params.length}`); }
    if (q.toDate) { params.push(q.toDate); where.push(`snapshot_date <= $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.margin_snapshot WHERE ${w}`, params)).rows[0].c);
      // Newest first: snapshot_date then snapshot_id (snapshot order).
      const rows = await c.query(
        `SELECT ${COLS} FROM fin.margin_snapshot WHERE ${w}
          ORDER BY snapshot_date DESC, snapshot_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapSnapshot), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Most recent snapshot for a project (by snapshot_date, then snapshot_id). */
  async findLatestForProject(ctx: RequestContext, projectId: number): Promise<MarginSnapshot | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM fin.margin_snapshot
          WHERE company_id = $1 AND project_id = $2
          ORDER BY snapshot_date DESC, snapshot_id DESC LIMIT 1`,
        [ctx.companyId, projectId]);
      return res.rowCount ? mapSnapshot(res.rows[0]) : null;
    });
  }

  /**
   * One row per project: the headline figures from each project's LATEST snapshot
   * (company-scoped). DISTINCT ON picks the newest snapshot per project_id.
   */
  async portfolioMargin(ctx: RequestContext): Promise<PortfolioMarginRow[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT DISTINCT ON (project_id)
                project_id, snapshot_id, snapshot_date, revenue, actual_cost, margin_pct
           FROM fin.margin_snapshot
          WHERE company_id = $1
          ORDER BY project_id, snapshot_date DESC, snapshot_id DESC`,
        [ctx.companyId]);
      return res.rows.map((r) => ({
        projectId: Number(r.project_id),
        snapshotId: Number(r.snapshot_id),
        snapshotDate: r.snapshot_date,
        revenue: num(r.revenue),
        actualCost: num(r.actual_cost),
        marginPct: numOrNull(r.margin_pct),
      }));
    });
  }
}
