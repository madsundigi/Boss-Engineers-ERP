import { ItemsService } from '../src/modules/items/items.service';
import { ItemsRepository, DuplicateItemCodeError } from '../src/modules/items/items.repository';
import { RequestContext } from '../src/common/request-context';
import { Item } from '../src/modules/items/items.types';
import { CreateItemDto } from '../src/modules/items/items.dto';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const item = (o: Partial<Item> = {}): Item => ({
  itemId: 7, companyId: 1, itemCode: 'IT-1', itemName: 'Widget', categoryId: 2, type: 'RAW',
  baseUomId: 3, hsnSacId: null, isCritical: false, reorderLevel: null,
  createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});

const newItem: CreateItemDto = { itemCode: 'IT-1', itemName: 'Widget', categoryId: 2, type: 'RAW', baseUomId: 3 };

function make(over: Partial<ItemsRepository> = {}) {
  const repo = {
    create: jest.fn(async () => item()),
    findById: jest.fn(async () => item()),
    list: jest.fn(),
    update: jest.fn(async () => item()),
    softDelete: jest.fn(async () => true),
    ...over,
  } as unknown as ItemsRepository;
  return { svc: new ItemsService(repo), repo };
}

describe('ItemsService', () => {
  it('create delegates to the repository and rounds reorderLevel to 4 dp', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { ...newItem, reorderLevel: 5.123456 });
    expect(repo.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ itemCode: 'IT-1', type: 'RAW', reorderLevel: 5.1235 }),
    );
  });

  it('create maps a duplicate item_code to a 409', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateItemCodeError(); }) });
    await expect(svc.create(ctx, newItem)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('getById throws 404 when missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('list delegates to the repository', async () => {
    const result = { rows: [], total: 0, page: 1, pageSize: 25 };
    const { svc, repo } = make({ list: jest.fn(async () => result) });
    await svc.list(ctx, { page: 1, pageSize: 25, sort: 'item_code', dir: 'asc' });
    expect(repo.list).toHaveBeenCalled();
  });

  it('update rejects an empty patch (only rowVersion) with 400', async () => {
    const { svc, repo } = make();
    await expect(svc.update(ctx, 7, { rowVersion: 1 })).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('update 404s when the item does not exist', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { itemName: 'X', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { itemName: 'X', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('update passes mutable fields through to the repository', async () => {
    const { svc, repo } = make();
    await svc.update(ctx, 7, { itemName: 'Widget v2', isCritical: true, rowVersion: 1 });
    expect(repo.update).toHaveBeenCalledWith(ctx, 7, 1,
      expect.objectContaining({ itemName: 'Widget v2', isCritical: true }));
  });

  it('delete 404s when the item does not exist', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.delete(ctx, 7, 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ softDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 7, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete succeeds (soft) when the row version matches', async () => {
    const { svc, repo } = make();
    await svc.delete(ctx, 7, 1);
    expect(repo.softDelete).toHaveBeenCalledWith(ctx, 7, 1);
  });
});
