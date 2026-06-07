import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import { GlRepository, JournalInput, CostInput } from './gl.repository';
import {
  GlAccount, JournalEntry, ProjectCostRow, TrialBalanceRow, ProjectCostSummaryRow, ListResult,
} from './gl.types';
import {
  CreateAccountDto, AccountQueryDto, PostJournalDto, JournalQueryDto,
  TrialBalanceQueryDto, LedgerQueryDto, PostCostDto,
} from './gl.dto';
import { GL_JOURNAL_POSTED_EVENT } from './gl.constants';

/** Money is stored as numeric(20,4); round comparisons to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * GlService — business logic for the Finance General Ledger.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. The ledger is DOUBLE-ENTRY and APPEND-ONLY: a posted
 * journal is immutable (no update / delete) — a correction is a new reversing
 * journal. postJournal enforces the balanced-entry invariant before any insert.
 */
export class GlService {
  constructor(private readonly repo: GlRepository) {}

  // -------- Chart of accounts --------
  async createAccount(ctx: RequestContext, dto: CreateAccountDto): Promise<GlAccount> {
    // gl_code is unique per company (uq_gl) — pre-check for a friendly 409 rather
    // than surfacing a raw constraint violation.
    const existing = await this.repo.findAccountByCode(ctx, dto.glCode);
    if (existing) throw Errors.conflict(`GL code '${dto.glCode}' already exists`);
    return this.repo.createAccount(ctx, {
      glCode: dto.glCode, glName: dto.glName, accountType: dto.accountType,
      isActive: dto.isActive ?? true,
    });
  }

  listAccounts(ctx: RequestContext, query: AccountQueryDto): Promise<GlAccount[]> {
    return this.repo.listAccounts(ctx, query);
  }

  async getAccount(ctx: RequestContext, glId: number): Promise<GlAccount> {
    const row = await this.repo.findAccount(ctx, glId);
    if (!row) throw Errors.notFound(`GL account ${glId} not found`);
    return row;
  }

  async setActive(ctx: RequestContext, glId: number, isActive: boolean): Promise<GlAccount> {
    const row = await this.repo.setActive(ctx, glId, isActive);
    if (!row) throw Errors.notFound(`GL account ${glId} not found`);
    return row;
  }

