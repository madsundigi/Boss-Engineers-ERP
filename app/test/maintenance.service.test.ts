import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';
import { MaintenanceRepository } from '../src/modules/maintenance/maintenance.repository';
import { RequestContext } from '../src/common/request-context';
import { Asset, WorkOrder } from '../src/modules/maintenance/maintenance.types';
import { WoStatus } from '../src/modules/maintenance/maintenance.constants';
import { OutboxEventInput } from '../src/outbox/outbox';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const asset = (o: Partial<Asset> = {}): Asset => ({
  assetId: 7, companyId: 1, assetCode: 'CNC-01', assetName: 'CNC Lathe', assetType: 'MACHINE',
  location: 'Shop A', status: 'ACTIVE', createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});
const wo = (o: Partial<WorkOrder> = {}): WorkOrder => ({
  mwoId: 5, companyId: 1, buId: 1, mwoNo: 'MWO/MUM/2026/000001', assetId: 7, woType: 'PREVENTIVE',
  scheduledDate: null, completedDate: null, status: 'OPEN', notes: null,
  createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});

/** setWoStatus options the service passes (asset side-effects + outbox event). */
type WoStatusOpts = {
  assetId?: number; assetStatus?: string; setCompletedDate?: boolean; event?: OutboxEventInput;
};

function make(over: Partial<MaintenanceRepository> = {}) {
  const repo = {
    createAsset: jest.fn(async () => asset()),
    findAssetById: jest.fn(async () => asset()),
    listAssets: jest.fn(),
    updateAsset: jest.fn(async () => asset()),
    setAssetStatus: jest.fn(async () => asset()),
    softDeleteAsset: jest.fn(async () => true),
    createWo: jest.fn(async () => wo()),
    findWoById: jest.fn(async () => wo()),
    listWo: jest.fn(),
    updateWo: jest.fn(async () => wo()),
    setWoStatus: jest.fn(async () => wo()),
    softDeleteWo: jest.fn(async () => true),
    ...over,
  } as unknown as MaintenanceRepository;
  return { svc: new MaintenanceService(repo), repo };
}

describe('MaintenanceService', () => {
  // --- Assets ---
  it('createAsset delegates to the repository', async () => {
    const { svc, repo } = make();
    await svc.createAsset(ctx, { assetCode: 'CNC-01', assetName: 'CNC Lathe' });
    expect(repo.createAsset).toHaveBeenCalled();
  });

  it('getAsset throws 404 when the asset is missing', async () => {
    const { svc } = make({ findAssetById: jest.fn(async () => null) });
    await expect(svc.getAsset(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updateAsset returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ updateAsset: jest.fn(async () => null) });
    await expect(svc.updateAsset(ctx, 7, { assetName: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  // --- Work-order create ---
  it('createWo requires a branch (no buId -> 400)', async () => {
    const { svc, repo } = make();
    await expect(svc.createWo({ ...ctx, buId: null }, { assetId: 7, woType: 'PREVENTIVE' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(repo.createWo).not.toHaveBeenCalled();
  });

  it('createWo 404s when the target asset is missing', async () => {
    const { svc } = make({ findAssetById: jest.fn(async () => null) });
    await expect(svc.createWo(ctx, { assetId: 7, woType: 'BREAKDOWN' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('createWo delegates to the repository when the asset exists and a branch is set', async () => {
    const { svc, repo } = make();
    await svc.createWo(ctx, { assetId: 7, woType: 'PREVENTIVE' });
    expect(repo.createWo).toHaveBeenCalled();
  });

  // --- Work-order lifecycle guards ---
  it('getWo throws 404 when the work order is missing', async () => {
    const { svc } = make({ findWoById: jest.fn(async () => null) });
    await expect(svc.getWo(ctx, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('startWo OPEN->IN_PROGRESS sets the asset UNDER_MAINTENANCE', async () => {
    let opts: WoStatusOpts | undefined;
    const { svc } = make({
      findWoById: jest.fn(async () => wo({ status: 'OPEN' })),
      setWoStatus: jest.fn(async (_c, _i, _v, _s: WoStatus, o?: WoStatusOpts) => {
        opts = o; return wo({ status: 'IN_PROGRESS' });
      }) as unknown as MaintenanceRepository['setWoStatus'],
    });
    const res = await svc.startWo(ctx, 5, 1);
    expect(res.status).toBe('IN_PROGRESS');
    expect(opts).toMatchObject({ assetId: 7, assetStatus: 'UNDER_MAINTENANCE' });
  });

  it('startWo from a non-OPEN status is rejected (409)', async () => {
    const { svc } = make({ findWoById: jest.fn(async () => wo({ status: 'IN_PROGRESS' })) });
    await expect(svc.startWo(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('completeWo IN_PROGRESS->DONE returns the asset to ACTIVE and emits maintenance.completed', async () => {
    let opts: WoStatusOpts | undefined;
    const { svc } = make({
      findWoById: jest.fn(async () => wo({ status: 'IN_PROGRESS' })),
      setWoStatus: jest.fn(async (_c, _i, _v, _s: WoStatus, o?: WoStatusOpts) => {
        opts = o; return wo({ status: 'DONE', completedDate: '2026-06-08' });
      }) as unknown as MaintenanceRepository['setWoStatus'],
    });
    const res = await svc.completeWo(ctx, 5, 1);
    expect(res.status).toBe('DONE');
    expect(opts).toMatchObject({ assetId: 7, assetStatus: 'ACTIVE', setCompletedDate: true });
    expect(opts?.event?.eventType).toBe('maintenance.completed');
    expect(opts?.event?.payload).toMatchObject({
      mwoNo: 'MWO/MUM/2026/000001', assetId: 7, woType: 'PREVENTIVE',
    });
  });

  it('completeWo from a non-IN_PROGRESS status is rejected (409)', async () => {
    const { svc } = make({ findWoById: jest.fn(async () => wo({ status: 'OPEN' })) });
    await expect(svc.completeWo(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('completeWo returns 409 on a row-version mismatch', async () => {
    const { svc } = make({
      findWoById: jest.fn(async () => wo({ status: 'IN_PROGRESS' })),
      setWoStatus: jest.fn(async () => null),
    });
    await expect(svc.completeWo(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('cancelWo from a terminal status is rejected (409)', async () => {
    const { svc } = make({ findWoById: jest.fn(async () => wo({ status: 'DONE' })) });
    await expect(svc.cancelWo(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('updateWo is blocked on a terminal work order (409)', async () => {
    const { svc } = make({ findWoById: jest.fn(async () => wo({ status: 'CANCELLED' })) });
    await expect(svc.updateWo(ctx, 5, { notes: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
