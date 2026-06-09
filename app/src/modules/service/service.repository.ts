import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  ServiceTicket, ServiceTicketDetail, FieldVisit, SpareIssue, ServiceTicketListResult,
  WarrantyClaim, ServiceKpis, WarrantyCostReport,
} from './service.types';
import { ListQueryDto } from './service.dto';
import { DOC_TYPE, ServiceTicketStatus, ClaimStatus } from './service.constants';

/**
 * Header columns of svc.service_ticket. bu_id + assigned_engineer_id are added in
 * migration 015; company_id, row_version, is_deleted already exist on the base
 * table (db/04).
 */
const H = `ticket_id, ticket_no, company_id, bu_id, customer_id, serial_id, warranty_id,
  contract_id, complaint, priority, is_in_warranty, reported_at, sla_due_at, resolved_at, resolution,
  csat_rating, status, assigned_engineer_id, created_at, created_by, updated_at, row_version`;

type Header = Omit<ServiceTicket, 'visits' | 'spares'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    ticketId: Number(r.ticket_id),
    ticketNo: r.ticket_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    customerId: Number(r.customer_id),
    serialId: r.serial_id == null ? null : Number(r.serial_id),
    warrantyId: r.warranty_id == null ? null : Number(r.warranty_id),
    contractId: r.contract_id == null ? null : Number(r.contract_id),
    complaint: r.complaint,
    priority: r.priority,
    isInWarranty: r.is_in_warranty,
    reportedAt: r.reported_at,
    slaDueAt: r.sla_due_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    csatRating: r.csat_rating == null ? null : Number(r.csat_rating),
    status: r.status,
    assignedEngineerId: r.assigned_engineer_id == null ? null : Number(r.assigned_engineer_id),
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapVisit(r: QueryResultRow): FieldVisit {
  return {
    visitId: Number(r.visit_id),
    engineerId: r.engineer_id == null ? null : Number(r.engineer_id),
    visitDate: r.visit_date,
    hours: r.hours == null ? null : Number(r.hours),
    travelCost: Number(r.travel_cost),
    notes: r.notes,
  };
}
function mapSpare(r: QueryResultRow): SpareIssue {
  return {
    spareIssueId: Number(r.spare_issue_id),
    itemId: Number(r.item_id),
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    isChargeable: r.is_chargeable,
  };
}
function mapClaim(r: QueryResultRow): WarrantyClaim {
  return {
    claimId: Number(r.claim_id),
    warrantyId: Number(r.warranty_id),
    ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
    claimDate: r.claim_date,
    claimCost: Number(r.claim_cost),
    status: r.status,
    approvedBy: r.approved_by == null ? null : Number(r.approved_by),
  };
}

export interface TicketHeaderInput {
  customerId: number;
  serialId?: number;
  warrantyId?: number;
  contractId?: number;
  complaint?: string;
  priority?: string;
  isInWarranty?: boolean;
  reportedAt?: string;
  slaDueAt?: string;
}
/** Partial header patch carried alongside a status / assignment change. */
export type StatusPatch = Partial<Record<
  'assigned_engineer_id' | 'resolution' | 'sla_due_at' | 'resolved_at' | 'csat_rating', unknown
>>;

/** Optional company-scoped window for the KPI aggregation (resolved_at-based). */
export interface KpiWindow {
  fromDate?: string; // YYYY-MM-DD inclusive lower bound on reported_at
  toDate?: string;   // YYYY-MM-DD inclusive upper bound on reported_at
}

/** Optional company-scoped window/filter for the Warranty Cost Analysis roll-up. */
export interface WarrantyCostWindow {
  fromDate?: string;       // YYYY-MM-DD inclusive lower bound on reported_at
  toDate?: string;         // YYYY-MM-DD inclusive upper bound on reported_at
  inWarrantyOnly?: boolean; // restrict to is_in_warranty tickets
}

