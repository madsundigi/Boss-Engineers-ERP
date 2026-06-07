import { BomService } from '../src/modules/bom/bom.service';
import { BomRepository } from '../src/modules/bom/bom.repository';
import { RequestContext } from '../src/common/request-context';
import { BomHeader, BomLine } from '../src/modules/bom/bom.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'planning', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

const line = (over: Partial<BomLine> = {}): BomLine => ({
  componentItemId: 7, qtyPer: 2, uomId: 3, scrapPct: 0, isCritical: false, ...over,
});

function bom(over: Partial<BomHeader> = {}): BomHeader {
  return {
    bomId: 20, bomNo: 'BOM/MUM/2026-27/000020', companyId: 1, buId: 1,
    parentItemId: 100, bomType: 'EBOM', revision: 'A', projectId: null,
    status: 'DRAFT', effectiveFrom: null,
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    lines: [line({ bomLineId: 1 })], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<BomRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('BomService', () => {
  let repo: jest.Mocked<BomRepository>;
  let service: BomService;
  beforeEach(() => { repo = makeRepo(); service = new BomService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults DRAFT)', async () => {
      const created = bom();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { parentItemId: 100, bomType: 'EBOM', revision: 'A' });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ parentItemId: 100, bomType: 'EBOM', revision: 'A' }),
        [],
      );
    });
    it('maps lines (defaults scrapPct/isCritical) into the repo call', async () => {
      repo.create.mockResolvedValue(bom());
      await service.create(ctx, {
        parentItemId: 100, bomType: 'MBOM', revision: 'B',
        lines: [{ componentItemId: 7, qtyPer: 2, uomId: 3 }],
      });
      const [, , linesArg] = repo.create.mock.calls[0];
      expect(linesArg).toEqual([{ componentItemId: 7, qtyPer: 2, uomId: 3, scrapPct: 0, isCritical: false }]);
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { parentItemId: 100, bomType: 'EBOM', revision: 'A' })))
        .resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
    it('rejects (400) a duplicate component item within one BOM, before any write', async () => {
      await expect(code(service.create(ctx, {
        parentItemId: 100, bomType: 'EBOM', revision: 'A',
        lines: [{ componentItemId: 7, qtyPer: 1, uomId: 3 }, { componentItemId: 7, qtyPer: 2, uomId: 3 }],
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

  describe('release — DRAFT -> RELEASED, requires >=1 line', () => {
    it('409 when the BOM is not DRAFT (already released)', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'RELEASED' }));
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when the BOM has no component lines', async () => {
      repo.findById.mockResolvedValue(bom({ lines: [] }));
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('releases a DRAFT BOM with lines and emits bom.released', async () => {
      repo.findById.mockResolvedValue(bom());
      repo.updateStatus.mockResolvedValue(bom({ status: 'RELEASED', rowVersion: 2 }));
      const out = await service.release(ctx, 20, 1);
      expect(out.status).toBe('RELEASED');
      const eventArg = repo.updateStatus.mock.calls[0][4];
      expect(eventArg).toMatchObject({
        eventType: 'bom.released', aggregateType: 'BOM', aggregateId: 20,
      });
      expect((eventArg as { payload: Record<string, unknown> }).payload).toMatchObject({
        bomNo: 'BOM/MUM/2026-27/000020', parentItemId: 100, bomType: 'EBOM', revision: 'A',
      });
    });
    it('409 on a stale row version even with lines present', async () => {
      repo.findById.mockResolvedValue(bom());
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
    });
  });

  describe('obsolete — RELEASED -> OBSOLETE', () => {
    it('409 unless RELEASED', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'DRAFT' }));
      await expect(code(service.obsolete(ctx, 20, 1))).resolves.toBe(409);
    });
    it('RELEASED -> OBSOLETE', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'RELEASED' }));
      repo.updateStatus.mockResolvedValue(bom({ status: 'OBSOLETE', rowVersion: 3 }));
      const out = await service.obsolete(ctx, 20, 2);
      expect(out.status).toBe('OBSOLETE');
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'RELEASED' }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.obsolete(ctx, 20, 1))).resolves.toBe(409);
    });
  });

  describe('update', () => {
    it('400 when nothing supplied to update', async () => {
      await expect(code(service.update(ctx, 20, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when not DRAFT', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'RELEASED' }));
      await expect(code(service.update(ctx, 20, { rowVersion: 1, revision: 'B' }))).resolves.toBe(409);
    });
    it('400 on a duplicate component in the replacement lines', async () => {
      repo.findById.mockResolvedValue(bom());
      await expect(code(service.update(ctx, 20, {
        rowVersion: 1,
        lines: [{ componentItemId: 7, qtyPer: 1, uomId: 3 }, { componentItemId: 7, qtyPer: 2, uomId: 3 }],
      }))).resolves.toBe(400);
      expect(repo.update).not.toHaveBeenCalled();
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(bom());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 20, { rowVersion: 1, revision: 'B' }))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless DRAFT', async () => {
      repo.findById.mockResolvedValue(bom({ status: 'RELEASED' }));
      await expect(code(service.delete(ctx, 20))).resolves.toBe(409);
    });
    it('soft-deletes a DRAFT BOM', async () => {
      repo.findById.mockResolvedValue(bom());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 20);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 20);
    });
  });
});
