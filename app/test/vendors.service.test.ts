import { VendorsService } from '../src/modules/vendors/vendors.service';
import { VendorsRepository, DuplicateVendorCodeError } from '../src/modules/vendors/vendors.repository';
import { RequestContext } from '../src/common/request-context';
import { Vendor } from '../src/modules/vendors/vendors.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const vendor = (o: Partial<Vendor> = {}): Vendor => ({
  vendorId: 7, companyId: 1, vendorCode: 'V-001', vendorName: 'Acme Pvt Ltd', gstin: null,
  pan: null, msmeFlag: false, isApproved: false, paymentTermId: null, rating: null,
  status: 'ACTIVE', createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});

function make(over: Partial<VendorsRepository> = {}) {
  const repo = {
    create: jest.fn(async () => vendor()),
    findById: jest.fn(async () => vendor()),
    list: jest.fn(async () => ({ rows: [vendor()], total: 1, page: 1, pageSize: 25 })),
    update: jest.fn(async () => vendor({ rowVersion: 2 })),
    softDelete: jest.fn(async () => true),
    ...over,
  } as unknown as VendorsRepository;
  return { svc: new VendorsService(repo), repo };
}

describe('VendorsService', () => {
  it('create delegates to the repository', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { vendorCode: 'V-001', vendorName: 'Acme Pvt Ltd' });
    expect(repo.create).toHaveBeenCalled();
  });

  it('create maps a duplicate vendor_code to a 409 conflict', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateVendorCodeError(); }) });
    await expect(svc.create(ctx, { vendorCode: 'V-001', vendorName: 'Acme Pvt Ltd' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when the vendor is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('list delegates to the repository', async () => {
    const { svc, repo } = make();
    const res = await svc.list(ctx, { page: 1, pageSize: 25, sort: 'vendor_code', dir: 'asc' });
    expect(repo.list).toHaveBeenCalled();
    expect(res.total).toBe(1);
  });

  it('update bumps a vendor under optimistic concurrency', async () => {
    const { svc, repo } = make();
    const res = await svc.update(ctx, 7, { vendorName: 'Acme Renamed', rowVersion: 1 });
    expect(repo.update).toHaveBeenCalledWith(ctx, 7, 1, expect.objectContaining({ vendorName: 'Acme Renamed' }));
    expect(res.rowVersion).toBe(2);
  });

  it('update rejects an empty change set (400)', async () => {
    const { svc } = make();
    await expect(svc.update(ctx, 7, { rowVersion: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { vendorName: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete soft-deletes under optimistic concurrency', async () => {
    const { svc, repo } = make();
    await svc.delete(ctx, 7, 1);
    expect(repo.softDelete).toHaveBeenCalledWith(ctx, 7, 1);
  });

  it('delete returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ softDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 7, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
