import {
  InspectionStatus, InspectionResult, InspectionType, GaugeStatus, CalibrationResult,
} from './quality.constants';

/** A per-parameter inspection check (camelCase projection of qms.inspection_line). */
export interface InspectionLine {
  inspLineId?: number;
  itemId: number;
  parameter: string | null;
  sampleQty: number | null;
  acceptedQty: number | null;
  rejectedQty: number | null;
  result: InspectionResult | null;
}

/** A persisted inspection header (camelCase projection of qms.inspection). */
export interface Inspection {
  inspectionId: number;
  inspNo: string;
  companyId: number;
  buId: number | null;
  inspType: InspectionType;
  sourceDocType: string | null;
  grnId: number | null;
  woId: number | null;
  itemId: number | null;
  projectId: number | null;
  inspDate: string;
  status: InspectionStatus;
  result: InspectionResult | null;
  inspectedBy: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  lines: InspectionLine[];
}

export interface InspectionListResult {
  rows: Omit<Inspection, 'lines'>[];
  total: number;
  page: number;
  pageSize: number;
}

/** A persisted measuring gauge in the calibration register (qms.gauge). */
export interface Gauge {
  gaugeId: number;
  companyId: number;
  gaugeCode: string;
  gaugeName: string;
  gaugeType: string | null;
  location: string | null;
  lastCalDate: string | null;
  nextCalDue: string | null;
  status: GaugeStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface GaugeListResult {
  rows: Gauge[];
  total: number;
  page: number;
  pageSize: number;
}

/** A calibration event against a gauge (qms.calibration_record). */
export interface CalibrationRecord {
  calId: number;
  gaugeId: number;
  calDate: string;
  dueDate: string | null;
  result: CalibrationResult;
  certificateNo: string | null;
  calibratedBy: number | null;
  createdAt: string;
}
