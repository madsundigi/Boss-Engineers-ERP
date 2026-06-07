import { z } from 'zod';
import {
  INSPECTION_STATUS, INSPECTION_RESULT, INSPECTION_TYPE, INSPECTION_SOURCE,
  GAUGE_STATUS, CALIBRATION_RESULT,
} from './quality.constants';

const t = (n: number) => z.string().trim().max(n);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** A single parameter line to inspect (item + optional sampling quantities). */
const lineSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  parameter: t(120).optional(),
  sampleQty: z.coerce.number().min(0).optional(),
  acceptedQty: z.coerce.number().min(0).optional(),
  rejectedQty: z.coerce.number().min(0).optional(),
});

/**
 * POST /api/inspections — raise an inspection in PENDING against a source doc
 * (a GRN for incoming, or a work order for in-process/final) with 1..n parameter
 * lines. Tenant/user/branch come from context.
 */
export const createInspectionSchema = z.object({
  inspType: z.enum(INSPECTION_TYPE).default('INCOMING'),
  sourceDocType: z.enum(INSPECTION_SOURCE).optional(),
  grnId: z.coerce.number().int().positive().optional(),
  woId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  inspDate: ymd.optional(),
  lines: z.array(lineSchema).min(1, 'At least one parameter line is required').max(500),
});
export type CreateInspectionDto = z.infer<typeof createInspectionSchema>;

/** A per-line result captured when recording the inspection outcome. */
const resultLineSchema = z.object({
  inspLineId: z.coerce.number().int().positive(),
  acceptedQty: z.coerce.number().min(0).optional(),
  rejectedQty: z.coerce.number().min(0).optional(),
  result: z.enum(INSPECTION_RESULT),
});

/**
 * POST /api/inspections/:id/results — record per-line accept/reject + the overall
 * result, moving PENDING -> PASS|FAIL|PARTIAL. A FAIL overall emits
 * 'inspection.failed' so a downstream NCR can be raised.
 */
export const recordResultsSchema = z.object({
  result: z.enum(INSPECTION_RESULT),
  lines: z.array(resultLineSchema).min(1).max(500),
  rowVersion: z.coerce.number().int().positive(),
});
export type RecordResultsDto = z.infer<typeof recordResultsSchema>;

/** GET /api/inspections — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(INSPECTION_STATUS).optional(),
  result: z.enum(INSPECTION_RESULT).optional(),
  source: z.enum(INSPECTION_SOURCE).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on insp_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['insp_no', 'insp_date', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;

/** Optimistic-concurrency-only body (close / sign-off / delete-with-version). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

// ---------------------------------------------------------------------------
// Calibration register
// ---------------------------------------------------------------------------

/** POST /api/inspections/gauges — register a measuring gauge in the register. */
export const registerGaugeSchema = z.object({
  gaugeCode: t(40).min(1, 'A gauge code is required'),
  gaugeName: t(120).min(1, 'A gauge name is required'),
  gaugeType: t(60).optional(),
  location: t(120).optional(),
  lastCalDate: ymd.optional(),
  nextCalDue: ymd.optional(),
  status: z.enum(GAUGE_STATUS).default('ACTIVE'),
});
export type RegisterGaugeDto = z.infer<typeof registerGaugeSchema>;

/**
 * POST /api/inspections/gauges/:gaugeId/calibrations — record a calibration event;
 * the gauge's last_cal_date / next_cal_due are advanced from this record.
 */
export const recordCalibrationSchema = z.object({
  calDate: ymd,
  dueDate: ymd.optional(),
  result: z.enum(CALIBRATION_RESULT),
  certificateNo: t(60).optional(),
});
export type RecordCalibrationDto = z.infer<typeof recordCalibrationSchema>;

/** GET /api/inspections/gauges — list filters (due/overdue by next_cal_due<=today). */
export const gaugeListQuerySchema = z.object({
  status: z.enum(GAUGE_STATUS).optional(),
  due: z.coerce.boolean().optional(), // true => only gauges with next_cal_due <= today
  q: t(60).optional(), // free-text on gauge_code / gauge_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['gauge_code', 'next_cal_due', 'status', 'created_at']).default('next_cal_due'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type GaugeListQueryDto = z.infer<typeof gaugeListQuerySchema>;
