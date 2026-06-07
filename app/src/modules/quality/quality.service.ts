import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  QualityRepository, InspectionHeaderInput, GaugeInput, CalibrationInput, LineResultInput,
} from './quality.repository';
import {
  Inspection, InspectionListResult, InspectionLine,
  Gauge, GaugeListResult, CalibrationRecord,
} from './quality.types';
import {
  CreateInspectionDto, RecordResultsDto, ListQueryDto,
  RegisterGaugeDto, RecordCalibrationDto, GaugeListQueryDto,
} from './quality.dto';
import {
  InspectionResult, InspectionStatus, INSPECTION_FAILED_EVENT, GaugeStatus,
} from './quality.constants';

/**
 * QualityService — business logic for the QMS Inspection & Gauge Calibration
 * module. Stateless; depends only on the repository (injected) so it is
 * unit-testable without a database. Incoming/in-process/final inspections move
 * PENDING -> PASS|FAIL|PARTIAL; a FAIL overall emits 'inspection.failed' so the
 * separate failure module can raise an NCR. The calibration register tracks
 * gauges and their due dates (the classic ISO calibration control).
 */
export class QualityService {
  constructor(private readonly repo: QualityRepository) {}

  private mapLines(dto: CreateInspectionDto['lines']): InspectionLine[] {
    return dto.map((l) => ({
      itemId: l.itemId,
      parameter: l.parameter ?? null,
      sampleQty: l.sampleQty ?? null,
      acceptedQty: l.acceptedQty ?? null,
      rejectedQty: l.rejectedQty ?? null,
      result: null,
    }));
  }

  async create(ctx: RequestContext, dto: CreateInspectionDto): Promise<Inspection> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an inspection number');
    }
    const header: InspectionHeaderInput = {
      inspType: dto.inspType,
      sourceDocType: dto.sourceDocType,
      grnId: dto.grnId,
      woId: dto.woId,
      itemId: dto.itemId,
      projectId: dto.projectId,
      inspDate: dto.inspDate,
    };
    return this.repo.create(ctx, header, this.mapLines(dto.lines));
  }

  async getById(ctx: RequestContext, id: number): Promise<Inspection> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Inspection ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<InspectionListResult> {
    return this.repo.list(ctx, query);
  }

  /**
   * Record per-line results + the overall result, moving PENDING -> terminal.
   * Only a PENDING inspection can be recorded (else 409). The overall status
   * equals the overall result; a FAIL emits 'inspection.failed' atomically so a
   * downstream NCR can be raised. Returns 409 on a row-version mismatch.
   */
  async recordResults(ctx: RequestContext, id: number, dto: RecordResultsDto): Promise<Inspection> {
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'PENDING') {
      throw Errors.conflict(`Results can only be recorded on a PENDING inspection (current: ${existing.status})`);
    }
    const status = dto.result as InspectionStatus; // PASS|FAIL|PARTIAL are valid statuses
    const result = dto.result as InspectionResult;
    const lineResults: LineResultInput[] = dto.lines.map((l) => ({
      inspLineId: l.inspLineId,
      acceptedQty: l.acceptedQty,
      rejectedQty: l.rejectedQty,
      result: l.result,
    }));

    const event = result === 'FAIL'
      ? {
          eventType: INSPECTION_FAILED_EVENT, aggregateType: 'INSPECTION', aggregateId: id,
          companyId: ctx.companyId, createdBy: ctx.userId,
          payload: {
            inspNo: existing.inspNo,
            inspectionId: id,
            sourceDocType: existing.sourceDocType,
            itemId: existing.itemId,
            projectId: existing.projectId,
          },
        }
      : undefined;

    const updated = await this.repo.recordResults(ctx, id, dto.rowVersion, status, result, lineResults, event);
    if (!updated) {
      throw Errors.conflict('Inspection was modified by someone else (row version mismatch)', {
        expected: dto.rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PENDING') {
      throw Errors.conflict(`Only a PENDING inspection can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** INSPECTION.EXPORT — CSV of the (filtered) inspection list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Inspection No', 'Type', 'Source', 'Item', 'Project', 'Date', 'Status', 'Result', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.inspNo, r.inspType, r.sourceDocType, r.itemId, r.projectId, r.inspDate, r.status, r.result, r.createdAt]
        .map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // -------------------------------------------------------------------------
  // Calibration register
  // -------------------------------------------------------------------------

  registerGauge(ctx: RequestContext, dto: RegisterGaugeDto): Promise<Gauge> {
    const g: GaugeInput = {
      gaugeCode: dto.gaugeCode, gaugeName: dto.gaugeName, gaugeType: dto.gaugeType,
      location: dto.location, lastCalDate: dto.lastCalDate, nextCalDue: dto.nextCalDue, status: dto.status,
    };
    return this.repo.createGauge(ctx, g);
  }

  async getGaugeById(ctx: RequestContext, gaugeId: number): Promise<Gauge> {
    const g = await this.repo.findGaugeById(ctx, gaugeId);
    if (!g) throw Errors.notFound(`Gauge ${gaugeId} not found`);
    return g;
  }

  listGauges(ctx: RequestContext, query: GaugeListQueryDto): Promise<GaugeListResult> {
    return this.repo.listGauges(ctx, query);
  }

  /**
   * Record a calibration event. The gauge's last_cal_date / next_cal_due advance
   * to this record's dates; the gauge status is derived from the result + due
   * date (a passed cal whose due date is already in the past is immediately DUE;
   * a FAIL leaves the gauge OUT_OF_CAL). 404 if the gauge is unknown.
   */
  async recordCalibration(ctx: RequestContext, gaugeId: number, dto: RecordCalibrationDto): Promise<{ gauge: Gauge; record: CalibrationRecord }> {
    await this.getGaugeById(ctx, gaugeId); // 404 if missing
    const cal: CalibrationInput = {
      calDate: dto.calDate, dueDate: dto.dueDate, result: dto.result, certificateNo: dto.certificateNo,
    };
    const status = deriveGaugeStatus(dto.result, dto.dueDate);
    const out = await this.repo.recordCalibration(ctx, gaugeId, cal, status);
    if (!out) throw Errors.notFound(`Gauge ${gaugeId} not found`);
    return out;
  }

  gaugeHistory(ctx: RequestContext, gaugeId: number): Promise<CalibrationRecord[]> {
    return this.repo.gaugeHistory(ctx, gaugeId);
  }
}

/**
 * Derive a gauge's status after a calibration: a FAIL leaves it OUT_OF_CAL; a
 * PASS/ADJUSTED whose next due date is already on/before today is DUE; otherwise
 * it returns to service ACTIVE. Pure, so the calibration due-date rule is
 * unit-testable in isolation.
 */
export function deriveGaugeStatus(result: string, dueDate?: string): GaugeStatus {
  if (result === 'FAIL') return 'OUT_OF_CAL';
  if (dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate <= today) return 'DUE';
  }
  return 'ACTIVE';
}
