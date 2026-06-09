import { CustomersService } from '../src/modules/customers/customers.service';
import { CustomersRepository, DuplicateCustomerCodeError } from '../src/modules/customers/customers.repository';
import { RequestContext } from '../src/common/request-context';
import { Customer } from '../src/modules/customers/customers.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const customer = (o: Partial<Customer> = {}): Customer => ({
  customerId: 7, companyId: 1, customerCode: 'C-001', customerName: 'Acme Steel',
  customerType: 'OEM', gstin: null, pan: null, creditLimit: 0, paymentTermId: null,
  defaultCurrencyId: 1, status: 'ACTIVE', createdAt: '', createdBy: 1, updatedAt: '',
  rowVersion: 1, ...o,
});

function make(over: Partial<CustomersRepository> = {}) {
  const repo = {
    create: jest.fn(async () => customer()),
    findById: jest.fn(async () => customer()),
    list: jest.fn(),
    update: jest.fn(async () => customer()),
    softDelete: jest.fn(async () => true),
    ...over,
  } as unknown as CustomersRepository;
  return { svc: new CustomersService(repo), repo };
}

describe('CustomersService', () => {
  it('create delegates to the repository with the required currency', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { customerCode: 'C-001', customerName: 'Acme Steel', defaultCurrencyId: 1 });
    expect(repo.create).toHaveBeenCalled();
  });

  it('create maps a duplicate customer_code to a 409 conflict', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateCustomerCodeError(); }) });
    await expect(svc.create(ctx, { customerCode: 'C-001', customerName: 'Acme Steel', defaultCurrencyId: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when the customer is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { customerName: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('update rejects an empty patch (400)', async () => {
    const { svc } = make();
    await expect(svc.update(ctx, 7, { rowVersion: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update 404s when the customer is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { customerName: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ softDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 7, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete 404s when the customer is missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.delete(ctx, 7, 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('list delegates to the repository', async () => {
    const result = { rows: [customer()], total: 1, page: 1, pageSize: 25 };
    const { svc, repo } = make({ list: jest.fn(async () => result) });
    const res = await svc.list(ctx, { page: 1, pageSize: 25, sort: 'customer_code', dir: 'asc' });
    expect(repo.list).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(res.total).toBe(1);
  });
});
