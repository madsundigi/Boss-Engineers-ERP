import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  GlAccount, JournalEntry, JournalLine, ProjectCostRow,
  TrialBalanceRow, ProjectCostSummaryRow, ListResult,
} from './gl.types';
import {
  AccountQueryDto, JournalQueryDto, LedgerQueryDto, TrialBalanceQueryDto,
} from './gl.dto';
import { DOC_TYPE, AccountType, CostType, CostStage } from './gl.constants';

// ---- column lists ----
const A = `gl_id, company_id, gl_code, gl_name, account_type, is_active`;
const H = `gl_entry_id, company_id, bu_id, posting_date, journal_no, narration,
  source_doc_type, source_doc_id, created_by, created_at`;
const L = `gl_line_id, gl_id, cost_center_id, project_id, debit, credit`;
const C = `cost_id, posting_date, company_id, project_id, wbs_id, cost_type,
  cost_stage, amount, ref_doc_type, ref_doc_id, created_by, created_at`;

function mapAccount(r: QueryResultRow): GlAccount {
  return {
    glId: Number(r.gl_id),
    companyId: Number(r.company_id),
    glCode: r.gl_code,
    glName: r.gl_name,
    accountType: r.account_type,
    isActive: r.is_active,
  };
}
function mapHeader(r: QueryResultRow): Omit<JournalEntry, 'lines'> {
  return {
    glEntryId: Number(r.gl_entry_id),
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    postingDate: r.posting_date,
    journalNo: r.journal_no,
    narration: r.narration,
    sourceDocType: r.source_doc_type,
    sourceDocId: r.source_doc_id == null ? null : Number(r.source_doc_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at,
  };
}
function mapLine(r: QueryResultRow): JournalLine {
  return {
    glLineId: Number(r.gl_line_id),
    glId: Number(r.gl_id),
    costCenterId: r.cost_center_id == null ? null : Number(r.cost_center_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    debit: Number(r.debit),
    credit: Number(r.credit),
  };
}
function mapCost(r: QueryResultRow): ProjectCostRow {
  return {
    costId: Number(r.cost_id),
    postingDate: r.posting_date,
    companyId: Number(r.company_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    costType: r.cost_type,
    costStage: r.cost_stage,
    amount: Number(r.amount),
    refDocType: r.ref_doc_type,
    refDocId: Number(r.ref_doc_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at,
  };
}

/** A validated journal ready to persist (the service builds this). */
export interface JournalInput {
  postingDate?: string;
  narration?: string;
  sourceDocType?: string;
  sourceDocId?: number;
  totalDebit: number; // surfaced on the outbox payload
  lines: {
    glId: number;
    debit: number;
    credit: number;
    costCenterId?: number;
    projectId?: number;
  }[];
}

/** A validated project-cost row ready to append. */
export interface CostInput {
  projectId: number;
  wbsId?: number;
  costType: CostType;
  costStage: CostStage;
  amount: number;
  refDocType: string;
  refDocId: number;
  postingDate?: string;
}

export class GlRepository {
  constructor(private readonly pool: Pool) {}

  // ---------------------------------------------------------------------
  // Chart of accounts (mdm.gl_account) — simple master, no row_version.
  // ---------------------------------------------------------------------
  async createAccount(
    ctx: RequestContext, gl: { glCode: string; glName: string; accountType: AccountType; isActive: boolean },
  ): Promise<GlAccount> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO mdm.gl_account (company_id, gl_code, gl_name, account_type, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${A}`,
        [ctx.companyId, gl.glCode, gl.glName, gl.accountType, gl.isActive]);
      return mapAccount(res.rows[0]);
    });
  }

  async findAccount(ctx: RequestContext, glId: number): Promise<GlAccount | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${A} FROM mdm.gl_account WHERE gl_id = $1 AND company_id = $2`,
        [glId, ctx.companyId]);
      return res.rowCount ? mapAccount(res.rows[0]) : null;
    });
  }

  async findAccountByCode(ctx: RequestContext, glCode: string): Promise<GlAccount | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${A} FROM mdm.gl_account WHERE gl_code = $1 AND company_id = $2`,
        [glCode, ctx.companyId]);
      return res.rowCount ? mapAccount(res.rows[0]) : null;
    });
  }

  async listAccounts(ctx: RequestContext, q: AccountQueryDto): Promise<GlAccount[]> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.accountType) { params.push(q.accountType); where.push(`account_type = $${params.length}`); }
    if (q.isActive !== undefined) { params.push(q.isActive); where.push(`is_active = $${params.length}`); }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${A} FROM mdm.gl_account WHERE ${where.join(' AND ')}
          ORDER BY gl_code`, params);
      return res.rows.map(mapAccount);
    });
  }

  /** Flip is_active. Returns the updated row, or null if not found. */
  async setActive(ctx: RequestContext, glId: number, isActive: boolean): Promise<GlAccount | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.gl_account SET is_active = $1
          WHERE gl_id = $2 AND company_id = $3
        RETURNING ${A}`, [isActive, glId, ctx.companyId]);
      return res.rowCount ? mapAccount(res.rows[0]) : null;
    });
  }

  /**
   * Resolve the active accounts referenced by a set of glIds, scoped to the
   * company. The service compares the returned set against the requested ids to
   * reject unknown / cross-company / inactive accounts before posting.
   */
  async findAccountsByIds(
    ctx: RequestContext, glIds: number[],
  ): Promise<{ glId: number; isActive: boolean }[]> {
    if (glIds.length === 0) return [];
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT gl_id, is_active FROM mdm.gl_account
          WHERE company_id = $1 AND gl_id = ANY($2::bigint[])`,
        [ctx.companyId, glIds]);
      return res.rows.map((r) => ({ glId: Number(r.gl_id), isActive: r.is_active }));
    });
  }

  // ---------------------------------------------------------------------
  // Journal posting (fin.gl_entry + fin.gl_entry_line) — APPEND-ONLY.
  // ---------------------------------------------------------------------
  /**
   * Insert a journal header + all of its lines in ONE transaction, allocating
   * the journal number via mdm.next_document_no, and emitting the posted event
   * atomically (transactional outbox). The SAME posting_date is written on the
   * header AND every line — it is the partition key and part of the composite
   * FK (gl_entry_id, posting_date), so the two must match for the FK to resolve.
   * company_id = ctx.companyId so the row satisfies the per-company RLS policy.
   */
  async postJournal(ctx: RequestContext, j: JournalInput, event: OutboxEventInput): Promise<JournalEntry> {
    return runInContext(this.pool, ctx, async (c) => {
      const head = await c.query(
        `INSERT INTO fin.gl_entry
           (company_id, bu_id, posting_date, journal_no, narration, source_doc_type, source_doc_id, created_by)
         VALUES ($1, $2, COALESCE($3::date, current_date),
                 mdm.next_document_no($1, $2, '${DOC_TYPE}'), $4, $5, $6, $7)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, j.postingDate ?? null, j.narration ?? null,
          j.sourceDocType ?? null, j.sourceDocId ?? null, ctx.userId,
        ]);
      const header = mapHeader(head.rows[0]);
      const lines: JournalLine[] = [];
      for (const ln of j.lines) {
        // posting_date on the line MUST equal the header's (composite FK).
        const lr = await c.query(
          `INSERT INTO fin.gl_entry_line
             (gl_entry_id, posting_date, gl_id, cost_center_id, project_id, debit, credit)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${L}`,
          [
            header.glEntryId, header.postingDate, ln.glId,
            ln.costCenterId ?? null, ln.projectId ?? null, ln.debit, ln.credit,
          ]);
        lines.push(mapLine(lr.rows[0]));
      }
      // Atomic with the inserts: record the domain event (transactional outbox).
      await emitOutbox(c, event);
      return { ...header, lines };
    });
  }

  private async fetchLines(q: Queryable, glEntryId: number, postingDate: string): Promise<JournalLine[]> {
    // Both PK parts are supplied so the planner can target a single partition.
    const res = await q.query(
      `SELECT ${L} FROM fin.gl_entry_line
        WHERE gl_entry_id = $1 AND posting_date = $2 ORDER BY gl_line_id`,
      [glEntryId, postingDate]);
    return res.rows.map(mapLine);
  }

  async findJournal(ctx: RequestContext, glEntryId: number): Promise<JournalEntry | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM fin.gl_entry WHERE gl_entry_id = $1 AND company_id = $2`,
        [glEntryId, ctx.companyId]);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      return { ...header, lines: await this.fetchLines(c, header.glEntryId, header.postingDate) };
    });
  }

  async listJournals(ctx: RequestContext, q: JournalQueryDto): Promise<ListResult<Omit<JournalEntry, 'lines'>>> {
    const where: string[] = ['e.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.sourceDocType) { params.push(q.sourceDocType); where.push(`e.source_doc_type = $${params.length}`); }
    if (q.fromDate) { params.push(q.fromDate); where.push(`e.posting_date >= $${params.length}`); }
    if (q.toDate) { params.push(q.toDate); where.push(`e.posting_date <= $${params.length}`); }
    // projectId filters on the lines: keep only journals that touch the project.
    if (q.projectId) {
      params.push(q.projectId);
      where.push(`EXISTS (SELECT 1 FROM fin.gl_entry_line l
                            WHERE l.gl_entry_id = e.gl_entry_id AND l.posting_date = e.posting_date
                              AND l.project_id = $${params.length})`);
    }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.gl_entry e WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H.replace(/(\w+)/g, 'e.$1')} FROM fin.gl_entry e WHERE ${w}
          ORDER BY e.posting_date DESC, e.gl_entry_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  // ---------------------------------------------------------------------
  // Reads — trial balance + per-account ledger.
  // ---------------------------------------------------------------------
  /** Per-account debit/credit totals (+ balance) up to asOfDate, joined to names. */
  async trialBalance(ctx: RequestContext, q: TrialBalanceQueryDto): Promise<TrialBalanceRow[]> {
    const params: unknown[] = [ctx.companyId];
    let dateFilter = '';
    if (q.asOfDate) { params.push(q.asOfDate); dateFilter = `AND e.posting_date <= $${params.length}`; }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT a.gl_id, a.gl_code, a.gl_name, a.account_type,
                COALESCE(sum(l.debit), 0)::text  AS total_debit,
                COALESCE(sum(l.credit), 0)::text AS total_credit
           FROM mdm.gl_account a
           JOIN fin.gl_entry_line l ON l.gl_id = a.gl_id
           JOIN fin.gl_entry e ON e.gl_entry_id = l.gl_entry_id AND e.posting_date = l.posting_date
          WHERE a.company_id = $1 AND e.company_id = $1 ${dateFilter}
          GROUP BY a.gl_id, a.gl_code, a.gl_name, a.account_type
          ORDER BY a.gl_code`, params);
      return res.rows.map((r) => {
        const totalDebit = Number(r.total_debit);
        const totalCredit = Number(r.total_credit);
        return {
          glId: Number(r.gl_id), glCode: r.gl_code, glName: r.gl_name, accountType: r.account_type,
          totalDebit, totalCredit, balance: totalDebit - totalCredit,
        };
      });
    });
  }

  /** Lines for a single account within a date range (newest first). */
  async accountLedger(ctx: RequestContext, glId: number, q: LedgerQueryDto): Promise<ListResult<JournalLine & { postingDate: string; journalNo: string }>> {
    const where: string[] = ['e.company_id = $1', 'l.gl_id = $2'];
    const params: unknown[] = [ctx.companyId, glId];
    if (q.fromDate) { params.push(q.fromDate); where.push(`e.posting_date >= $${params.length}`); }
    if (q.toDate) { params.push(q.toDate); where.push(`e.posting_date <= $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.gl_entry_line l
           JOIN fin.gl_entry e ON e.gl_entry_id = l.gl_entry_id AND e.posting_date = l.posting_date
          WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${L.replace(/(\w+)/g, 'l.$1')}, e.posting_date, e.journal_no
           FROM fin.gl_entry_line l
           JOIN fin.gl_entry e ON e.gl_entry_id = l.gl_entry_id AND e.posting_date = l.posting_date
          WHERE ${w}
          ORDER BY e.posting_date DESC, l.gl_line_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return {
        rows: rows.rows.map((r) => ({ ...mapLine(r), postingDate: r.posting_date, journalNo: r.journal_no })),
        total, page: q.page, pageSize: q.pageSize,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Project cost ledger (fin.project_cost_ledger) — APPEND-ONLY, partitioned.
  // ---------------------------------------------------------------------
  /** Append one immutable cost row. posting_date defaults to CURRENT_DATE (partition key). */
  async postCost(ctx: RequestContext, k: CostInput): Promise<ProjectCostRow> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.project_cost_ledger
           (posting_date, company_id, project_id, wbs_id, cost_type, cost_stage, amount, ref_doc_type, ref_doc_id, created_by)
         VALUES (COALESCE($1::date, current_date), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${C}`,
        [
          k.postingDate ?? null, ctx.companyId, k.projectId, k.wbsId ?? null,
          k.costType, k.costStage, k.amount, k.refDocType, k.refDocId, ctx.userId,
        ]);
      return mapCost(res.rows[0]);
    });
  }

  /** Sum(amount) grouped by cost_type x cost_stage for one project. */
  async projectCostSummary(ctx: RequestContext, projectId: number): Promise<ProjectCostSummaryRow[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT cost_type, cost_stage, sum(amount)::text AS amount
           FROM fin.project_cost_ledger
          WHERE company_id = $1 AND project_id = $2
          GROUP BY cost_type, cost_stage
          ORDER BY cost_type, cost_stage`,
        [ctx.companyId, projectId]);
      return res.rows.map((r) => ({
        costType: r.cost_type as CostType, costStage: r.cost_stage as CostStage, amount: Number(r.amount),
      }));
    });
  }
}
