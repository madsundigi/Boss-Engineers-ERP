import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { OutboxEventInput, emitOutbox } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  Opportunity, OpportunityListResult, PipelineStageSummary,
  Activity, ActivityListResult, Customer360,
} from './crm.types';
import { ListOpportunityQueryDto, ListActivityQueryDto } from './crm.dto';
import { DOC_TYPE, OpportunityStage, ActivityStatus } from './crm.constants';

/** Columns of crm.opportunity (created in migration 039). */
const O = `opp_id, opp_no, company_id, bu_id, customer_id, enquiry_id, title, stage,
  est_value, probability_pct, expected_close_date, owner_id, lost_reason,
  created_at, created_by, updated_at, row_version`;

/** Columns of crm.activity. */
const A = `activity_id, company_id, opp_id, customer_id, activity_type, subject,
  due_date, completed_at, status, owner_id, notes,
  created_at, created_by, updated_at, row_version`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapOpp(r: QueryResultRow): Opportunity {
  return {
    oppId: Number(r.opp_id),
    oppNo: r.opp_no,
    companyId: Number(r.company_id),
    buId: num(r.bu_id),
    customerId: Number(r.customer_id),
    enquiryId: num(r.enquiry_id),
    title: r.title,
    stage: r.stage as OpportunityStage,
    estValue: Number(r.est_value),
    probabilityPct: Number(r.probability_pct),
    expectedCloseDate: r.expected_close_date,
    ownerId: num(r.owner_id),
    lostReason: r.lost_reason ?? null,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

function mapActivity(r: QueryResultRow): Activity {
  return {
    activityId: Number(r.activity_id),
    companyId: Number(r.company_id),
    oppId: num(r.opp_id),
    customerId: num(r.customer_id),
    activityType: r.activity_type,
    subject: r.subject,
    dueDate: r.due_date,
    completedAt: r.completed_at == null ? null : iso(r.completed_at),
    status: r.status as ActivityStatus,
    ownerId: num(r.owner_id),
    notes: r.notes ?? null,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Opportunity header fields the service supplies for create. */
export interface OpportunityInput {
  customerId: number;
  enquiryId?: number;
  title: string;
  estValue: number;
  probabilityPct: number;
  expectedCloseDate?: string;
  ownerId?: number;
}

/** Editable opportunity header fields (partial, for update). */
export interface OpportunityFields {
  title?: string;
  estValue?: number;
  probabilityPct?: number;
  expectedCloseDate?: string;
  ownerId?: number;
  enquiryId?: number;
}

const OPP_COL_OF: Record<string, string> = {
  title: 'title', estValue: 'est_value', probabilityPct: 'probability_pct',
  expectedCloseDate: 'expected_close_date', ownerId: 'owner_id', enquiryId: 'enquiry_id',
};

/** Activity fields the service supplies for create. */
export interface ActivityInput {
  oppId?: number;
  customerId?: number;
  activityType: string;
  subject: string;
  dueDate?: string;
  ownerId?: number;
  notes?: string;
}

export class CrmRepository {
  constructor(private readonly pool: Pool) {}

  // ---------------------------------------------------------------------------
  // Opportunity
  // ---------------------------------------------------------------------------

  /** Insert an opportunity (NEW), allocating the opp number in the same
   *  transaction. company_id = ctx.companyId so the row passes RLS WITH CHECK. */
  async createOpportunity(ctx: RequestContext, h: OpportunityInput): Promise<Opportunity> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `INSERT INTO crm.opportunity
           (company_id, bu_id, opp_no, customer_id, enquiry_id, title, stage,
            est_value, probability_pct, expected_close_date, owner_id, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,'NEW',$6,$7,$8::date,$9,$10)
         RETURNING ${O}`,
        [ctx.companyId, ctx.buId, h.customerId, h.enquiryId ?? null, h.title,
         h.estValue, h.probabilityPct, h.expectedCloseDate ?? null, h.ownerId ?? null, ctx.userId]);
      return mapOpp(res.rows[0]);
    });
  }

  async findOpportunity(ctx: RequestContext, id: number): Promise<Opportunity | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${O} FROM crm.opportunity WHERE opp_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapOpp(res.rows[0]) : null;
    });
  }

  async listOpportunities(ctx: RequestContext, q: ListOpportunityQueryDto): Promise<OpportunityListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.stage) { params.push(q.stage); where.push(`stage = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.ownerId) { params.push(q.ownerId); where.push(`owner_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(opp_no ILIKE $${params.length} OR title ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM crm.opportunity WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${O} FROM crm.opportunity WHERE ${w}
          ORDER BY ${q.sort} ${dir}, opp_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapOpp);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async updateOpportunity(
    ctx: RequestContext, id: number, version: number, fields: OpportunityFields,
  ): Promise<Opportunity | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v);
      const col = OPP_COL_OF[k];
      set.push(col === 'expected_close_date' ? `${col} = $${params.length}::date` : `${col} = $${params.length}`);
    }
    if (set.length === 0) return this.findOpportunity(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE crm.opportunity
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE opp_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${O}`, params);
      return res.rowCount ? mapOpp(res.rows[0]) : null;
    });
  }

  /**
   * Stage change under optimistic lock, with an optional outbox event (e.g.
   * 'opportunity.won' on win) emitted atomically with the change, plus an optional
   * lost_reason (set when moving to LOST). Returns null on a row-version mismatch.
   */
  async setStage(
    ctx: RequestContext, id: number, version: number, stage: OpportunityStage,
    opts: { lostReason?: string; event?: OutboxEventInput } = {},
  ): Promise<Opportunity | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE crm.opportunity
            SET stage = $1, lost_reason = $2,
                updated_by = $3, updated_at = now(), row_version = row_version + 1
          WHERE opp_id = $4 AND row_version = $5 AND company_id = $6 AND NOT is_deleted
          RETURNING ${O}`,
        [stage, opts.lostReason ?? null, ctx.userId, id, version, ctx.companyId]);
      if (!res.rowCount) return null;
      if (opts.event) await emitOutbox(c, opts.event);
      return mapOpp(res.rows[0]);
    });
  }

  async softDeleteOpportunity(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE crm.opportunity
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE opp_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Pipeline summary: count + total est_value of the (open + closed) opportunities
   * grouped by stage, optionally scoped to one customer. Reads as a single GROUP BY.
   */
  async pipelineSummary(ctx: RequestContext, customerId?: number): Promise<PipelineStageSummary[]> {
    const params: unknown[] = [ctx.companyId];
    let extra = '';
    if (customerId) { params.push(customerId); extra = `AND customer_id = $${params.length}`; }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT stage, count(*)::int AS n, COALESCE(sum(est_value),0)::text AS v
           FROM crm.opportunity
          WHERE company_id = $1 AND NOT is_deleted ${extra}
          GROUP BY stage`, params);
      return res.rows.map((r) => ({
        stage: r.stage as OpportunityStage, count: Number(r.n), totalEstValue: Number(r.v),
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------

  async createActivity(ctx: RequestContext, a: ActivityInput): Promise<Activity> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO crm.activity
           (company_id, opp_id, customer_id, activity_type, subject, due_date,
            status, owner_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::date,'PENDING',$7,$8,$9)
         RETURNING ${A}`,
        [ctx.companyId, a.oppId ?? null, a.customerId ?? null, a.activityType, a.subject,
         a.dueDate ?? null, a.ownerId ?? null, a.notes ?? null, ctx.userId]);
      return mapActivity(res.rows[0]);
    });
  }

  async findActivity(ctx: RequestContext, id: number): Promise<Activity | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${A} FROM crm.activity WHERE activity_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapActivity(res.rows[0]) : null;
    });
  }

  async listActivities(ctx: RequestContext, q: ListActivityQueryDto): Promise<ActivityListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.oppId) { params.push(q.oppId); where.push(`opp_id = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.activityType) { params.push(q.activityType); where.push(`activity_type = $${params.length}`); }
    if (q.overdue) { where.push(`status = 'PENDING' AND due_date IS NOT NULL AND due_date < current_date`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM crm.activity WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${A} FROM crm.activity WHERE ${w}
          ORDER BY ${q.sort} ${dir} NULLS LAST, activity_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapActivity);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Complete an activity (-> DONE, stamp completed_at) under optimistic lock.
   * Returns null on a row-version mismatch.
   */
  async completeActivity(ctx: RequestContext, id: number, version: number): Promise<Activity | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE crm.activity
            SET status = 'DONE', completed_at = now(),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE activity_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted
          RETURNING ${A}`,
        [ctx.userId, id, version, ctx.companyId]);
      return res.rowCount ? mapActivity(res.rows[0]) : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Customer 360
  // ---------------------------------------------------------------------------

  /**
   * Aggregate the customer-360 view in a single connection: the customer's
   * opportunities grouped by stage, their open (PENDING) activities, and enquiry /
   * quotation counts (sales.enquiry / sales.quotation, both company-scoped).
   */
  async customer360(ctx: RequestContext, customerId: number): Promise<Customer360> {
    return runRead(this.pool, ctx, async (c) => {
      const pipe = await c.query(
        `SELECT stage, count(*)::int AS n, COALESCE(sum(est_value),0)::text AS v
           FROM crm.opportunity
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
          GROUP BY stage`, [ctx.companyId, customerId]);
      const pipeline: PipelineStageSummary[] = pipe.rows.map((r) => ({
        stage: r.stage as OpportunityStage, count: Number(r.n), totalEstValue: Number(r.v),
      }));

      const acts = await c.query(
        `SELECT ${A} FROM crm.activity
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted AND status = 'PENDING'
          ORDER BY due_date ASC NULLS LAST, activity_id DESC LIMIT 100`, [ctx.companyId, customerId]);
      const openActivities = acts.rows.map(mapActivity);

      const enq = await c.query(
        `SELECT count(*)::int AS n FROM sales.enquiry
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted`, [ctx.companyId, customerId]);
      const quo = await c.query(
        `SELECT count(*)::int AS n FROM sales.quotation
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted`, [ctx.companyId, customerId]);

      const openOpportunityCount = pipeline
        .filter((p) => p.stage !== 'WON' && p.stage !== 'LOST')
        .reduce((s, p) => s + p.count, 0);
      const wonOpportunityCount = pipeline
        .filter((p) => p.stage === 'WON')
        .reduce((s, p) => s + p.count, 0);

      return {
        customerId,
        pipeline,
        openActivities,
        enquiryCount: Number(enq.rows[0].n),
        quotationCount: Number(quo.rows[0].n),
        openOpportunityCount,
        wonOpportunityCount,
      };
    });
  }
}
