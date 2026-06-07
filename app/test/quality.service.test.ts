import { QualityService, deriveGaugeStatus } from '../src/modules/quality/quality.service';
import { QualityRepository } from '../src/modules/quality/quality.repository';
import { RequestContext } from '../src/common/request-context';
import { Inspection, Gauge } from '../src/modules/quality/quality.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 10, username: 'qc', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function inspection(over: Partial<Inspection> = {}): Inspection {
  return {
    inspectionId: 30, inspNo: 'INSP/MUM/2026-27/000030', companyId: 1, buId: 1,
    inspType: 'INCOMING', sourceDocType: 'GRN', grnId: 500, woId: null,
    itemId: 70, projectId: 100, inspDate: '2026-06-07', status: 'PENDING', result: null,
    inspectedBy: 10, createdAt: 't', createdBy: 10, updatedAt: 't', rowVersion: 1,
    lines: [{ inspLineId: 1, itemId: 70, parameter: 'OD', sampleQty: 5, acceptedQty: null, rejectedQty: null, result: null }],
    ...over,
  };
}

function gauge(over: Partial<Gauge> = {}): Gauge {
  return {
    gaugeId: 40, companyId: 1, gaugeCode: 'VC-001', gaugeName: 'Vernier Caliper',
    gaugeType: 'CALIPER', location: 'QC Lab', lastCalDate: null, nextCalDue: null,
    status: 'ACTIVE', createdAt: 't', createdBy: 10, updatedAt: 't', rowVersion: 1, ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    recordResults: jest.fn(),
    softDelete: jest.fn(),
    createGauge: jest.fn(),
    findGaugeById: jest.fn(),
    listGauges: jest.fn(),
    recordCalibration: jest.fn(),
    gaugeHistory: jest.fn(),
  } as unknown as jest.Mocked<QualityRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('QualityService', () => {
  let repo: jest.Mocked<QualityRepository>;
  let service: QualityService;
  beforeEach(() => { repo = makeRepo(); service = new QualityService(repo); });

  describe('create', () => {
    it('creates an inspection in PENDING with branch context', async () => {
      const created = inspection();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, {
        inspType: 'INCOMING', sourceDocType: 'GRN', grnId: 500, itemId: 70, projectId: 100,
        lines: [{ itemId: 70, parameter: 'OD', sampleQty: 5 }],
      });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ inspType: 'INCOMING', sourceDocType: 'GRN', grnId: 500 }),
        [expect.objectContaining({ itemId: 70, parameter: 'OD', sampleQty: 5, result: null })],
      );
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, {
        inspType: 'INCOMING', lines: [{ itemId: 70 }],
      }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('recordResults', () => {
    it('records a PASS (PENDING -> PASS) without emitting an event', async () => {
      repo.findById.mockResolvedValue(inspection());
      repo.recordResults.mockResolvedValue(inspection({ status: 'PASS', result: 'PASS', rowVersion: 2 }));
      const out = await service.recordResults(ctx, 30, {
        result: 'PASS', lines: [{ inspLineId: 1, acceptedQty: 5, result: 'PASS' }], rowVersion: 1,
      });
      expect(out.status).toBe('PASS');
      const eventArg = repo.recordResults.mock.calls[0][6];
      expect(eventArg).toBeUndefined();
    });

    it('records a PARTIAL (PENDING -> PARTIAL) without an event', async () => {
      repo.findById.mockResolvedValue(inspection());
      repo.recordResults.mockResolvedValue(inspection({ status: 'PARTIAL', result: 'PARTIAL', rowVersion: 2 }));
      const out = await service.recordResults(ctx, 30, {
        result: 'PARTIAL', lines: [{ inspLineId: 1, acceptedQty: 3, rejectedQty: 2, result: 'PARTIAL' }], rowVersion: 1,
      });
      expect(out.status).toBe('PARTIAL');
      expect(repo.recordResults.mock.calls[0][6]).toBeUndefined();
    });

    it('emits inspection.failed when the overall result is FAIL', async () => {
      repo.findById.mockResolvedValue(inspection());
      repo.recordResults.mockResolvedValue(inspection({ status: 'FAIL', result: 'FAIL', rowVersion: 2 }));
      const out = await service.recordResults(ctx, 30, {
        result: 'FAIL', lines: [{ inspLineId: 1, rejectedQty: 5, result: 'FAIL' }], rowVersion: 1,
      });
      expect(out.status).toBe('FAIL');
      const [, , version, status, result, , eventArg] = repo.recordResults.mock.calls[0];
      expect(version).toBe(1);
      expect(status).toBe('FAIL');
      expect(result).toBe('FAIL');
      expect(eventArg).toMatchObject({
        eventType: 'inspection.failed', aggregateType: 'INSPECTION', aggregateId: 30,
        companyId: 1,
      });
      expect((eventArg as { payload: Record<string, unknown> }).payload).toMatchObject({
        inspNo: 'INSP/MUM/2026-27/000030', sourceDocType: 'GRN', itemId: 70, projectId: 100,
      });
    });

    it('409 when recording results on a non-PENDING inspection', async () => {
      repo.findById.mockResolvedValue(inspection({ status: 'PASS', result: 'PASS' }));
      await expect(code(service.recordResults(ctx, 30, {
        result: 'FAIL', lines: [{ inspLineId: 1, result: 'FAIL' }], rowVersion: 1,
      }))).resolves.toBe(409);
      expect(repo.recordResults).not.toHaveBeenCalled();
    });

    it('404 when the inspection does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.recordResults(ctx, 99, {
        result: 'PASS', lines: [{ inspLineId: 1, result: 'PASS' }], rowVersion: 1,
      }))).resolves.toBe(404);
    });

    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(inspection());
      repo.recordResults.mockResolvedValue(null);
      await expect(code(service.recordResults(ctx, 30, {
        result: 'PASS', lines: [{ inspLineId: 1, result: 'PASS' }], rowVersion: 1,
      }))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless PENDING', async () => {
      repo.findById.mockResolvedValue(inspection({ status: 'FAIL', result: 'FAIL' }));
      await expect(code(service.delete(ctx, 30))).resolves.toBe(409);
    });
    it('soft-deletes a PENDING inspection', async () => {
      repo.findById.mockResolvedValue(inspection());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
  });

  describe('calibration', () => {
    it('registers a gauge', async () => {
      const g = gauge();
      repo.createGauge.mockResolvedValue(g);
      const out = await service.registerGauge(ctx, {
        gaugeCode: 'VC-001', gaugeName: 'Vernier Caliper', gaugeType: 'CALIPER', status: 'ACTIVE',
      });
      expect(out).toBe(g);
      expect(repo.createGauge).toHaveBeenCalledWith(ctx, expect.objectContaining({ gaugeCode: 'VC-001' }));
    });

    it('404 when recording a calibration against an unknown gauge', async () => {
      repo.findGaugeById.mockResolvedValue(null);
      await expect(code(service.recordCalibration(ctx, 99, {
        calDate: '2026-06-07', result: 'PASS',
      }))).resolves.toBe(404);
      expect(repo.recordCalibration).not.toHaveBeenCalled();
    });

    it('records a calibration and advances the gauge dates', async () => {
      repo.findGaugeById.mockResolvedValue(gauge());
      const refreshed = gauge({ lastCalDate: '2026-06-07', nextCalDue: '2027-06-07', rowVersion: 2 });
      repo.recordCalibration.mockResolvedValue({
        gauge: refreshed,
        record: { calId: 1, gaugeId: 40, calDate: '2026-06-07', dueDate: '2027-06-07', result: 'PASS', certificateNo: 'CERT-1', calibratedBy: 10, createdAt: 't' },
      });
      const out = await service.recordCalibration(ctx, 40, {
        calDate: '2026-06-07', dueDate: '2027-06-07', result: 'PASS', certificateNo: 'CERT-1',
      });
      expect(out.gauge.nextCalDue).toBe('2027-06-07');
      // a future due date on a passed cal returns the gauge to ACTIVE
      const [, , , statusArg] = repo.recordCalibration.mock.calls[0];
      expect(statusArg).toBe('ACTIVE');
    });
  });

  // Pure calibration due-date logic, tested in isolation.
  describe('deriveGaugeStatus (calibration due-date logic)', () => {
    it('a FAIL leaves the gauge OUT_OF_CAL regardless of due date', () => {
      expect(deriveGaugeStatus('FAIL', '2099-01-01')).toBe('OUT_OF_CAL');
    });
    it('a PASS with a future due date is ACTIVE', () => {
      expect(deriveGaugeStatus('PASS', '2099-01-01')).toBe('ACTIVE');
    });
    it('a PASS with a past due date is immediately DUE', () => {
      expect(deriveGaugeStatus('PASS', '2000-01-01')).toBe('DUE');
    });
    it('a PASS with no due date is ACTIVE', () => {
      expect(deriveGaugeStatus('ADJUSTED')).toBe('ACTIVE');
    });
  });
});
