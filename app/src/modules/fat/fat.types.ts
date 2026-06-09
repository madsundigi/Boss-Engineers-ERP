import { FatResult, FatStatus, PunchSeverity, ResultPassFail } from './fat.constants';

/** A measured-value line (camelCase projection of qms.fat_result_line). */
export interface FatResultLine {
  resultLineId?: number;
  paramId: number;
  measuredValue: number | null;
  passFail: ResultPassFail;
}

/** A defect raised by a failed/conditional FAT (camelCase projection of qms.punch_item). */
export interface PunchItem {
  punchId?: number;
  description: string;
  severity: PunchSeverity | null;
  status: 'OPEN' | 'CLOSED';
  closedDate: string | null;
}

/** A persisted FAT execution row (camelCase projection of qms.fat_execution). */
export interface Fat {
  fatId: number;
  fatNo: string;
  companyId: number;
  buId: number | null;
  projectId: number;
  woId: number | null;
  protocolId: number;
  fatDate: string;
  status: FatStatus;
  result: FatResult | null;
  customerWitness: string | null;
  engineerId: number | null;
  signoffBy: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  resultLines: FatResultLine[];
  punchItems: PunchItem[];
}

export interface FatListResult {
  rows: Omit<Fat, 'resultLines' | 'punchItems'>[];
  total: number;
  page: number;
  pageSize: number;
}
