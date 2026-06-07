/** Domain constants for the Finance — General Ledger (GL) module. */

/**
 * The GL is a DOUBLE-ENTRY, APPEND-ONLY, PARTITIONED ledger. A posted journal
 * (fin.gl_entry + fin.gl_entry_line) is IMMUTABLE: there is no update and no
 * delete. A correction is a new *reversing* journal that mirrors the original.
 * Both fin.gl_entry and fin.project_cost_ledger are PARTITIONED BY RANGE on
 * posting_date (monthly partitions + a DEFAULT), so every insert MUST carry a
 * posting_date — it is the partition key and part of the composite PK.
 */

/**
 * RBAC permission codes (mirror sec.permission catalog in db/08 — the GL module
 * x {VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT} is already seeded there; grants:
 *   FINANCE = VCEDAX (all six),  CEO = VX (view + export),  ADMIN = V (view)).
 * Post (journal / cost) and account creation -> GL.CREATE; setActive / reverse
 * -> GL.EDIT; every read -> GL.VIEW; CSV export -> GL.EXPORT.
 */
export const GL_PERMS = {
  VIEW: 'GL.VIEW',
  CREATE: 'GL.CREATE',
  EDIT: 'GL.EDIT',
  DELETE: 'GL.DELETE',
  APPROVE: 'GL.APPROVE',
  EXPORT: 'GL.EXPORT',
} as const;

/** Account types of a chart-of-accounts entry (mdm.gl_account.account_type CHECK). */
export const ACCOUNT_TYPE = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPE)[number];

/** Cost type of a project-cost-ledger row (fin.project_cost_ledger.cost_type CHECK). */
export const COST_TYPE = ['MATERIAL', 'LABOUR', 'SUBCON', 'FREIGHT', 'OVERHEAD', 'WARRANTY'] as const;
export type CostType = (typeof COST_TYPE)[number];

/** Cost stage of a project-cost-ledger row (fin.project_cost_ledger.cost_stage CHECK). */
export const COST_STAGE = ['BUDGET', 'COMMITTED', 'ACTUAL'] as const;
export type CostStage = (typeof COST_STAGE)[number];

/** Document-numbering type registered in mdm.numbering_rule (prefix 'JV', pad 6). */
export const DOC_TYPE = 'JOURNAL';

/**
 * Domain event emitted when a journal is posted (atomically with the insert via
 * the transactional outbox). Payload:
 *   { journalNo, postingDate, sourceDocType, sourceDocId, totalDebit }.
 * Downstream consumers (profitability / dashboards) react to GL movement.
 */
export const GL_JOURNAL_POSTED_EVENT = 'gl.journal.posted';
