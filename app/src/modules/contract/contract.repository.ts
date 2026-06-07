import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Contract, ContractMilestone, ContractListResult } from './contract.types';
import { ListQueryDto } from './contract.dto';
import { DOC_TYPE, ContractStatus, MilestoneStatus } from './contract.constants';

/** Header columns of sales.customer_contract (created in migration 029). */
const H = `contract_id, contract_no, company_id, bu_id, customer_id, project_id,
  title, contract_value, currency_id, payment_terms, ld_penalty_pct, ld_cap_pct,
  warranty_months, start_date, end_date, status, signed_date,
  created_at, created_by, updated_at, row_version`;

/** Milestone columns of sales.contract_milestone. */
const M = `milestone_id, name, milestone_pct, amount, due_date, status, sort_order`;

type Header = Omit<Contract, 'milestones'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    contractId: Number(r.contract_id),
    contractNo: r.contract_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    customerId: Number(r.customer_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    title: r.title,
    contractValue: Number(r.contract_value),
    currencyId: r.currency_id == null ? null : Number(r.currency_id),
    paymentTerms: r.payment_terms,
    ldPenaltyPct: Number(r.ld_penalty_pct),
    ldCapPct: Number(r.ld_cap_pct),
    warrantyMonths: Number(r.warranty_months),
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    signedDate: r.signed_date,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapMilestone(r: QueryResultRow): ContractMilestone {
  return {
    milestoneId: Number(r.milestone_id),
    name: r.name,
    milestonePct: r.milestone_pct == null ? null : Number(r.milestone_pct),
    amount: Number(r.amount),
    dueDate: r.due_date,
    status: r.status,
    sortOrder: r.sort_order == null ? null : Number(r.sort_order),
  };
}

/** Header fields the service supplies for create / update. */
export interface ContractHeaderInput {
  customerId: number;
  projectId?: number;
  title?: string;
  contractValue: number;
  currencyId: number;
  paymentTerms?: string;
  ldPenaltyPct: number;
  ldCapPct: number;
  warrantyMonths: number;
  startDate?: string;
  endDate?: string;
  signedDate?: string;
}

/** A milestone the service has computed/validated, ready to persist. */
export interface MilestoneInput {
  name: string;
  milestonePct?: number;
  amount: number;
  dueDate?: string;
  sortOrder?: number;
}

export class ContractRepository {
  constructor(private readonly pool: Pool) {}

  /** Resolve the company's INR currency id (fallback when none supplied). */
  async resolveInrCurrencyId(ctx: RequestContext): Promise<number | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT currency_id FROM mdm.currency WHERE iso_code = 'INR'`);
      return res.rowCount ? Number(res.rows[0].currency_id) : null;
    });
  }

  private async fetchMilestones(q: Queryable, id: number): Promise<ContractMilestone[]> {
    const res = await q.query(
      `SELECT ${M} FROM sales.contract_milestone WHERE contract_id = $1
        ORDER BY COALESCE(sort_order, milestone_id), milestone_id`, [id]);
    return res.rows.map(mapMilestone);
  }
  private async insertMilestones(q: Queryable, id: number, milestones: MilestoneInput[]): Promise<void> {
    for (const m of milestones) {
      await q.query(
        `INSERT INTO sales.contract_milestone
           (contract_id, name, milestone_pct, amount, due_date, status, sort_order)
         VALUES ($1,$2,$3,$4,$5::date,'PENDING',$6)`,
        [id, m.name, m.milestonePct ?? null, m.amount, m.dueDate ?? null, m.sortOrder ?? null]);
    }
  }

  /** Insert a contract (DRAFT) + its milestones, allocating the contract number
   *  in the same transaction. company_id = ctx.companyId so the row passes RLS WITH CHECK. */
  async create(ctx: RequestContext, h: ContractHeaderInput, milestones: MilestoneInput[]): Promise<Contract> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO sales.customer_contract
           (company_id, bu_id, contract_no, customer_id, project_id, title, contract_value,
            currency_id, payment_terms, ld_penalty_pct, ld_cap_pct, warranty_months,
            start_date, end_date, status, signed_date, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,
                 $12::date,$13::date,'DRAFT',$14::date,$15)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.customerId, h.projectId ?? null, h.title ?? null,
          h.contractValue, h.currencyId, h.paymentTerms ?? null, h.ldPenaltyPct, h.ldCapPct,
          h.warrantyMonths, h.startDate ?? null, h.endDate ?? null, h.signedDate ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertMilestones(c, header.contractId, milestones);
      return { ...header, milestones: await this.fetchMilestones(c, header.contractId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Contract | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM sales.customer_contract
          WHERE contract_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), milestones: await this.fetchMilestones(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<ContractListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`contract_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM sales.customer_contract WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM sales.customer_contract WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + full milestone replacement (DRAFT only —
   *  the service guards status). Returns null on a row-version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    h: ContractHeaderInput, milestones?: MilestoneInput[],
  ): Promise<Contract | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sales.customer_contract
            SET project_id = $1, title = $2, contract_value = $3, currency_id = $4,
                payment_terms = $5, ld_penalty_pct = $6, ld_cap_pct = $7, warranty_months = $8,
                start_date = $9::date, end_date = $10::date, signed_date = $11::date,
                updated_by = $12, updated_at = now(), row_version = row_version + 1
          WHERE contract_id = $13 AND company_id = $14 AND row_version = $15 AND NOT is_deleted
        RETURNING ${H}`,
        [
          h.projectId ?? null, h.title ?? null, h.contractValue, h.currencyId,
          h.paymentTerms ?? null, h.ldPenaltyPct, h.ldCapPct, h.warrantyMonths,
          h.startDate ?? null, h.endDate ?? null, h.signedDate ?? null, ctx.userId,
          id, ctx.companyId, expectedVersion,
        ]);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (milestones) {
        await c.query(`DELETE FROM sales.contract_milestone WHERE contract_id = $1`, [id]);
        await this.insertMilestones(c, id, milestones);
      }
      return { ...header, milestones: await this.fetchMilestones(c, id) };
    });
  }

  /**
   * Lifecycle status change under optimistic lock, with an optional outbox event
   * (e.g. 'contract.activated' on activate) emitted atomically with the state
   * change. Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: ContractStatus,
    event?: OutboxEventInput,
  ): Promise<Contract | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sales.customer_contract
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE contract_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${H}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      // Atomic with the state change: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return { ...mapHeader(res.rows[0]), milestones: await this.fetchMilestones(c, id) };
    });
  }

  /**
   * Transition a single billing milestone's status (PENDING -> INVOICED -> PAID),
   * scoped to its parent contract + the tenant. Bumps the parent contract's
   * row_version so the change is audited like any update. Returns the refreshed
   * contract, or null if the milestone was not found / not in the parent.
   */
  async setMilestoneStatus(
    ctx: RequestContext, contractId: number, milestoneId: number, status: MilestoneStatus,
  ): Promise<Contract | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query(
        `UPDATE sales.contract_milestone
            SET status = $1
          WHERE milestone_id = $2 AND contract_id = $3`,
        [status, milestoneId, contractId]);
      if (!upd.rowCount) return null;
      // Bump the parent so the milestone change is attributed + audited.
      const head = await c.query(
        `UPDATE sales.customer_contract
            SET updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE contract_id = $2 AND company_id = $3 AND NOT is_deleted
        RETURNING ${H}`,
        [ctx.userId, contractId, ctx.companyId]);
      if (!head.rowCount) return null;
      return { ...mapHeader(head.rows[0]), milestones: await this.fetchMilestones(c, contractId) };
    });
  }

  /** Soft delete (DRAFT only — service guards). Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sales.customer_contract
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE contract_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
