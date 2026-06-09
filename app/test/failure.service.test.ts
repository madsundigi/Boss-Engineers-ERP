import { FailureService } from '../src/modules/failure/failure.service';
import { FailureRepository } from '../src/modules/failure/failure.repository';
import { RequestContext } from '../src/common/request-context';
import { Ncr, Capa } from '../src/modules/failure/failure.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'qc', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function capa(over: Partial<Capa> = {}): Capa {
  return {
    capaId: 30, capaType: 'CORRECTIVE', action: 'Replace seal',
    ownerId: null, dueDate: null, effectivenessCheck: null, status: 'OPEN',
    actions: [], ...over,
  };
}

function ncr(over: Partial<Ncr> = {}): Ncr {
  return {
    ncrId: 10, ncrNo: 'NCR/MUM/2026-27/000010', companyId: 1, buId: 1,
    source: 'PRODUCTION', sourceDocId: null, itemId: null, projectId: 100,
    failureModeId: null, severity: null, raisedDate: '2026-06-07',
    status: 'OPEN', createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    rca: [], capa: [], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    paretoCounts: jest.fn(),
    addRca: jest.fn(),
    addCapa: jest.fn(),
    addCapaAction: jest.fn(),
    updateCapaStatus: jest.fn(),
    close: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<FailureRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('FailureService', () => {
  let repo: jest.Mocked<FailureRepository>;
  let service: FailureService;
  beforeEach(() => { repo = makeRepo(); service = new FailureService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults OPEN, no event)', async () => {
      const created = ncr();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { source: 'PRODUCTION' });
      expect(out).toBe(created);
      expect(out.status).toBe('OPEN');
      expect(repo.create).toHaveBeenCalledWith(
        ctx, expect.objectContaining({ source: 'PRODUCTION' }),
      );
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { source: 'PRODUCTION' }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('pareto — repeat-failure report math', () => {
    it('computes pct + a running cumulativePct, preserves count-DESC order, flags repeats', async () => {
      // Repo returns rows already ordered count DESC (its ORDER BY). total = 10.
      repo.paretoCounts.mockResolvedValue([
        { key: 1, label: 'Weld crack', count: 5 },
        { key: 2, label: 'Seal leak', count: 3 },
        { key: null, label: '', count: 2 }, // unclassified bucket
      ]);
      const out = await service.pareto(ctx, { by: 'mode' });

      expect(out.by).toBe('mode');
      expect(out.total).toBe(10);
      // ordering preserved exactly as the repo handed them over
      expect(out.rows.map((r) => r.failureModeId)).toEqual([1, 2, null]);
      // pct = count/total*100
      expect(out.rows.map((r) => r.pct)).toEqual([50, 30, 20]);
      // cumulativePct is the running share and ends at exactly 100
      expect(out.rows.map((r) => r.cumulativePct)).toEqual([50, 80, 100]);
      // count >= 2 is a repeat failure (all three here)
      expect(out.rows.map((r) => r.isRepeat)).toEqual([true, true, true]);
      // NULL failure mode is bucketed as 'Unclassified'
      expect(out.rows[2].failureMode).toBe('Unclassified');
      expect(out.rows[0].failureMode).toBe('Weld crack');
    });

    it('marks a count of 1 as NOT a repeat and rounds pct/cumulative to 2dp', async () => {
      // total = 3 -> shares are 66.666.. / 33.333.. ; assert 2dp rounding + repeat flag.
      repo.paretoCounts.mockResolvedValue([
        { key: 7, label: 'Bearing wear', count: 2 },
        { key: 8, label: 'Paint defect', count: 1 },
      ]);
      const out = await service.pareto(ctx, { by: 'mode' });
      expect(out.total).toBe(3);
      expect(out.rows[0]).toMatchObject({ count: 2, pct: 66.67, cumulativePct: 66.67, isRepeat: true });
      expect(out.rows[1]).toMatchObject({ count: 1, pct: 33.33, cumulativePct: 100, isRepeat: false });
    });

    it('returns { total: 0, rows: [] } for an empty company (no divide-by-zero)', async () => {
      repo.paretoCounts.mockResolvedValue([]);
      const out = await service.pareto(ctx, { by: 'mode' });
      expect(out).toEqual({ by: 'mode', total: 0, rows: [] });
    });

    it('passes the chosen dimension through to the repo and echoes it', async () => {
      repo.paretoCounts.mockResolvedValue([{ key: 'FAT', label: 'FAT', count: 1 }]);
      const out = await service.pareto(ctx, { by: 'source' });
      expect(repo.paretoCounts).toHaveBeenCalledWith(ctx, { by: 'source' });
      expect(out.by).toBe('source');
      expect(out.rows[0]).toMatchObject({ failureModeId: 'FAT', failureMode: 'FAT' });
    });
  });

  describe('addRca', () => {
    it('advances OPEN -> RCA when the first analysis is recorded', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'OPEN' }));
      repo.addRca.mockResolvedValue(ncr({ status: 'RCA', rowVersion: 2 }));
      const out = await service.addRca(ctx, 10, { method: '5WHY', rowVersion: 1 });
      expect(out.status).toBe('RCA');
      // advanceTo argument is the new status when coming from OPEN
      expect(repo.addRca.mock.calls[0][4]).toBe('RCA');
    });
    it('records a later analysis without changing status (no advance)', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA' }));
      repo.addRca.mockResolvedValue(ncr({ status: 'CAPA', rowVersion: 3 }));
      await service.addRca(ctx, 10, { method: '8D', rowVersion: 2 });
      expect(repo.addRca.mock.calls[0][4]).toBeUndefined();
    });
    it('409 on a CLOSED NCR', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CLOSED' }));
      await expect(code(service.addRca(ctx, 10, { method: '5WHY', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.addRca).not.toHaveBeenCalled();
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'RCA' }));
      repo.addRca.mockResolvedValue(null);
      await expect(code(service.addRca(ctx, 10, { method: '5WHY', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('addCapa', () => {
    it('advances RCA -> CAPA when the first action is recorded', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'RCA' }));
      repo.addCapa.mockResolvedValue(ncr({ status: 'CAPA', rowVersion: 3 }));
      const out = await service.addCapa(ctx, 10, { capaType: 'CORRECTIVE', action: 'Replace seal', rowVersion: 2 });
      expect(out.status).toBe('CAPA');
      expect(repo.addCapa.mock.calls[0][4]).toBe('CAPA');
    });
    it('409 when still OPEN (RCA required before CAPA)', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'OPEN' }));
      await expect(code(service.addCapa(ctx, 10, { capaType: 'CORRECTIVE', action: 'x', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.addCapa).not.toHaveBeenCalled();
    });
    it('409 on a CLOSED NCR', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CLOSED' }));
      await expect(code(service.addCapa(ctx, 10, { capaType: 'PREVENTIVE', action: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('addCapaAction / updateCapaStatus', () => {
    it('404 when the CAPA is not under the NCR', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA' }));
      repo.addCapaAction.mockResolvedValue(null);
      await expect(code(service.addCapaAction(ctx, 10, 999, { description: 'step' }))).resolves.toBe(404);
    });
    it('409 adding an action while not in CAPA', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'RCA' }));
      await expect(code(service.addCapaAction(ctx, 10, 30, { description: 'step' }))).resolves.toBe(409);
      expect(repo.addCapaAction).not.toHaveBeenCalled();
    });
    it('progresses a CAPA to VERIFIED', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA', capa: [capa()] }));
      repo.updateCapaStatus.mockResolvedValue(capa({ status: 'VERIFIED' }));
      const out = await service.updateCapaStatus(ctx, 10, 30, { status: 'VERIFIED' });
      expect(out.status).toBe('VERIFIED');
    });
  });

  describe('close — the verification gate', () => {
    it('409 from the wrong status (still OPEN)', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'OPEN' }));
      await expect(code(service.close(ctx, 10, 1))).resolves.toBe(409);
      expect(repo.close).not.toHaveBeenCalled();
    });
    it('409 from RCA (only CAPA can be closed)', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'RCA' }));
      await expect(code(service.close(ctx, 10, 1))).resolves.toBe(409);
    });
    it('409 when no CAPA is recorded', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA', capa: [] }));
      await expect(code(service.close(ctx, 10, 1))).resolves.toBe(409);
      expect(repo.close).not.toHaveBeenCalled();
    });
    it('409 when not every CAPA is VERIFIED/CLOSED', async () => {
      repo.findById.mockResolvedValue(ncr({
        status: 'CAPA', capa: [capa({ capaId: 30, status: 'VERIFIED' }), capa({ capaId: 31, status: 'OPEN' })],
      }));
      await expect(code(service.close(ctx, 10, 1))).resolves.toBe(409);
      expect(repo.close).not.toHaveBeenCalled();
    });
    it('closes once every CAPA is settled and emits ncr.closed via the repo', async () => {
      repo.findById.mockResolvedValue(ncr({
        status: 'CAPA', capa: [capa({ capaId: 30, status: 'VERIFIED' }), capa({ capaId: 31, status: 'CLOSED' })],
      }));
      repo.close.mockResolvedValue(ncr({ status: 'CLOSED', rowVersion: 5 }));
      const out = await service.close(ctx, 10, 4);
      expect(out.status).toBe('CLOSED');
      const eventArg = repo.close.mock.calls[0][3];
      expect(eventArg).toMatchObject({
        eventType: 'ncr.closed', aggregateType: 'NCR', aggregateId: 10,
      });
      expect((eventArg as { payload: Record<string, unknown> }).payload).toMatchObject({
        ncrNo: 'NCR/MUM/2026-27/000010', source: 'PRODUCTION', projectId: 100,
      });
    });
    it('409 on a stale row version even when settled', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA', capa: [capa({ status: 'VERIFIED' })] }));
      repo.close.mockResolvedValue(null);
      await expect(code(service.close(ctx, 10, 1))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless OPEN', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'CAPA' }));
      await expect(code(service.delete(ctx, 10))).resolves.toBe(409);
    });
    it('soft-deletes an OPEN NCR', async () => {
      repo.findById.mockResolvedValue(ncr({ status: 'OPEN' }));
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 10);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 10);
    });
  });
});
