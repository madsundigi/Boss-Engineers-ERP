import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  Inspection, InspectionLine, InspectionListResult,
  Gauge, GaugeListResult, CalibrationRecord,
} from './quality.types';
import { ListQueryDto, GaugeListQueryDto } from './quality.dto';
import { DOC_TYPE, InspectionStatus, InspectionResult } from './quality.constants';

/**
 * Header columns of qms.inspection. company_id + insp_no + insp_type + grn_id +
 * wo_id + insp_date + result exist in db/04; the workflow/tenant/audit columns
 * (bu_id, source_doc_type, item_id, project_id, status, inspected_by, created_*,
 * updated_*, row_version, is_deleted) are added by migration 026.
 */
const H = `inspection_id, insp_no, company_id, bu_id, insp_type, source_doc_type, grn_id, wo_id,
  item_id, project_id, insp_date, status, result, inspected_by,
  created_at, created_by, updated_at, row_version`;

type Header = Omit<Inspection, 'lines'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    inspectionId: Number(r.inspection_id),
    inspNo: r.insp_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    inspType: r.insp_type,
    sourceDocType: r.source_doc_type,
    grnId: r.grn_id == null ? null : Number(r.grn_id),
    woId: r.wo_id == null ? null : Number(r.wo_id),
    itemId: r.item_id == null ? null : Number(r.item_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    inspDate: r.insp_date,
    status: r.status,
    result: r.result,
    inspectedBy: r.inspected_by == null ? null : Number(r.inspected_by),
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapLine(r: QueryResultRow): InspectionLine {
  return {
    inspLineId: Number(r.insp_line_id),
    itemId: Number(r.item_id),
    parameter: r.parameter,
    sampleQty: r.sample_qty == null ? null : Number(r.sample_qty),
    acceptedQty: r.accepted_qty == null ? null : Number(r.accepted_qty),
    rejectedQty: r.rejected_qty == null ? null : Number(r.rejected_qty),
    result: r.result,
  };
}
function mapGauge(r: QueryResultRow): Gauge {
  return {
    gaugeId: Number(r.gauge_id),
    companyId: Number(r.company_id),
    gaugeCode: r.gauge_code,
    gaugeName: r.gauge_name,
    gaugeType: r.gauge_type,
    location: r.location,
    lastCalDate: r.last_cal_date,
    nextCalDue: r.next_cal_due,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapCalibration(r: QueryResultRow): CalibrationRecord {
  return {
    calId: Number(r.cal_id),
    gaugeId: Number(r.gauge_id),
    calDate: r.cal_date,
    dueDate: r.due_date,
    result: r.result,
    certificateNo: r.certificate_no,
    calibratedBy: r.calibrated_by == null ? null : Number(r.calibrated_by),
    createdAt: r.created_at,
  };
}

const G = `gauge_id, company_id, gauge_code, gauge_name, gauge_type, location,
  last_cal_date, next_cal_due, status, created_at, created_by, updated_at, row_version`;

export interface InspectionHeaderInput {
  inspType: string;
  sourceDocType?: string;
  grnId?: number;
  woId?: number;
  itemId?: number;
  projectId?: number;
  inspDate?: string;
}
export interface GaugeInput {
  gaugeCode: string;
  gaugeName: string;
  gaugeType?: string;
  location?: string;
  lastCalDate?: string;
  nextCalDue?: string;
  status: string;
}
export interface CalibrationInput {
  calDate: string;
  dueDate?: string;
  result: string;
  certificateNo?: string;
}
/** A per-line result patch applied when recording an inspection's outcome. */
export interface LineResultInput {
  inspLineId: number;
  acceptedQty?: number;
  rejectedQty?: number;
  result: InspectionResult;
}

export class QualityRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchLines(q: Queryable, id: number): Promise<InspectionLine[]> {
    const res = await q.query(
      `SELECT insp_line_id, item_id, parameter, sample_qty, accepted_qty, rejected_qty, result
         FROM qms.inspection_line WHERE inspection_id = $1 ORDER BY insp_line_id`, [id]);
    return res.rows.map(mapLine);
  }
  private async insertLines(q: Queryable, id: number, lines: InspectionLine[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO qms.inspection_line
           (inspection_id, item_id, parameter, sample_qty, accepted_qty, rejected_qty, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, l.itemId, l.parameter ?? null, l.sampleQty ?? null,
         l.acceptedQty ?? null, l.rejectedQty ?? null, l.result ?? null]);
    }
  }

  /** Insert an inspection (PENDING), allocating the gapless INSP number in-tx. */
  async create(ctx: RequestContext, h: InspectionHeaderInput, lines: InspectionLine[]): Promise<Inspection> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO qms.inspection
           (company_id, bu_id, insp_no, insp_type, source_doc_type, grn_id, wo_id,
            item_id, project_id, insp_date, status, inspected_by, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8, COALESCE($9::date, current_date), 'PENDING', $10, $10)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.inspType, h.sourceDocType ?? null, h.grnId ?? null,
          h.woId ?? null, h.itemId ?? null, h.projectId ?? null, h.inspDate ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertLines(c, header.inspectionId, lines);
      return { ...header, lines: await this.fetchLines(c, header.inspectionId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Inspection | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM qms.inspection
          WHERE inspection_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<InspectionListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.result) { params.push(q.result); where.push(`result = $${params.length}`); }
    if (q.source) { params.push(q.source); where.push(`source_doc_type = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`insp_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM qms.inspection WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM qms.inspection WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Record the per-line results + overall result and move PENDING -> terminal,
   * all under one optimistic lock. An optional outbox event ('inspection.failed'
   * on a FAIL overall) is emitted atomically. Returns null on a version mismatch.
   */
  async recordResults(
    ctx: RequestContext, id: number, expectedVersion: number, status: InspectionStatus,
    result: InspectionResult, lineResults: LineResultInput[], event?: OutboxEventInput,
  ): Promise<Inspection | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE qms.inspection
            SET status = $1, result = $2, updated_by = $3, updated_at = now(),
                row_version = row_version + 1
          WHERE inspection_id = $4 AND company_id = $5 AND row_version = $6 AND NOT is_deleted
        RETURNING ${H}`,
        [status, result, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      for (const lr of lineResults) {
        await c.query(
          `UPDATE qms.inspection_line
              SET result = $1, accepted_qty = COALESCE($2, accepted_qty),
                  rejected_qty = COALESCE($3, rejected_qty)
            WHERE insp_line_id = $4 AND inspection_id = $5`,
          [lr.result, lr.acceptedQty ?? null, lr.rejectedQty ?? null, lr.inspLineId, id]);
      }
      if (event) await emitOutbox(c, event);
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  /** Soft delete (PENDING only — enforced by the service). Returns true if deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE qms.inspection
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE inspection_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // -------------------------------------------------------------------------
  // Calibration register
  // -------------------------------------------------------------------------

  /** Register a gauge (ACTIVE by default). The gauge_code is unique per company. */
  async createGauge(ctx: RequestContext, g: GaugeInput): Promise<Gauge> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO qms.gauge
           (company_id, gauge_code, gauge_name, gauge_type, location,
            last_cal_date, next_cal_due, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${G}`,
        [
          ctx.companyId, g.gaugeCode, g.gaugeName, g.gaugeType ?? null, g.location ?? null,
          g.lastCalDate ?? null, g.nextCalDue ?? null, g.status, ctx.userId,
        ]);
      return mapGauge(res.rows[0]);
    });
  }

  async findGaugeById(ctx: RequestContext, gaugeId: number): Promise<Gauge | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${G} FROM qms.gauge
          WHERE gauge_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [gaugeId, ctx.companyId]);
      return res.rowCount ? mapGauge(res.rows[0]) : null;
    });
  }

  async listGauges(ctx: RequestContext, q: GaugeListQueryDto): Promise<GaugeListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.due) where.push(`next_cal_due IS NOT NULL AND next_cal_due <= current_date`);
    if (q.q) { params.push(`%${q.q}%`); where.push(`(gauge_code ILIKE $${params.length} OR gauge_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM qms.gauge WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${G} FROM qms.gauge WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} NULLS LAST LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapGauge), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Record a calibration event and advance the gauge's last_cal_date / next_cal_due
   * (and status) atomically. Returns the refreshed gauge + the new record, or null
   * if the gauge does not exist for this company.
   */
  async recordCalibration(
    ctx: RequestContext, gaugeId: number, cal: CalibrationInput, gaugeStatus: string,
  ): Promise<{ gauge: Gauge; record: CalibrationRecord } | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query(
        `UPDATE qms.gauge
            SET last_cal_date = $1::date, next_cal_due = $2::date, status = $3,
                updated_by = $4, updated_at = now(), row_version = row_version + 1
          WHERE gauge_id = $5 AND company_id = $6 AND NOT is_deleted
        RETURNING ${G}`,
        [cal.calDate, cal.dueDate ?? null, gaugeStatus, ctx.userId, gaugeId, ctx.companyId]);
      if (!upd.rowCount) return null;
      const rec = await c.query(
        `INSERT INTO qms.calibration_record
           (gauge_id, cal_date, due_date, result, certificate_no, calibrated_by)
         VALUES ($1,$2::date,$3::date,$4,$5,$6)
         RETURNING cal_id, gauge_id, cal_date, due_date, result, certificate_no, calibrated_by, created_at`,
        [gaugeId, cal.calDate, cal.dueDate ?? null, cal.result, cal.certificateNo ?? null, ctx.userId]);
      return { gauge: mapGauge(upd.rows[0]), record: mapCalibration(rec.rows[0]) };
    });
  }

  /** Full calibration history for a gauge, newest first. */
  async gaugeHistory(ctx: RequestContext, gaugeId: number): Promise<CalibrationRecord[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT cr.cal_id, cr.gauge_id, cr.cal_date, cr.due_date, cr.result,
                cr.certificate_no, cr.calibrated_by, cr.created_at
           FROM qms.calibration_record cr
           JOIN qms.gauge g ON g.gauge_id = cr.gauge_id
          WHERE cr.gauge_id = $1 AND g.company_id = $2
          ORDER BY cr.cal_date DESC, cr.cal_id DESC`,
        [gaugeId, ctx.companyId]);
      return res.rows.map(mapCalibration);
    });
  }
}
