import { TestType } from './fatprotocol.constants';

/**
 * One checklist line of a protocol (camelCase projection of qms.fat_protocol_param).
 * `seq` orders the lines and is unique within a protocol (uq_protocol_param). The
 * spec band is optional: spec_min / spec_max may each be null (e.g. a pass/fail
 * visual check carries neither).
 */
export interface FatProtocolParam {
  paramId: number;
  protocolId: number;
  seq: number;
  paramName: string;
  specMin: number | null;
  specMax: number | null;
  uom: string | null;
}

/**
 * A persisted FAT protocol (camelCase projection of qms.fat_protocol). `params` is
 * the ordered list of checklist lines; it is populated on getById and is undefined
 * on list rows (which are header-only for speed). The table has no audit /
 * row_version / is_deleted columns, so none are projected.
 */
export interface FatProtocol {
  protocolId: number;
  companyId: number;
  protocolCode: string;
  protocolName: string;
  itemId: number | null;
  testType: TestType;
  isActive: boolean;
  params?: FatProtocolParam[];
}

export interface FatProtocolListResult {
  rows: FatProtocol[];
  total: number;
  page: number;
  pageSize: number;
}
