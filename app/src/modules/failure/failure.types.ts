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
