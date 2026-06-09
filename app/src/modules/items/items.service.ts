import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ItemsRepository, DuplicateItemCodeError } from './items.repository';
import { Item, ItemListResult } from './items.types';
import { CreateItemDto, UpdateItemDto, ListQueryDto } from './items.dto';

/** reorder_level is numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * ItemsService — item (material/product) master-data business logic. Stateless;
 * depends only on the injected repository so it is unit-testable without a
 * database. The catalog is soft-delete only; item_code is immutable once created.
 */
export class ItemsService {
  constructor(private readonly repo: ItemsRepository) {}

  async create(ctx: RequestContext, dto: CreateItemDto): Promise<Item> {
    try {
      return await this.repo.create(ctx, {
        itemCode: dto.itemCode,
        itemName: dto.itemName,
        categoryId: dto.categoryId,
        type: dto.type,
        baseUomId: dto.baseUomId,
        hsnSacId: dto.hsnSacId,
        reorderLevel: dto.reorderLevel != null ? round4(dto.reorderLevel) : undefined,
        isCritical: dto.isCritical,
      });
    } catch (e) {
      if (e instanceof DuplicateItemCodeError) {
        throw Errors.conflict(`An item with code '${dto.itemCode}' already exists`);
      }
      throw e;
    }
  }

  async getById(ctx: RequestContext, id: number): Promise<Item> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Item ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<ItemListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateItemDto): Promise<Item> {
    const { rowVersion, ...rest } = dto;
    if (Object.keys(rest).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing
    const fields = {
      itemName: rest.itemName,
      categoryId: rest.categoryId,
      type: rest.type,
      baseUomId: rest.baseUomId,
      hsnSacId: rest.hsnSacId,
      reorderLevel: rest.reorderLevel != null ? round4(rest.reorderLevel) : undefined,
      isCritical: rest.isCritical,
    };
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Item was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Soft delete under optimistic concurrency. */
  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Item was modified by someone else (row version mismatch)');
  }
}
