import { WorkCentersService } from '../src/modules/workcenters/workcenters.service';
import {
  WorkCentersRepository, DuplicateWorkCenterCodeError, WorkCenterInUseError,
} from '../src/modules/workcenters/workcenters.repository';
import { RequestContext } from '../src/common/request-context';
import { WorkCenter } from '../src/modules/workcenters/workcenters.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const wc = (o: Partial<WorkCenter> = {}): WorkCenter => ({
  wcId: 3, buId: 1, companyId: 1, wcCode: 'WC-01', wcName: 'CNC Bay',
  capacityPerDay: 8, costRate: 1200, isActive: true, ...o,
});

function make(over: Partial<WorkCentersRepository> = {}) {
  const repo = {
    buBelongsToCompany: jest.fn(async () => true),
    create: jest.fn(async () => wc()),
    findById: jest.fn(async () => wc()),
    list: jest.fn(),
    update: jest.fn(async () => wc()),
    delete: jest.fn(async () => true),
    ...over,
  } as unknown as WorkCentersRepository;
  return { svc: new WorkCentersService(repo), repo };
}

describe('WorkCentersService', () => {
  it('create delegates to the repository when the BU is in-tenant', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { buId: 1, wcCode: 'WC-01', wcName: 'CNC Bay' });
    expect(repo.buBelongsToCompany).toHaveBeenCalledWith(ctx, 1);
    expect(repo.create).toHaveBeenCalled();
  });

  it('create rejects a BU that does not belong to the company (400)', async () => {
    const { svc, repo } = make({ buBelongsToCompany: jest.fn(async () => false) });
    await expect(svc.create(ctx, { buId: 999, wcCode: 'WC-01', wcName: 'CNC Bay' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create maps a duplicate wc_code to a 409 conflict', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateWorkCenterCodeError(); }) });
    await expect(svc.create(ctx, { buId: 1, wcCode: 'WC-01', wcName: 'CNC Bay' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when the work centre is missing / cross-tenant', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 3)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update rejects an empty patch (400)', async () => {
    const { svc } = make();
    await expect(svc.update(ctx, 3, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update validates a moved buId against the tenant (400)', async () => {
    const { svc, repo } = make({
      buBelongsToCompany: jest.fn(async () => false),
    });
    await expect(svc.update(ctx, 3, { buId: 999 })).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('update 404s when the work centre is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.update(ctx, 3, { wcName: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete removes the work centre (hard delete)', async () => {
    const { svc, repo } = make();
    await svc.delete(ctx, 3);
    expect(repo.delete).toHaveBeenCalledWith(ctx, 3);
  });

  it('delete maps a FK reference to a 409 conflict (still used by routings / WOs)', async () => {
    const { svc } = make({ delete: jest.fn(async () => { throw new WorkCenterInUseError(); }) });
    await expect(svc.delete(ctx, 3)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete 404s when the work centre is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.delete(ctx, 3)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('list delegates to the repository', async () => {
    const result = { rows: [wc()], total: 1, page: 1, pageSize: 25 };
    const { svc, repo } = make({ list: jest.fn(async () => result) });
    const res = await svc.list(ctx, { page: 1, pageSize: 25, sort: 'wc_code', dir: 'asc' });
    expect(repo.list).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(res.total).toBe(1);
  });
});