export class ServiceRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchVisits(q: Queryable, id: number): Promise<FieldVisit[]> {
    const res = await q.query(
      `SELECT visit_id, engineer_id, visit_date, hours, travel_cost, notes
         FROM svc.field_visit WHERE ticket_id = $1 ORDER BY visit_id`, [id]);
    return res.rows.map(mapVisit);
  }
  private async fetchSpares(q: Queryable, id: number): Promise<SpareIssue[]> {
    const res = await q.query(
      `SELECT spare_issue_id, item_id, qty, unit_cost, is_chargeable
         FROM svc.spare_issue WHERE ticket_id = $1 ORDER BY spare_issue_id`, [id]);
    return res.rows.map(mapSpare);
  }
  private async insertVisits(q: Queryable, id: number, visits: FieldVisit[]): Promise<void> {
    for (const v of visits) {
      await q.query(
        `INSERT INTO svc.field_visit
           (ticket_id, engineer_id, visit_date, hours, travel_cost, notes)
         VALUES ($1,$2, COALESCE($3::date, current_date), $4, $5, $6)`,
        [id, v.engineerId ?? null, v.visitDate ?? null, v.hours ?? null, v.travelCost, v.notes ?? null]);
    }
  }
  private async insertSpares(q: Queryable, id: number, spares: SpareIssue[]): Promise<void> {
    for (const s of spares) {
      await q.query(
        `INSERT INTO svc.spare_issue (ticket_id, item_id, qty, unit_cost, is_chargeable)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, s.itemId, s.qty, s.unitCost, s.isChargeable]);
    }
  }

  /** Insert, allocating the gapless ticket number inside the same transaction. */
  async create(
    ctx: RequestContext, h: TicketHeaderInput, visits: FieldVisit[], spares: SpareIssue[],
  ): Promise<ServiceTicket> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO svc.service_ticket
           (company_id, bu_id, ticket_no, customer_id, serial_id, warranty_id, contract_id,
            complaint, priority, is_in_warranty, reported_at, sla_due_at, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6, $7, COALESCE($8,'MED'), COALESCE($9,false),
                 COALESCE($10::timestamptz, now()), $11, 'OPEN', $12)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.customerId, h.serialId ?? null, h.warrantyId ?? null,
          h.contractId ?? null, h.complaint ?? null, h.priority ?? null, h.isInWarranty ?? null,
          h.reportedAt ?? null, h.slaDueAt ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertVisits(c, header.ticketId, visits);
      await this.insertSpares(c, header.ticketId, spares);
      return {
        ...header,
        visits: await this.fetchVisits(c, header.ticketId),
        spares: await this.fetchSpares(c, header.ticketId),
      };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<ServiceTicketDetail | null> {
    return runRead(this.pool, ctx, async (c) => {
      // Service Cost is computed (NOT stored): field-visit travel cost + spare-part
      // value (qty * unit_cost) for this ticket, via correlated subqueries. Each is
      // COALESCEd to 0 so a ticket with no visits/spares yields 0 (never NULL).
      const res = await c.query(
        `SELECT ${H},
            ( COALESCE((SELECT SUM(fv.travel_cost)
                          FROM svc.field_visit fv WHERE fv.ticket_id = t.ticket_id), 0)
            + COALESCE((SELECT SUM(si.qty * si.unit_cost)
                          FROM svc.spare_issue si WHERE si.ticket_id = t.ticket_id), 0)
            )::float8 AS service_cost
           FROM svc.service_ticket t
          WHERE t.ticket_id = $1 AND t.company_id = $2 AND NOT t.is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return {
        ...mapHeader(res.rows[0]),
        serviceCost: Number(res.rows[0].service_cost),
        visits: await this.fetchVisits(c, id),
        spares: await this.fetchSpares(c, id),
      };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<ServiceTicketListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.priority) { params.push(q.priority); where.push(`priority = $${params.length}`); }
    if (q.inWarranty !== undefined) { params.push(q.inWarranty); where.push(`is_in_warranty = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`ticket_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM svc.service_ticket WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM svc.service_ticket WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Warranty & Service KPI roll-up — READ-ONLY, company-scoped (RLS + explicit
   * company_id), filtered on the (non-deleted) ticket population. An optional
   * window bounds reported_at to a date range. Every figure is COALESCEd so an
   * empty company returns a fully-populated zero object (never NULL / never throws).
   *
   * First-Time-Fix is derived from svc.field_visit: a resolved ticket "fixed first
   * time" iff it has EXACTLY ONE field visit (GROUP BY ticket_id HAVING count = 1).
   * Tickets with zero visits (e.g. remote / phone fixes that were never logged as a
   * site visit) are NOT counted as first-time-fix — FTF here means "one visit
   * resolved it", which is the field-service definition. resolvedCount is the
   * denominator (status RESOLVED or CLOSED).
   */
  async kpis(ctx: RequestContext, window: KpiWindow = {}): Promise<ServiceKpis> {
    return runRead(this.pool, ctx, async (c) => {
      const params: unknown[] = [ctx.companyId];
      let dateFilter = '';
      if (window.fromDate) { params.push(window.fromDate); dateFilter += ` AND reported_at >= $${params.length}::date`; }
      if (window.toDate) {
        params.push(window.toDate);
        // inclusive upper bound on the calendar day
        dateFilter += ` AND reported_at < ($${params.length}::date + interval '1 day')`;
      }
      const scope = `company_id = $1 AND NOT is_deleted${dateFilter}`;

      // One pass over the ticket header for the count / time / SLA / CSAT figures.
      const agg = await c.query<{
        total: string; resolved_cnt: string;
        mttr_hours: number; sla_pct: number | null;
        csat_avg: number | null; csat_cnt: string;
      }>(
        `SELECT
            count(*)::text AS total,
            count(*) FILTER (WHERE status IN ('RESOLVED','CLOSED'))::text AS resolved_cnt,
            COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - reported_at)) / 3600.0)
                       FILTER (WHERE resolved_at IS NOT NULL), 0)::float8 AS mttr_hours,
            (100.0 * count(*) FILTER (WHERE resolved_at IS NOT NULL
                                        AND sla_due_at IS NOT NULL
                                        AND resolved_at <= sla_due_at)
              / NULLIF(count(*) FILTER (WHERE resolved_at IS NOT NULL
                                          AND sla_due_at IS NOT NULL), 0))::float8 AS sla_pct,
            AVG(csat_rating) FILTER (WHERE csat_rating IS NOT NULL)::float8 AS csat_avg,
            count(*) FILTER (WHERE csat_rating IS NOT NULL)::text AS csat_cnt
           FROM svc.service_ticket
          WHERE ${scope}`, params);

      // First-Time-Fix: resolved tickets resolved in exactly one field visit, over
      // all resolved tickets. Visits are joined per ticket; tickets with no visit
      // row contribute 0 to the FTF numerator (LEFT JOIN -> count = 0).
      const ftf = await c.query<{ resolved: string; one_visit: string }>(
        `SELECT
            count(*)::text AS resolved,
            count(*) FILTER (WHERE v.visit_cnt = 1)::text AS one_visit
           FROM svc.service_ticket t
           LEFT JOIN (
             SELECT ticket_id, count(*) AS visit_cnt
               FROM svc.field_visit GROUP BY ticket_id
           ) v ON v.ticket_id = t.ticket_id
          WHERE ${scope} AND t.status IN ('RESOLVED','CLOSED')`,
        params);

      const a = agg.rows[0];
      const f = ftf.rows[0];
      const total = Number(a.total);
      const resolvedCount = Number(a.resolved_cnt);
      const resolvedForFtf = Number(f.resolved);
      const oneVisit = Number(f.one_visit);
      return {
        mttrHours: Number(a.mttr_hours) || 0,
        slaCompliancePct: a.sla_pct == null ? 0 : Number(a.sla_pct),
        csatAvg: a.csat_avg == null ? 0 : Number(a.csat_avg),
        csatCount: Number(a.csat_cnt),
        firstTimeFixPct: resolvedForFtf === 0 ? 0 : (100 * oneVisit) / resolvedForFtf,
        resolvedCount,
        openCount: total - resolvedCount,
        totalTickets: total,
      };
    });
  }

  /**
   * Warranty Cost Analysis roll-up — READ-ONLY, company-scoped (RLS + explicit
   * company_id), over the (non-deleted) ticket population. Sums the THREE warranty
   * cost sources per ticket — field-visit travel cost, spare-part value
   * (qty * unit_cost), and warranty-claim cost — exactly the fragments the
   * ticket-detail serviceCost uses (plus claims). Each child is pre-aggregated to a
   * per-ticket subtotal in its own subquery and LEFT JOINed so the 1-to-many child
   * rows never Cartesian-multiply one another; every figure is COALESCEd to 0 so an
   * empty company returns zero totals + empty breakdowns (never NULL / never throws).
   *
   * `byCustomer` lists the top cost drivers (totalCost desc) joined to
   * mdm.customer for the name; `byMonth` buckets reported_at into 'YYYY-MM',
   * ascending. An optional window bounds reported_at and/or restricts to
   * is_in_warranty tickets.
   */
  async warrantyCost(ctx: RequestContext, window: WarrantyCostWindow = {}): Promise<WarrantyCostReport> {
    return runRead(this.pool, ctx, async (c) => {
      const params: unknown[] = [ctx.companyId];
      let filter = '';
      if (window.fromDate) {
        params.push(window.fromDate);
        filter += ` AND t.reported_at >= $${params.length}::date`;
      }
      if (window.toDate) {
        params.push(window.toDate);
        // inclusive upper bound on the calendar day
        filter += ` AND t.reported_at < ($${params.length}::date + interval '1 day')`;
      }
      if (window.inWarrantyOnly) filter += ' AND t.is_in_warranty';
      const scope = `t.company_id = $1 AND NOT t.is_deleted${filter}`;

      // Per-ticket cost basis: each cost source is summed to a per-ticket subtotal
      // in its own subquery (so the child fan-out never multiplies the others),
      // then LEFT JOINed onto the in-scope ticket header.
      const ticketCte = `
        SELECT t.ticket_id, t.customer_id, t.is_in_warranty, t.reported_at,
               COALESCE(fv.travel_cost, 0) AS travel_cost,
               COALESCE(sp.spare_cost, 0)  AS spare_cost,
               COALESCE(wc.claim_cost, 0)  AS claim_cost
          FROM svc.service_ticket t
          LEFT JOIN (SELECT ticket_id, SUM(travel_cost) AS travel_cost
                       FROM svc.field_visit GROUP BY ticket_id) fv ON fv.ticket_id = t.ticket_id
          LEFT JOIN (SELECT ticket_id, SUM(qty * unit_cost) AS spare_cost
                       FROM svc.spare_issue GROUP BY ticket_id) sp ON sp.ticket_id = t.ticket_id
          LEFT JOIN (SELECT ticket_id, SUM(claim_cost) AS claim_cost
                       FROM svc.warranty_claim WHERE ticket_id IS NOT NULL GROUP BY ticket_id) wc
                 ON wc.ticket_id = t.ticket_id
         WHERE ${scope}`;

      // Header totals — one row, always present, every figure COALESCEd to 0.
      const totalsRow = (await c.query<{
        tickets: string; in_warranty_tickets: string;
        travel_cost: number; spare_cost: number; claim_cost: number; total_cost: number;
      }>(
        `SELECT
            count(*)::text AS tickets,
            count(*) FILTER (WHERE tc.is_in_warranty)::text AS in_warranty_tickets,
            COALESCE(SUM(tc.travel_cost), 0)::float8 AS travel_cost,
            COALESCE(SUM(tc.spare_cost), 0)::float8  AS spare_cost,
            COALESCE(SUM(tc.claim_cost), 0)::float8  AS claim_cost,
            COALESCE(SUM(tc.travel_cost + tc.spare_cost + tc.claim_cost), 0)::float8 AS total_cost
           FROM (${ticketCte}) tc`, params)).rows[0];

      // Top cost drivers by customer (desc); customer_name from mdm.customer.
      const byCustomer = (await c.query<{
        customer_id: string; customer_name: string | null; tickets: string; total_cost: number;
      }>(
        `SELECT tc.customer_id,
                cu.customer_name,
                count(*)::text AS tickets,
                COALESCE(SUM(tc.travel_cost + tc.spare_cost + tc.claim_cost), 0)::float8 AS total_cost
           FROM (${ticketCte}) tc
           LEFT JOIN mdm.customer cu ON cu.customer_id = tc.customer_id
          GROUP BY tc.customer_id, cu.customer_name
          ORDER BY total_cost DESC, tc.customer_id ASC`, params)).rows.map((r) => ({
        customerId: Number(r.customer_id),
        customerName: r.customer_name,
        tickets: Number(r.tickets),
        totalCost: Number(r.total_cost),
      }));

      // Spend per reported_at month ('YYYY-MM'), chronological.
      const byMonth = (await c.query<{ month: string; tickets: string; total_cost: number }>(
        `SELECT to_char(tc.reported_at, 'YYYY-MM') AS month,
                count(*)::text AS tickets,
                COALESCE(SUM(tc.travel_cost + tc.spare_cost + tc.claim_cost), 0)::float8 AS total_cost
           FROM (${ticketCte}) tc
          GROUP BY 1
          ORDER BY 1 ASC`, params)).rows.map((r) => ({
        month: r.month,
        tickets: Number(r.tickets),
        totalCost: Number(r.total_cost),
      }));

      return {
        totals: {
          tickets: Number(totalsRow.tickets),
          inWarrantyTickets: Number(totalsRow.in_warranty_tickets),
          travelCost: Number(totalsRow.travel_cost),
          spareCost: Number(totalsRow.spare_cost),
          claimCost: Number(totalsRow.claim_cost),
          totalCost: Number(totalsRow.total_cost),
        },
        byCustomer,
        byMonth,
      };
    });
  }

  /** Optimistic-locked header update + child replacement. Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: Partial<TicketHeaderInput>, visits?: FieldVisit[], spares?: SpareIssue[],
  ): Promise<ServiceTicket | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.priority !== undefined) add('priority', fields.priority);
    if (fields.serialId !== undefined) add('serial_id', fields.serialId);
    if (fields.warrantyId !== undefined) add('warranty_id', fields.warrantyId);
    if (fields.contractId !== undefined) add('contract_id', fields.contractId);
    if (fields.isInWarranty !== undefined) add('is_in_warranty', fields.isInWarranty);
    if (fields.slaDueAt !== undefined) add('sla_due_at', fields.slaDueAt);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE svc.service_ticket
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE ticket_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (visits) {
        await c.query(`DELETE FROM svc.field_visit WHERE ticket_id = $1`, [id]);
        await this.insertVisits(c, id, visits);
      }
      if (spares) {
        await c.query(`DELETE FROM svc.spare_issue WHERE ticket_id = $1`, [id]);
        await this.insertSpares(c, id, spares);
      }
      return {
        ...header,
        visits: await this.fetchVisits(c, id),
        spares: await this.fetchSpares(c, id),
      };
    });
  }

  /**
   * Lifecycle status change with an optional header patch (assignment / resolution)
   * and an optional outbox event emitted atomically with the state change.
   * Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: ServiceTicketStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<ServiceTicket | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE svc.service_ticket SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE ticket_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      // Atomic with the state change: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return {
        ...mapHeader(res.rows[0]),
        visits: await this.fetchVisits(c, id),
        spares: await this.fetchSpares(c, id),
      };
    });
  }

  /** Assign a field engineer under optimistic lock (OPEN/ASSIGNED -> ASSIGNED). */
  async assign(
    ctx: RequestContext, id: number, expectedVersion: number, engineerId: number,
  ): Promise<ServiceTicket | null> {
    return this.updateStatus(ctx, id, expectedVersion, 'ASSIGNED', { assigned_engineer_id: engineerId });
  }

  /**
   * Raise (and dispose of) a warranty claim against the ticket, optionally with an
   * outbox event on approval — all atomic. Returns the persisted claim.
   */
  async recordWarrantyClaim(
    ctx: RequestContext, ticketId: number, warrantyId: number, claimCost: number,
    status: ClaimStatus, event?: OutboxEventInput,
  ): Promise<WarrantyClaim> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO svc.warranty_claim (warranty_id, ticket_id, claim_cost, status, approved_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING claim_id, warranty_id, ticket_id, claim_date, claim_cost, status, approved_by`,
        [warrantyId, ticketId, claimCost, status, status === 'PENDING' ? null : ctx.userId]);
      if (event) await emitOutbox(c, event);
      return mapClaim(res.rows[0]);
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE svc.service_ticket
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE ticket_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
