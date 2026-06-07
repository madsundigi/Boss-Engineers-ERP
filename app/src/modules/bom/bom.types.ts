import { BomStatus, BomType } from './bom.constants';

/** A component line (camelCase projection of mdm.bom_line). */
export interface BomLine {
  bomLineId?: number;
  componentItemId: number;
  qtyPer: number;
  uomId: number;
  scrapPct: number;
  isCritical: boolean;
}

/** A persisted BOM header with its nested component lines (mdm.bom_header). */
export interface BomHeader {
  bomId: number;
  bomNo: string;
  companyId: number;
  buId: number | null;
  parentItemId: number;
  bomType: BomType;
  revision: string;
  projectId: number | null;
  status: BomStatus;
  effectiveFrom: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  lines: BomLine[];
}

export interface BomListResult {
  rows: Omit<BomHeader, 'lines'>[];
  total: number;
  page: number;
  pageSize: number;
}
