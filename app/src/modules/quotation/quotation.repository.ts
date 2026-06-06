import { Pool, QueryResultRow } from 'pg';
import { runInContext, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Quotation, QuotationLine, QuotationRevision, QuotationListResult } from './quotation.types';
import { ListQueryDto } from './quotation.dto';
import { DOC_TYPE, QuoteStatus } from './quotation.constants';

const H = `quotation_id, quotation_no, company_id, bu_id, enquiry_id, current_revision,
  subject, customer_name, contact_person AS contact, email, quote_date, valid_until,
  currency_code, total_cost, total_price, discount_pct, margin_pct, status,
  sent_at, sent_to, pdf_ref, created_at, row_version`;

type Header = Omit<Quotation, 'lines'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    quotationId: Number(r.quotation_id), quotationNo: r.quotation_no, companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id), enquiryId: r.enquiry_id == null ? null : Number(r.enquiry_id),
    currentRevision: Number(r.current_revision), subject: r.subject, customerName: r.customer_name,
    contact: r.contact, email: r.email, quoteDate: r.quote_date, validUntil: r.valid_until,
    currencyCode: r.currency_code, totalCost: Number(r.total_cost), totalPrice: Number(r.total_price),
    discountPct: Number(r.discount_pct), marginPct: r.margin_pct == null ? 0 : Number(r.margin_pct),
    status: r.status, sentAt: r.sent_at, sentTo: r.sent_to, pdfRef: r.pdf_ref,
    createdAt: r.created_at, rowVersion: Number(r.row_version),
  };
}
function mapLine(r: QueryResultRow): QuotationLine {
  return {
    lineId: Number(r.line_id), description: r.description, qty: Number(r.qty),
    unitPrice: Number(r.unit_price), lineAmount: Number(r.line_amount), isOptional: r.is_optional,
  };
}

export interface QuotationHeaderInput {
  subject?: string; customerName: string; contact?: string; email?: string;
  validUntil?: string; currencyCode: string; totalCost: number; totalPrice: number;
  discountPct: number; enquiryId?: number;
}
export type StatusPatch = Partial<Record<
  'submitted_at' | 'submitted_by' | 'decided_at' | 'decided_by' | 'decision_reason' | 'sent_at' | 'sent_to' | 'pdf_ref',
  unknown
>>;

