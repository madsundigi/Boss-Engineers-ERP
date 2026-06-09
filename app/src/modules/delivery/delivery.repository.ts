import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { DeliveryForecast, DeliveryForecastListResult, DeliveryRiskSignals } from './delivery.types';
import { ListQueryDto } from './delivery.dto';
import {
  PO_SETTLED_STATUSES,
  WO_FINISHED_STATUSES,
  FAT_PENDING_OR_FAILED_STATUSES,
} from './delivery.constants';

// Columns of proj.delivery_forecast (company_id added in migration 017 for RLS).
// delay_days is a GENERATED column (predicted_delivery - committed_delivery): it is
// SELECT-ed here but MUST NOT appear in any INSERT/UPDATE column list.
const COLS = `forecast_id, project_id, forecast_date, predicted_delivery,
  committed_delivery, delay_days, risk_level, driver, created_at, created_by`;

function mapForecast(r: QueryResultRow): DeliveryForecast {
  return {
    forecastId: Number(r.forecast_id),
    projectId: Number(r.project_id),
    forecastDate: r.forecast_date,
    predictedDelivery: r.predicted_delivery,
    committedDelivery: r.committed_delivery,
    delayDays: r.delay_days == null ? null : Number(r.delay_days),
    riskLevel: r.risk_level,
    driver: r.driver,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
  };
}

/** Fields accepted by an append (delay_days excluded — it is generated). */
export interface ForecastInput {
  projectId: number;
  forecastDate?: string;
  predictedDelivery: string;
  committedDelivery?: string;
  riskLevel?: string;
  driver?: string;
}

export class DeliveryRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Append a new immutable forecast snapshot. company_id = ctx.companyId so the
   * row satisfies the per-company RLS policy. Optionally emits an outbox event
   * (e.g. 'delivery.at_risk' on a HIGH-risk forecast) atomically with the insert
   * (transactional outbox). No optimistic concurrency — the table is append-only.
   */
  async insert(
    ctx: RequestContext, f: ForecastInput, event?: OutboxEventInput,
  ): Promise<DeliveryForecast> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.delivery_forecast
           (company_id, project_id, forecast_date, predicted_delivery,
            committed_delivery, risk_level, driver, created_by)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8)
         RETURNING ${COLS}`,
        [
          ctx.companyId, f.projectId, f.forecastDate ?? null, f.predictedDelivery,
          f.committedDelivery ?? null, f.riskLevel ?? null, f.driver ?? null, ctx.userId,
        ]);
      const row = mapForecast(res.rows[0]);
      // Atomic with the insert: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return row;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<DeliveryForecastListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.riskLevel) { params.push(q.riskLevel); where.push(`risk_level = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM proj.delivery_forecast WHERE ${w}`, params)).rows[0].c);
      // Newest first: forecast_date then forecast_id (snapshot order).
      const rows = await c.query(
        `SELECT ${COLS} FROM proj.delivery_forecast WHERE ${w}
          ORDER BY forecast_date DESC, forecast_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapForecast), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Most recent forecast for a project (by forecast_date, then forecast_id). */
  async findLatestForProject(ctx: RequestContext, projectId: number): Promise<DeliveryForecast | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM proj.delivery_forecast
          WHERE company_id = $1 AND project_id = $2
          ORDER BY forecast_date DESC, forecast_id DESC LIMIT 1`,
        [ctx.companyId, projectId]);
      return res.rowCount ? mapForecast(res.rows[0]) : null;
    });
  }

  /* --- AUTO delivery-risk: read-only cross-module signal aggregation --------- *
   * Owns no table here either: every query runs inside one runRead transaction
   * (RLS role + app.company_id GUC) and also filters company_id = $1 + project_id
   * = $2 explicitly (defence in depth, mirrors DashboardRepository). Each count is
   * cast to ::int so an empty table yields the JS number 0. NOT is_deleted skips
   * soft-deleted rows (matches the procurement read path).                       */

  /** True iff the project exists for this company (drives the 404). */
  async projectExists(ctx: RequestContext, projectId: number): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const r = await c.query(
        `SELECT 1 FROM proj.project
          WHERE project_id = $1 AND company_id = $2 AND NOT is_deleted LIMIT 1`,
        [projectId, ctx.companyId]);
      return r.rowCount! > 0;
    });
  }

  /**
   * The three upstream delay signals for one project, in a single read txn:
   *  - overduePurchaseOrders: scm.purchase_order pegged to the project, not yet
   *    settled (status NOT IN RECEIVED/CLOSED/CANCELLED) whose expected_date has
   *    passed. expected_date is nullable; the comparison drops NULLs, so a PO with
   *    no promised date is never counted as overdue.
   *  - delayedWorkOrders: mfg.work_order for the project, not finished (status NOT
   *    IN COMPLETED/CLOSED/CANCELLED) whose planned_end has passed (NULLs dropped).
   *  - pendingOrFailedFats: qms.fat_execution for the project whose lifecycle
   *    status is SCHEDULED/IN_PROGRESS/FAILED (i.e. not yet passed/cleared, or failed).
   */
  async fetchRiskSignals(ctx: RequestContext, projectId: number): Promise<DeliveryRiskSignals> {
    return runRead(this.pool, ctx, async (c) => {
      const [overduePurchaseOrders, delayedWorkOrders, pendingOrFailedFats] = await Promise.all([
        this.countScalar(c,
          `SELECT count(*)::int AS n FROM scm.purchase_order
            WHERE company_id = $1 AND project_id = $2 AND NOT is_deleted
              AND status <> ALL($3::text[])
              AND expected_date < CURRENT_DATE`,
          [ctx.companyId, projectId, [...PO_SETTLED_STATUSES]]),
        this.countScalar(c,
          `SELECT count(*)::int AS n FROM mfg.work_order
            WHERE company_id = $1 AND project_id = $2 AND NOT is_deleted
              AND status <> ALL($3::text[])
              AND planned_end < CURRENT_DATE`,
          [ctx.companyId, projectId, [...WO_FINISHED_STATUSES]]),
        this.countScalar(c,
          `SELECT count(*)::int AS n FROM qms.fat_execution
            WHERE company_id = $1 AND project_id = $2 AND NOT is_deleted
              AND status = ANY($3::text[])`,
          [ctx.companyId, projectId, [...FAT_PENDING_OR_FAILED_STATUSES]]),
      ]);
      return { overduePurchaseOrders, delayedWorkOrders, pendingOrFailedFats };
    });
  }

  /** Run a `SELECT count(*)::int AS n ...` and return it as a JS number (0 on empty). */
  private async countScalar(c: Queryable, sql: string, params: unknown[]): Promise<number> {
    const r = await c.query<{ n: number }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  }
}
