import { WarehousesService } from '../src/modules/warehouses/warehouses.service';
import {
  WarehousesRepository, DuplicateWarehouseCodeError, BusinessUnitNotFoundError,
  WarehouseInUseError,
} from '../src/modules/warehouses/warehouses.repository';
import { RequestContext } from '../src/common/request-context';
import { Warehouse } from '../src/modules/warehouses/warehouses.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const wh = (o: Partial<Warehouse> = {}): Warehouse => ({
  warehouseId: 3, buId: 1, whCode: 'WH-01', whName: 'Main Store', isActive: true, companyId: 1, ...o,
});

function make(over: Partial<WarehousesRepository> = {}) {
  const repo = {
    create: jest.fn(async () => wh()),
    findById: jest.fn(async () => wh()),
    list: jest.fn(async () => ({ rows: [wh()], total: 1, page: 1, pageSize: 25 })),
    update: jest.fn(async () => wh({ whName: 'Renamed' })),
    hardDelete: jest.fn(async () => true),
    ...over,
  } as unknown as WarehousesRepository;
  return { svc: new WarehousesService(repo), repo };
}

describe('WarehousesService', () => {
  it('create delegates to the repository', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { buId: 1, whCode: 'WH-01', whName: 'Main Store' });
    expect(repo.create).toHaveBeenCalled();
  });

  it('create maps an unknown / out-of-tenant bu_id to a 404', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new BusinessUnitNotFoundError(); }) });
    await expect(svc.create(ctx, { buId: 999, whCode: 'WH-01', whName: 'X' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('create maps a duplicate (bu_id, wh_code) to a 409', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateWarehouseCodeError(); }) });
    await expect(svc.create(ctx, { buId: 1, whCode: 'WH-01', whName: 'X' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when the warehouse is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 3)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('list delegates to the repository', async () => {
    const { svc, repo } = make();
    const res = await svc.list(ctx, { page: 1, pageSize: 25, sort: 'wh_code', dir: 'asc' });
    expect(repo.list).toHaveBeenCalled();
    expect(res.total).toBe(1);
  });

  it('update changes mutable fields (no optimistic concurrency)', async () => {
    const { svc, repo } = make();
    const res = await svc.update(ctx, 3, { whName: 'Renamed' });
    expect(repo.update).toHaveBeenCalledWith(ctx, 3, { whName: 'Renamed', isActive: undefined });
    expect(res.whName).toBe('Renamed');
  });

  it('update rejects an empty change set (400)', async () => {
    const { svc } = make();
    await expect(svc.update(ctx, 3, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('delete hard-deletes the warehouse', async () => {
    const { svc, repo } = make();
    await svc.delete(ctx, 3);
    expect(repo.hardDelete).toHaveBeenCalledWith(ctx, 3);
  });

  it('delete maps an in-use warehouse (FK) to a 409', async () => {
    const { svc } = make({ hardDelete: jest.fn(async () => { throw new WarehouseInUseError(); }) });
    await expect(svc.delete(ctx, 3)).rejects.toMatchObject({ statusCode: 409 });
  });
});
