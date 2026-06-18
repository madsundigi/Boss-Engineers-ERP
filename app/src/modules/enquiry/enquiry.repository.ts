import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Enquiry, EnquiryListResult } from './enquiry.types';
import { ListQueryDto } from './enquiry.dto';
import { DOC_TYPE, EnquiryStatus } from './enquiry.constants';

const COLS = `enquiry_id, enquiry_no, company_id, bu_id, customer_name,
  contact_person AS contact, email, address, industry, source, requirement,
  mobile, machine_type, application, quantity, budget, sales_executive,
  follow_up_date, remarks, assigned_to,
  (SELECT COALESCE(au_asg.full_name, au_asg.username)
     FROM sec.app_user au_asg WHERE au_asg.user_id = assigned_to) AS assigned_to_name,
  status, created_at, created_by, updated_at, row_version`;

function mapRow(r: QueryResultRow): Enquiry {
  return {
    enquiryId: Number(r.enquiry_id),
    enquiryNo: r.enquiry_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    customerName: r.customer_name,
    contact: r.contact,
    email: r.email,
    address: r.address,
    industry: r.industry,
    source: r.source,
    requirement: r.requirement,
    mobile: r.mobile,
    machineType: r.machine_type,
    application: r.application,
    quantity: r.quantity == null ? null : Number(r.quantity),
    budget: r.budget == null ? null : Number(r.budget),
    salesExecutive: r.sales_executive,
    followUpDate: r.follow_up_date,
    remarks: r.remarks,
    assignedTo: r.assigned_to == null ? null : Number(r.assigned_to),
    assignedToName: r.assigned_to_name ?? null,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}

export interface CreateEnquiryRow {
  customerName: string;
  contact?: string;
  email?: string;
  address?: string;
  industry?: string;
  source?: string;
  requirement?: string;
  mobile?: string;
  machineType?: string;
  application?: string;
  quantity?: number;
  budget?: number;
  salesExecutive?: string;
  followUpDate?: string;
  remarks?: string;
}

export class EnquiryRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert, allocating the gapless enquiry number inside the same transaction. */
  async create(ctx: RequestContext, data: CreateEnquiryRow): Promise<Enquiry> {
    return runInContext(this.pool, ctx, async (client: Queryable) => {
      const res = await client.query(
        `INSERT INTO sales.enquiry
           (company_id, bu_id, enquiry_no, customer_name, contact_person, email,
            address, industry, source, requirement, mobile, machine_type,
            application, quantity, budget, sales_executive, follow_up_date,
            remarks, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'NEW',$18)
         RETURNING ${COLS}`,
        [
          ctx.companyId, ctx.buId, data.customerName, data.contact ?? null,
          data.email ?? null, data.address ?? null, data.industry ?? null,
          data.source ?? null, data.requirement ?? null, data.mobile ?? null,
          data.machineType ?? null, data.application ?? null, data.quantity ?? null,
          data.budget ?? null, data.salesExecutive ?? null, data.followUpDate ?? null,
          data.remarks ?? null, ctx.userId,
        ],
      );
      return mapRow(res.rows[0]);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Enquiry | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM sales.enquiry
          WHERE enquiry_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<EnquiryListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.source) { params.push(q.source); where.push(`source = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = params.length;
      where.push(`(customer_name ILIKE $${i} OR contact_person ILIKE $${i} OR email ILIKE $${i})`);
    }
    if (q.enquiryNo) { params.push(`%${q.enquiryNo}%`); where.push(`enquiry_no ILIKE $${params.length}`); }
    if (q.customerName) { params.push(`%${q.customerName}%`); where.push(`customer_name ILIKE $${params.length}`); }
    if (q.machineType) { params.push(`%${q.machineType}%`); where.push(`machine_type ILIKE $${params.length}`); }
    if (q.assignedTo !== undefined) { params.push(q.assignedTo); where.push(`assigned_to = $${params.length}`); }
    if (q.followUpFrom) { params.push(q.followUpFrom); where.push(`follow_up_date >= $${params.length}`); }
    if (q.followUpTo) { params.push(q.followUpTo); where.push(`follow_up_date <= $${params.length}`); }
    const whereSql = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
    const totalRes = await c.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM sales.enquiry WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRes.rows[0].total);

    const rowsRes = await c.query(
      `SELECT ${COLS} FROM sales.enquiry WHERE ${whereSql}
        ORDER BY ${q.sort} ${q.dir.toUpperCase()}
        LIMIT ${q.pageSize} OFFSET ${offset}`,
      params,
    );
    return { rows: rowsRes.rows.map(mapRow), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null if version did not match. */
  async update(
    ctx: RequestContext,
    id: number,
    expectedVersion: number,
    fields: Partial<CreateEnquiryRow>,
  ): Promise<Enquiry | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.customerName !== undefined) add('customer_name', fields.customerName);
    if (fields.contact !== undefined) add('contact_person', fields.contact);
    if (fields.email !== undefined) add('email', fields.email);
    if (fields.address !== undefined) add('address', fields.address);
    if (fields.industry !== undefined) add('industry', fields.industry);
    if (fields.source !== undefined) add('source', fields.source);
    if (fields.requirement !== undefined) add('requirement', fields.requirement);
    if (fields.mobile !== undefined) add('mobile', fields.mobile);
    if (fields.machineType !== undefined) add('machine_type', fields.machineType);
    if (fields.application !== undefined) add('application', fields.application);
    if (fields.quantity !== undefined) add('quantity', fields.quantity);
    if (fields.budget !== undefined) add('budget', fields.budget);
    if (fields.salesExecutive !== undefined) add('sales_executive', fields.salesExecutive);
    if (fields.followUpDate !== undefined) add('follow_up_date', fields.followUpDate);
    if (fields.remarks !== undefined) add('remarks', fields.remarks);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (client) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await client.query(
        `UPDATE sales.enquiry
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE enquiry_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${COLS}`,
        params,
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  /**
   * Optimistic-locked status transition. Emits an optional domain event
   * atomically with the state change (transactional outbox — same pattern as the
   * project/quotation repos). The service passes `event` only for WON so a
   * Project is auto-seeded from the enquiry by the relay (FRD §5).
   */
  async changeStatus(
    ctx: RequestContext, id: number, expectedVersion: number,
    status: EnquiryStatus, reasonId: number | null, event?: OutboxEventInput,
  ): Promise<Enquiry | null> {
    return runInContext(this.pool, ctx, async (client) => {
      const res = await client.query(
        `UPDATE sales.enquiry
            SET status = $1, lost_reason_id = COALESCE($2, lost_reason_id),
                updated_by = $3, updated_at = now(), row_version = row_version + 1
          WHERE enquiry_id = $4 AND company_id = $5
            AND row_version = $6 AND NOT is_deleted
        RETURNING ${COLS}`,
        [status, reasonId, ctx.userId, id, ctx.companyId, expectedVersion],
      );
      if (!res.rowCount) return null;
      // Atomic with the status UPDATE: record the domain event.
      if (event) await emitOutbox(client, event);
      return mapRow(res.rows[0]);
    });
  }

  /** True if the given user_id is an existing, active, non-deleted app user. */
  async userIsActive(ctx: RequestContext, userId: number): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM sec.app_user WHERE user_id = $1 AND is_active AND NOT is_deleted`,
        [userId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Assign (or re-assign) the enquiry to a salesperson under optimistic lock.
   * When `expectedVersion` is undefined the version check is skipped (assign is
   * idempotent-friendly). Returns null when no row matched (not found / version
   * mismatch — the service distinguishes the two via a prior findById).
   */
  async assign(
    ctx: RequestContext, id: number, userId: number, expectedVersion?: number,
  ): Promise<Enquiry | null> {
    return runInContext(this.pool, ctx, async (client) => {
      const params: unknown[] = [userId, ctx.userId, id, ctx.companyId];
      let verSql = '';
      if (expectedVersion !== undefined) {
        params.push(expectedVersion);
        verSql = ` AND row_version = $${params.length}`;
      }
      const res = await client.query(
        `UPDATE sales.enquiry
            SET assigned_to = $1, updated_by = $2, updated_at = now(),
                row_version = row_version + 1
          WHERE enquiry_id = $3 AND company_id = $4${verSql} AND NOT is_deleted
        RETURNING ${COLS}`,
        params,
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (client) => {
      const res = await client.query(
        `UPDATE sales.enquiry
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE enquiry_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }
}