export class QuotationRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchLines(q: Queryable, id: number): Promise<QuotationLine[]> {
    const res = await q.query(
      `SELECT line_id, description, qty, unit_price, line_amount, is_optional
         FROM sales.quotation_line WHERE quotation_id = $1 ORDER BY line_id`, [id]);
    return res.rows.map(mapLine);
  }
  private async insertLines(q: Queryable, id: number, lines: QuotationLine[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO sales.quotation_line (quotation_id, description, qty, unit_price, line_amount, is_optional)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, l.description, l.qty, l.unitPrice, l.lineAmount, l.isOptional]);
    }
  }

  async create(ctx: RequestContext, h: QuotationHeaderInput, lines: QuotationLine[]): Promise<Quotation> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO sales.quotation
           (company_id, bu_id, quotation_no, enquiry_id, subject, customer_name, contact_person,
            email, valid_until, currency_code, total_cost, total_price, discount_pct, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13)
         RETURNING ${H}`,
        [ctx.companyId, ctx.buId, h.enquiryId ?? null, h.subject ?? null, h.customerName,
         h.contact ?? null, h.email ?? null, h.validUntil ?? null, h.currencyCode,
         h.totalCost, h.totalPrice, h.discountPct, ctx.userId]);
      const header = mapHeader(res.rows[0]);
      await this.insertLines(c, header.quotationId, lines);
      await c.query(
        `INSERT INTO sales.quotation_revision (quotation_id, rev_no, snapshot, reason, created_by)
         VALUES ($1, 0, $2, 'Initial', $3)`,
        [header.quotationId, JSON.stringify({ ...header, lines }), ctx.userId]);
      return { ...header, lines: await this.fetchLines(c, header.quotationId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Quotation | null> {
    const res = await this.pool.query(
      `SELECT ${H} FROM sales.quotation WHERE quotation_id=$1 AND company_id=$2 AND NOT is_deleted`,
      [id, ctx.companyId]);
    if (!res.rowCount) return null;
    return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(this.pool, id) };
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<QuotationListResult> {
    const where = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); const i = params.length; where.push(`(customer_name ILIKE $${i} OR quotation_no ILIKE $${i})`); }
    const w = where.join(' AND ');
    const total = Number((await this.pool.query<{ c: string }>(`SELECT count(*)::text c FROM sales.quotation WHERE ${w}`, params)).rows[0].c);
    const offset = (q.page - 1) * q.pageSize;
    const rows = await this.pool.query(`SELECT ${H} FROM sales.quotation WHERE ${w} ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
    return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
  }

  async update(
    ctx: RequestContext, id: number, version: number,
    fields: Partial<QuotationHeaderInput>, lines?: QuotationLine[], forceStatusDraft = false,
  ): Promise<Quotation | null> {
    const set: string[] = []; const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.subject !== undefined) add('subject', fields.subject);
    if (fields.customerName !== undefined) add('customer_name', fields.customerName);
    if (fields.contact !== undefined) add('contact_person', fields.contact);
    if (fields.email !== undefined) add('email', fields.email);
    if (fields.validUntil !== undefined) add('valid_until', fields.validUntil);
    if (fields.currencyCode !== undefined) add('currency_code', fields.currencyCode);
    if (fields.totalCost !== undefined) add('total_cost', fields.totalCost);
    if (fields.totalPrice !== undefined) add('total_price', fields.totalPrice);
    if (fields.discountPct !== undefined) add('discount_pct', fields.discountPct);
    if (forceStatusDraft) set.push(`status = 'DRAFT'`);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(version); const pVer = params.length;
      const res = await c.query(
        `UPDATE sales.quotation SET ${set.join(', ')}, updated_at=now(), row_version=row_version+1
          WHERE quotation_id=$${pId} AND company_id=$${pCo} AND row_version=$${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (lines) {
        await c.query(`DELETE FROM sales.quotation_line WHERE quotation_id=$1`, [id]);
        await this.insertLines(c, id, lines);
      }
      return { ...header, lines: await this.fetchLines(c, id) };
    });
  }

  async updateStatus(
    ctx: RequestContext, id: number, version: number | null, status: QuoteStatus, patch: StatusPatch = {},
  ): Promise<Quotation | null> {
    const set: string[] = [`status = $1`]; const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      let verClause = '';
      if (version !== null) { params.push(version); verClause = ` AND row_version = $${params.length}`; }
      const res = await c.query(
        `UPDATE sales.quotation SET ${set.join(', ')}, updated_at=now(), row_version=row_version+1
          WHERE quotation_id=$${pId} AND company_id=$${pCo} AND NOT is_deleted${verClause}
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  /** Version control: snapshot current state, bump revision, reset to DRAFT. */
  async revise(ctx: RequestContext, id: number, version: number, reason: string): Promise<Quotation | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const cur = await c.query(`SELECT ${H} FROM sales.quotation WHERE quotation_id=$1 AND company_id=$2 AND NOT is_deleted FOR UPDATE`, [id, ctx.companyId]);
      if (!cur.rowCount) return null;
      const header = mapHeader(cur.rows[0]);
      if (header.rowVersion !== version) return null;
      const lines = await this.fetchLines(c, id);
      await c.query(
        `INSERT INTO sales.quotation_revision (quotation_id, rev_no, snapshot, reason, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, header.currentRevision, JSON.stringify({ ...header, lines }), reason, ctx.userId]);
      const upd = await c.query(
        `UPDATE sales.quotation
            SET current_revision = current_revision + 1, status='DRAFT',
                updated_by=$1, updated_at=now(), row_version=row_version+1
          WHERE quotation_id=$2 AND company_id=$3 RETURNING ${H}`,
        [ctx.userId, id, ctx.companyId]);
      return { ...mapHeader(upd.rows[0]), lines };
    });
  }

  async listRevisions(ctx: RequestContext, id: number): Promise<QuotationRevision[]> {
    const res = await this.pool.query(
      `SELECT r.revision_id, r.rev_no, r.reason, r.snapshot, r.created_at
         FROM sales.quotation_revision r JOIN sales.quotation q ON q.quotation_id=r.quotation_id
        WHERE r.quotation_id=$1 AND q.company_id=$2 ORDER BY r.rev_no DESC`,
      [id, ctx.companyId]);
    return res.rows.map((r) => ({
      revisionId: Number(r.revision_id), revNo: Number(r.rev_no), reason: r.reason,
      snapshot: r.snapshot, createdAt: r.created_at,
    }));
  }
}