  // -------- Journal posting (core) --------
  /**
   * Post a balanced, immutable journal. Enforces the double-entry invariant:
   *   - >= 2 lines (the zod schema also guards this);
   *   - every line has EXACTLY ONE of debit/credit > 0 (the other 0), >= 0;
   *   - total debits == total credits, and the total is > 0;
   *   - every glId exists, belongs to the company, and is active.
   * On success: insert header + lines + the 'gl.journal.posted' outbox event in
   * one transaction. Requires ctx.buId (numbering scope) — 400 if missing.
   */
  async postJournal(ctx: RequestContext, dto: PostJournalDto): Promise<JournalEntry> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a journal number');
    }
    if (dto.lines.length < 2) {
      throw Errors.badRequest('A journal needs at least two lines');
    }

    let totalDebit = 0;
    let totalCredit = 0;
    const lines = dto.lines.map((ln, i) => {
      const debit = ln.debit ?? 0;
      const credit = ln.credit ?? 0;
      if (debit < 0 || credit < 0) {
        throw Errors.badRequest(`Line ${i + 1}: debit and credit must be non-negative`);
      }
      // Exactly one side may be positive — never both, never neither.
      const debitPos = debit > 0;
      const creditPos = credit > 0;
      if (debitPos && creditPos) {
        throw Errors.badRequest(`Line ${i + 1}: a line cannot have both a debit and a credit`);
      }
      if (!debitPos && !creditPos) {
        throw Errors.badRequest(`Line ${i + 1}: a line must have either a debit or a credit greater than zero`);
      }
      totalDebit += debit;
      totalCredit += credit;
      return {
        glId: ln.glId, debit, credit,
        costCenterId: ln.costCenterId, projectId: ln.projectId,
      };
    });

    totalDebit = round4(totalDebit);
    totalCredit = round4(totalCredit);
    if (totalDebit <= 0) {
      throw Errors.badRequest('A journal must post a positive amount');
    }
    if (totalDebit !== totalCredit) {
      // The balanced-entry invariant: sum(debits) must equal sum(credits).
      throw Errors.badRequest(
        `Journal is not balanced: debits ${totalDebit} != credits ${totalCredit}`,
      );
    }

    // Validate referenced accounts: must exist, be in-company, and be active.
    const ids = [...new Set(lines.map((l) => l.glId))];
    const found = await this.repo.findAccountsByIds(ctx, ids);
    const foundMap = new Map(found.map((a) => [a.glId, a.isActive]));
    const missing = ids.filter((id) => !foundMap.has(id));
    if (missing.length > 0) {
      throw Errors.badRequest(`Unknown GL account(s): ${missing.join(', ')}`);
    }
    const inactive = ids.filter((id) => foundMap.get(id) === false);
    if (inactive.length > 0) {
      throw Errors.conflict(`Inactive GL account(s) cannot be posted to: ${inactive.join(', ')}`);
    }

    const input: JournalInput = {
      postingDate: dto.postingDate,
      narration: dto.narration,
      sourceDocType: dto.sourceDocType,
      sourceDocId: dto.sourceDocId,
      totalDebit,
      lines,
    };
    return this.repo.postJournal(ctx, input, this.postedEvent(ctx, dto, totalDebit));
  }

  /** Build the transactional-outbox event for a posted journal. */
  private postedEvent(ctx: RequestContext, dto: PostJournalDto, totalDebit: number): OutboxEventInput {
    return {
      eventType: GL_JOURNAL_POSTED_EVENT,
      aggregateType: 'GL_ENTRY',
      aggregateId: null, // gl_entry_id is allocated in the same tx; not known here
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        // journalNo is allocated by the DB; the consumer reads the row by source doc.
        journalNo: null,
        postingDate: dto.postingDate ?? null,
        sourceDocType: dto.sourceDocType ?? null,
        sourceDocId: dto.sourceDocId ?? null,
        totalDebit,
      },
    };
  }

  async getJournal(ctx: RequestContext, glEntryId: number): Promise<JournalEntry> {
    const row = await this.repo.findJournal(ctx, glEntryId);
    if (!row) throw Errors.notFound(`Journal ${glEntryId} not found`);
    return row;
  }

  listJournals(ctx: RequestContext, query: JournalQueryDto): Promise<ListResult<Omit<JournalEntry, 'lines'>>> {
    return this.repo.listJournals(ctx, query);
  }

  /**
   * Reverse a posted journal: post a NEW mirror journal that swaps debit<->credit
   * on every line (the append-only correction path; the original stays immutable).
   */
  async reverseJournal(ctx: RequestContext, glEntryId: number): Promise<JournalEntry> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a journal number');
    }
    const original = await this.getJournal(ctx, glEntryId); // 404 if missing
    const reversal: PostJournalDto = {
      narration: `Reversal of ${original.journalNo}`,
      sourceDocType: 'REVERSAL',
      sourceDocId: original.glEntryId,
      lines: original.lines.map((l) => ({
        glId: l.glId,
        debit: l.credit, // swap
        credit: l.debit,
        costCenterId: l.costCenterId ?? undefined,
        projectId: l.projectId ?? undefined,
      })),
    };
    return this.postJournal(ctx, reversal);
  }

  // -------- Reads --------
  trialBalance(ctx: RequestContext, query: TrialBalanceQueryDto): Promise<TrialBalanceRow[]> {
    return this.repo.trialBalance(ctx, query);
  }

  async accountLedger(ctx: RequestContext, glId: number, query: LedgerQueryDto) {
    await this.getAccount(ctx, glId); // 404 if the account is unknown
    return this.repo.accountLedger(ctx, glId, query);
  }

  // -------- Project cost ledger --------
  /** Append one immutable project-cost row (cost_type/cost_stage validated by zod). */
  async postCost(ctx: RequestContext, dto: PostCostDto): Promise<ProjectCostRow> {
    if (dto.amount === 0) {
      throw Errors.badRequest('A cost amount of zero is not allowed');
    }
    const input: CostInput = {
      projectId: dto.projectId, wbsId: dto.wbsId, costType: dto.costType,
      costStage: dto.costStage, amount: dto.amount, refDocType: dto.refDocType,
      refDocId: dto.refDocId, postingDate: dto.postingDate,
    };
    return this.repo.postCost(ctx, input);
  }

  projectCostSummary(ctx: RequestContext, projectId: number): Promise<ProjectCostSummaryRow[]> {
    return this.repo.projectCostSummary(ctx, projectId);
  }

  // -------- Export --------
  /** GL.EXPORT — CSV of the trial balance (the canonical finance export). */
  async exportTrialBalanceCsv(ctx: RequestContext, query: TrialBalanceQueryDto): Promise<string> {
    const rows = await this.repo.trialBalance(ctx, query);
    const head = ['GL Code', 'GL Name', 'Account Type', 'Total Debit', 'Total Credit', 'Balance'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.glCode, r.glName, r.accountType, r.totalDebit, r.totalCredit, r.balance].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
