import { AccountType, CostType, CostStage } from './gl.constants';

/** A chart-of-accounts entry (camelCase projection of mdm.gl_account). */
export interface GlAccount {
  glId: number;
  companyId: number;
  glCode: string;
  glName: string;
  accountType: AccountType;
  isActive: boolean;
}

/** One side of a journal — a debit OR a credit against an account (gl_entry_line). */
export interface JournalLine {
  glLineId?: number;
  glId: number;
  costCenterId: number | null;
  projectId: number | null;
  debit: number;
  credit: number;
}

/**
 * A posted journal header with its lines (projection of fin.gl_entry +
 * fin.gl_entry_line). APPEND-ONLY: no rowVersion, no status, no soft-delete.
 * postingDate is the partition key and part of the composite PK.
 */
export interface JournalEntry {
  glEntryId: number;
  companyId: number;
  buId: number | null;
  postingDate: string;
  journalNo: string;
  narration: string | null;
  sourceDocType: string | null;
  sourceDocId: number | null;
  createdBy: number | null;
  createdAt: string;
  lines: JournalLine[];
}

/** One appended project-cost row (projection of fin.project_cost_ledger). */
export interface ProjectCostRow {
  costId: number;
  postingDate: string;
  companyId: number;
  projectId: number;
  wbsId: number | null;
  costType: CostType;
  costStage: CostStage;
  amount: number;
  refDocType: string;
  refDocId: number;
  createdBy: number | null;
  createdAt: string;
}

/** A trial-balance row: per-account debit/credit totals + closing balance. */
export interface TrialBalanceRow {
  glId: number;
  glCode: string;
  glName: string;
  accountType: AccountType;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

/** A project-cost-summary row: amount rolled up by cost type x cost stage. */
export interface ProjectCostSummaryRow {
  costType: CostType;
  costStage: CostStage;
  amount: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}
