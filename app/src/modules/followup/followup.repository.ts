import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Followup } from './followup.types';
import {
  FollowupType, FollowupChannel, FollowupStatus, FollowupUrgency,
} from './followup.constants';

/**
 * Urgency is DERIVED on every read (never stored) — a CASE over the gap between
 * the scheduled date and today. MISSED = a still-PENDING follow-up whose date has
 * passed; DUE = due today; UPCOMING = within the last ~20% of its lead time;
 * NORMAL otherwise. DONE / CANCELLED short-circuit. daysRemaining is the signed
 * day delta (negative once overdue).
 */
const URGENCY_SQL = `
  CASE
    WHEN f.status='DONE' THEN 'DONE'
    WHEN f.status='CANCELLED' THEN 'CANCELLED'
    WHEN (f.scheduled_date - CURRENT_DATE) < 0 THEN 'MISSED'
    WHEN (f.scheduled_date - CURRENT_DATE) = 0 THEN 'DUE'
    WHEN (f.scheduled_date - CURRENT_DATE)
         <= CEIL(GREATEST(f.scheduled_date - f.created_at::date, 1) * 0.2) THEN 'UPCOMING'
    ELSE 'NORMAL'
  END`;

/**
 * Full projection of a follow-up enriched on read: parent enquiry no/customer,
 * the owner's name, plus the derived daysRemaining + urgency. `f` is the
 * sales.enquiry_followup alias; `e` the enquiry; `au` the assigned app_user.
 */
const SELECT_SQL = `
  SELECT f.followup_id, f.enquiry_id, e.enquiry_no, e.customer_name, f.seq,
         f.followup_type, f.channel, f.channel_other, f.location, f.scheduled_date,
         f.notes, f.status, f.outcome, f.assigned_to,
         COALESCE(au.full_name, au.username) AS assigned_to_name,
         f.completed_at, f.completed_by,
         (f.scheduled_date - CURRENT_DATE) AS days_remaining,
         ${URGENCY_SQL} AS urgency,
         f.created_at, f.row_version
    FROM sales.enquiry_followup f
    LEFT JOIN sales.enquiry e   ON e.enquiry_id = f.enquiry_id
    LEFT JOIN sec.app_user au   ON au.user_id = f.assigned_to`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapRow(r: QueryResultRow): Followup {
  return {
    followupId: Number(r.followup_id),
    enquiryId: Number(r.enquiry_id),
    enquiryNo: r.enquiry_no ?? null,
    customerName: r.customer_name ?? null,
    seq: Number(r.seq),
    followupType: r.followup_type as FollowupType,
    channel: (r.channel ?? null) as FollowupChannel | null,
    channelOther: r.channel_other ?? null,
    location: r.location ?? null,
    scheduledDate: r.scheduled_date,
    notes: r.notes ?? null,
    status: r.status as FollowupStatus,
    outcome: r.outcome ?? null,
    assignedTo: num(r.assigned_to),
    assignedToName: r.assigned_to_name ?? null,
    completedAt: r.completed_at == null ? null : iso(r.completed_at),
    completedBy: num(r.completed_by),
    daysRemaining: Number(r.days_remaining),
    urgency: r.urgency as FollowupUrgency,
    createdAt: iso(r.created_at),
    rowVersion: Number(r.row_version),
  };
}

/** Header fields the service supplies for create (seq/status are server-assigned). */
export interface CreateFollowupRow {
  enquiryId: number;
  followupType: FollowupType;
  channel?: FollowupChannel;
  channelOther?: string;
  location?: string;
  scheduledDate: string;
  notes?: string;
}

/** Editable fields for a PATCH (each optional; undefined = leave unchanged). */
export interface UpdateFollowupFields {
  status?: FollowupStatus;
  outcome?: string;
  notes?: string;
  scheduledDate?: string;
}

export class FollowupRepository {
  constructor(private readonly pool: Pool) {}

