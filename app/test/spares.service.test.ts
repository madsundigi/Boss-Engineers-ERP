import { SparesService } from '../src/modules/spares/spares.service';
import { SparesRepository, DuplicatePartCodeError } from '../src/modules/spares/spares.repository';
import { RequestContext } from '../src/common/request-context';
import { SparePart, SpareStock, LowStockRow } from '../src/modules/spares/spares.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const part = (o: Partial<SparePart> = {}): SparePart => ({
  spareId: 5, companyId: 1, partCode: 'SP-001', partName: 'Seal Kit', uom: 'NOS', itemId: null,
  unitPrice: 100, reorderLevel: 10, isActive: true, createdAt: '', createdBy: 1, updatedAt: '',
  rowVersion: 1, ...o,
});
const stock = (o: Partial<SpareStock> = {}): SpareStock => ({
  stockId: 1, spareId: 5, location: 'MAIN', qtyOnHand: 0, ...o,
});

function make(over: Partial<SparesRepository> = {}) {
  const repo = {
    create: jest.fn(async () => part()),
    findById: jest.fn(async () => part()),
    findByIdWithStock: jest.fn(async () => part({ stock: [] })),
    list: jest.fn(),
    update: jest.fn(async () => part()),
    setActive: jest.fn(async () => part()),
    softDelete: jest.fn(async () => true),
    totalOnHand: jest.fn(async () => 0),
    stockByPart: jest.fn(async () => [] as SpareStock[]),
    adjustStock: jest.fn(async () => stock()),
    lowStock: jest.fn(async () => [] as LowStockRow[]),
    ...over,
  } as unknown as SparesRepository;
  return { svc: new SparesService(repo), repo };
}

describe('SparesService', () => {
  it('createPart delegates to the repository', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { partCode: 'SP-001', partName: 'Seal Kit' });
    expect(repo.create).toHaveBeenCalled();
  });

  it('createPart maps a duplicate part_code to a 409 conflict', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicatePartCodeError(); }) });
    await expect(svc.create(ctx, { partCode: 'SP-001', partName: 'Seal Kit' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when the spare is missing', async () => {
    const { svc } = make({ findByIdWithStock: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 5, { partName: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('adjustStock adds a positive delta (upsert) and returns the balance', async () => {
    const { svc, repo } = make({ adjustStock: jest.fn(async () => stock({ qtyOnHand: 7 })) });
    const res = await svc.adjustStock(ctx, 5, 'MAIN', 7);
    expect(res.qtyOnHand).toBe(7);
    expect(repo.adjustStock).toHaveBeenCalledWith(ctx, 5, 'MAIN', 7);
  });

  it('adjustStock blocks a delta that would drive the balance negative (400)', async () => {
    const { svc, repo } = make({ stockByPart: jest.fn(async () => [stock({ qtyOnHand: 3 })]) });
    await expect(svc.adjustStock(ctx, 5, 'MAIN', -5)).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.adjustStock).not.toHaveBeenCalled();
  });

  it('adjustStock 404s when the spare does not exist', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.adjustStock(ctx, 5, 'MAIN', 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete is blocked while the spare still holds stock (409)', async () => {
    const { svc } = make({ totalOnHand: jest.fn(async () => 4) });
    await expect(svc.delete(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ softDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lowStock surfaces spares at/below their reorder level', async () => {
    const low: LowStockRow[] = [
      { spareId: 5, partCode: 'SP-001', partName: 'Seal Kit', uom: 'NOS', reorderLevel: 10, totalOnHand: 3 },
    ];
    const { svc, repo } = make({ lowStock: jest.fn(async () => low) });
    const res = await svc.lowStock(ctx);
    expect(repo.lowStock).toHaveBeenCalledWith(ctx);
    expect(res).toHaveLength(1);
    expect(res[0].totalOnHand).toBeLessThanOrEqual(res[0].reorderLevel);
  });
});
