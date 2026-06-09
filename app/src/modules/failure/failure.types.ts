import { NcrStatus, NcrSource, RcaMethod, CapaType, CapaStatus } from './failure.constants';

/** A root-cause analysis on an NCR (camelCase projection of qms.rca). */
export interface Rca {
  rcaId: number;
  method: RcaMethod;
  rootCause: string | null;
  analysis: Record<string, unknown> | null;
  analysedBy: number | null;
  analysedAt: string;
}

/** A step under a CAPA (camelCase projection of qms.capa_action). */
export interface CapaAction {
  capaActionId: number;
  capaId: number;
  description: string;
  ownerId: number | null;
  dueDate: string | null;
  doneDate: string | null;
  status: string;
}

/** A corrective/preventive action on an NCR (camelCase projection of qms.capa). */
export interface Capa {
  capaId: number;
  capaType: CapaType;
  action: string;
  ownerId: number | null;
  dueDate: string | null;
  effectivenessCheck: string | null;
  status: CapaStatus;
  actions: CapaAction[];
}

/** A persisted NCR row with its nested RCA + CAPA children (qms.ncr). */
export interface Ncr {
  ncrId: number;
  ncrNo: string;
  companyId: number;
  buId: number | null;
  source: NcrSource;
  sourceDocId: number | null;
  itemId: number | null;
  projectId: number | null;
  failureModeId: number | null;
  severity: string | null;
  raisedDate: string;
  status: NcrStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  rca: Rca[];
  capa: Capa[];
}

export interface NcrListResult {
  rows: Omit<Ncr, 'rca' | 'capa'>[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One bucket of a raw Pareto count straight off the GROUP BY (repository layer).
 * `key` is the dimension's id/value (failureModeId, or the severity/source string);
 * null means the dimension was not set on the NCR. `label` is the human name.
 */
export interface ParetoCount {
  key: number | string | null;
  label: string;
  count: number;
}

/**
 * One row of the assembled Pareto report (service layer): the raw count enriched
 * with its share (`pct`) and the running `cumulativePct`, plus `isRepeat` — true
 * when the bucket recurred (count >= 2), which surfaces the "Repeat Failure"
 * dimension the spec calls for. `failureModeId` / `failureMode` are kept as the
 * row identity even when bucketing by severity/source (the value lands in both).
 */
export interface ParetoRow {
  failureModeId: number | string | null;
  failureMode: string;
  count: number;
  pct: number;            // count / total * 100, rounded to 2dp
  cumulativePct: number;  // running Σ pct down the ordered rows, rounded to 2dp
  isRepeat: boolean;      // count >= 2 (a recurring / repeat failure)
}

/** The full Pareto / repeat-failure report (GET /api/ncrs/pareto). */
export interface ParetoReport {
  by: 'mode' | 'severity' | 'source';
  total: number;          // total NCRs in the (date-filtered) population
  rows: ParetoRow[];      // ordered by count DESC
}