  /** True if the enquiry exists (non-deleted) in the caller's tenant. */
  async enquiryExists(ctx: RequestContext, enquiryId: number): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM sales.enquiry
          WHERE enquiry_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [enquiryId, ctx.companyId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Followup | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `${SELECT_SQL}
          WHERE f.followup_id = $1 AND f.company_id = $2 AND NOT f.is_deleted`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  /** The whole trail for one enquiry, ordered by seq ascending. */
  async listByEnquiry(ctx: RequestContext, enquiryId: number): Promise<Followup[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `${SELECT_SQL}
          WHERE f.enquiry_id = $1 AND f.company_id = $2 AND NOT f.is_deleted
          ORDER BY f.seq ASC`,
        [enquiryId, ctx.companyId],
      );
      return res.rows.map(mapRow);
    });
  }

  /**
   * Insert the next follow-up in the trail. seq is allocated as
   * max(seq)+1 for the enquiry (gapless within the same transaction); assigned_to
   * defaults to the enquiry's current owner; status starts PENDING.
   */
  async create(ctx: RequestContext, data: CreateFollowupRow): Promise<Followup> {
    return runInContext(this.pool, ctx, async (client: Queryable) => {
      const res = await client.query(
        `INSERT INTO sales.enquiry_followup
           (company_id, bu_id, enquiry_id, seq, followup_type, channel, channel_other,
            location, scheduled_date, notes, status, assigned_to, created_by)
         VALUES ($1, $2, $3,
            COALESCE((SELECT max(seq) FROM sales.enquiry_followup
                       WHERE enquiry_id = $3 AND NOT is_deleted), 0) + 1,
            $4, $5, $6, $7, $8::date, $9, 'PENDING',
            (SELECT assigned_to FROM sales.enquiry WHERE enquiry_id = $3),
            $10)
         RETURNING followup_id`,
        [
          ctx.companyId, ctx.buId, data.enquiryId, data.followupType,
          data.channel ?? null, data.channelOther ?? null, data.location ?? null,
          data.scheduledDate, data.notes ?? null, ctx.userId,
        ],
      );
      const id = Number(res.rows[0].followup_id);
      const read = await client.query(
        `${SELECT_SQL} WHERE f.followup_id = $1`, [id],
      );
      return mapRow(read.rows[0]);
    });
  }

  /**
   * Optimistic-locked update. When the new status is DONE, stamp completed_at /
   * completed_by. Returns null on a row-version mismatch (the service maps that to
   * 409 after confirming the row exists).
   */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number, fields: UpdateFollowupFields,
  ): Promise<Followup | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, val: unknown) => { params.push(val); set.push(sql.replace('$$', `$${params.length}`)); };
    if (fields.status !== undefined) add('status = $$', fields.status);
    if (fields.outcome !== undefined) add('outcome = $$', fields.outcome);
    if (fields.notes !== undefined) add('notes = $$', fields.notes);
    if (fields.scheduledDate !== undefined) add('scheduled_date = $$::date', fields.scheduledDate);
    // Completion stamp: set when transitioning to DONE, cleared when re-opened.
    if (fields.status === 'DONE') {
      params.push(ctx.userId);
      set.push(`completed_at = now(), completed_by = $${params.length}`);
    } else if (fields.status === 'PENDING') {
      set.push('completed_at = NULL, completed_by = NULL');
    }

    return runInContext(this.pool, ctx, async (client) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await client.query(
        `UPDATE sales.enquiry_followup
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(),
                row_version = row_version + 1
          WHERE followup_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted`,
        params,
      );
      if (!res.rowCount) return null;
      const read = await client.query(
        `${SELECT_SQL} WHERE f.followup_id = $1`, [id],
      );
      return mapRow(read.rows[0]);
    });
  }

  /**
   * All PENDING follow-ups for the company (optionally only the caller's),
   * ordered by scheduled_date ascending, each with the derived urgency — the
   * source rows for the alerting dashboard.
   */
  async dashboard(ctx: RequestContext, mine: boolean): Promise<Followup[]> {
    const params: unknown[] = [ctx.companyId];
    let extra = '';
    if (mine) { params.push(ctx.userId); extra = ` AND f.assigned_to = $${params.length}`; }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `${SELECT_SQL}
          WHERE f.company_id = $1 AND f.status = 'PENDING' AND NOT f.is_deleted${extra}
          ORDER BY f.scheduled_date ASC, f.followup_id ASC`,
        params,
      );
      return res.rows.map(mapRow);
    });
  }
}
