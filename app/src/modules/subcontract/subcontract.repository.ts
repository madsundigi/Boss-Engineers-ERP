import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  SubcontractOrder, SubcontractOrderHeader, SubcontractIssue, SubcontractReceipt,
  SubcontractListResult,
} from './subcontract.types';
import { ListQueryDto } from './subcontract.dto';
import { DOC_TYPE, SubcontractStatus } from './subcontract.constants';

/** Header columns of scm.subcontract_order (bu_id + audit cols added in migration 028). */
const H = `sco_id, sco_no, company_id, bu_id, vendor_id, project_id, sco_date, status,
  created_at, created_by, updated_at, row_version`;

function mapHeader(r: QueryResultRow): SubcontractOrderHeader {
  return {
    scoId: Number(r.sco_id),
    scoNo: r.sco_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    vendorId: Number(r.vendor_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    scoDate: r.sco_date,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapIssue(r: QueryResultRow): SubcontractIssue {
  return {
    sciId: Number(r.sci_id),
    itemId: Number(r.item_id),
    qty: Number(r.qty),
    issuedAt: r.issued_at,
  };
}
function mapReceipt(r: QueryResultRow): SubcontractReceipt {
  return {
    scrId: Number(r.scr_id),
    itemId: Number(r.item_id),
    qty: Number(r.qty),
    receivedAt: r.received_at,
  };
}

/** Header fields supplied at create time (numbering + status are server-set). */
export interface SubcontractHeaderInput {
  vendorId: number;
  projectId?: number;
  scoDate?: string;
}
/** Partial header patch (project peg / date) carried by an edit. */
export type HeaderPatch = Partial<Pick<SubcontractHeaderInput, 'projectId' | 'scoDate'>>;

export class SubcontractRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchIssues(q: Queryable, id: number): Promise<SubcontractIssue[]> {
    const res = await q.query(
      `SELECT sci_id, item_id, qty, issued_at
         FROM scm.subcontract_issue WHERE sco_id = $1 ORDER BY sci_id`, [id]);
    return res.rows.map(mapIssue);
  }
  private async fetchReceipts(q: Queryable, id: number): Promise<SubcontractReceipt[]> {
    const res = await q.query(
      `SELECT scr_id, item_id, qty, received_at
         FROM scm.subcontract_receipt WHERE sco_id = $1 ORDER BY scr_id`, [id]);
    return res.rows.map(mapReceipt);
  }
  private async insertIssues(q: Queryable, id: number, lines: SubcontractIssue[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO scm.subcontract_issue (sco_id, item_id, qty) VALUES ($1,$2,$3)`,
        [id, l.itemId, l.qty]);
    }
  }
  private async insertReceipts(q: Queryable, id: number, lines: SubcontractReceipt[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO scm.subcontract_receipt (sco_id, item_id, qty) VALUES ($1,$2,$3)`,
        [id, l.itemId, l.qty]);
    }
  }

  private async hydrate(q: Queryable, header: SubcontractOrderHeader): Promise<SubcontractOrder> {
    return {
      ...header,
      issues: await this.fetchIssues(q, header.scoId),
      receipts: await this.fetchReceipts(q, header.scoId),
    };
  }

  /**
   * Insert the order, allocating the gapless 'SUBCON' (prefix SC) number inside
   * the same transaction. Planned items are stashed as issue rows only on the
   * later /issue call, so the freshly-created order has no children.
   */
  async create(ctx: RequestContext, h: SubcontractHeaderInput): Promise<SubcontractOrder> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO scm.subcontract_order
           (company_id, bu_id, sco_no, vendor_id, project_id, sco_date, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4, COALESCE($5::date, current_date), 'OPEN', $6)
         RETURNING ${H}`,
        [ctx.companyId, ctx.buId, h.vendorId, h.projectId ?? null, h.scoDate ?? null, ctx.userId]);
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<SubcontractOrder | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM scm.subcontract_order
          WHERE sco_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<SubcontractListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.vendorId) { params.push(q.vendorId); where.push(`vendor_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`sco_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM scm.subcontract_order WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM scm.subcontract_order WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header patch (project/date). Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number, fields: HeaderPatch,
  ): Promise<SubcontractOrder | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.projectId !== undefined) add('project_id', fields.projectId);
    if (fields.scoDate !== undefined) add('sco_date', fields.scoDate);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE scm.subcontract_order
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE sco_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /**
   * Lifecycle status change under optimistic lock, optionally inserting issue or
   * receipt child rows and emitting a domain event (e.g. 'subcontract.received')
   * — all atomic with the state change. Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: SubcontractStatus,
    opts: {
      issues?: SubcontractIssue[];
      receipts?: SubcontractReceipt[];
      event?: OutboxEventInput;
    } = {},
  ): Promise<SubcontractOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.subcontract_order
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE sco_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${H}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      if (opts.issues?.length) await this.insertIssues(c, id, opts.issues);
      if (opts.receipts?.length) await this.insertReceipts(c, id, opts.receipts);
      // Atomic with the state change: record the domain event (transactional outbox).
      if (opts.event) await emitOutbox(c, opts.event);
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.subcontract_order
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE sco_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
