import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { SparesRepository, DuplicatePartCodeError } from './spares.repository';
import { SparePart, SpareStock, SparePartListResult, LowStockRow } from './spares.types';
import { CreatePartDto, UpdatePartDto, ListQueryDto } from './spares.dto';
import { DEFAULT_LOCATION } from './spares.constants';

/** Money / quantity is numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * SparesService — spare-part catalog + per-location service-inventory business logic.
 * Stateless; depends only on the injected repository so it is unit-testable without a
 * database. The catalog is soft-delete only; stock is adjusted by a signed delta that
 * may never drive a location's balance negative.
 */
export class SparesService {
  constructor(private readonly repo: SparesRepository) {}

  async create(ctx: RequestContext, dto: CreatePartDto): Promise<SparePart> {
    try {
      return await this.repo.create(ctx, {
        partCode: dto.partCode,
        partName: dto.partName,
        uom: dto.uom,
        itemId: dto.itemId,
        unitPrice: dto.unitPrice != null ? round4(dto.unitPrice) : undefined,
        reorderLevel: dto.reorderLevel != null ? round4(dto.reorderLevel) : undefined,
        isActive: dto.isActive,
      });
    } catch (e) {
      if (e instanceof DuplicatePartCodeError) {
        throw Errors.conflict(`A spare with part code '${dto.partCode}' already exists`);
      }
      throw e;
    }
  }

  /** Header + per-location stock; 404 if missing. */
  async getById(ctx: RequestContext, id: number): Promise<SparePart> {
    const row = await this.repo.findByIdWithStock(ctx, id);
    if (!row) throw Errors.notFound(`Spare ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<SparePartListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdatePartDto): Promise<SparePart> {
    const { rowVersion, ...rest } = dto;
    if (Object.keys(rest).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing
    const fields = {
      partName: rest.partName,
      uom: rest.uom,
      itemId: rest.itemId,
      unitPrice: rest.unitPrice != null ? round4(rest.unitPrice) : undefined,
      reorderLevel: rest.reorderLevel != null ? round4(rest.reorderLevel) : undefined,
    };
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Spare was modified by someone else (row version mismatch)');
    return updated;
  }

  async setActive(ctx: RequestContext, id: number, rowVersion: number, isActive: boolean): Promise<SparePart> {
    await this.getById(ctx, id); // 404 if missing
    const updated = await this.repo.setActive(ctx, id, rowVersion, isActive);
    if (!updated) throw Errors.conflict('Spare was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Soft delete — only allowed when the spare holds no stock anywhere. */
  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    const onHand = await this.repo.totalOnHand(ctx, id);
    if (onHand > 0) {
      throw Errors.conflict(`Cannot delete a spare that still holds stock (on hand: ${onHand})`);
    }
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Spare was modified by someone else (row version mismatch)');
  }

  /**
   * Adjust on-hand at a location by a signed delta (positive receipt / negative
   * issue). Loads the current balance, blocks any move that would drive it below
   * zero (400), then upserts. 404 if the spare does not exist in this tenant.
   */
  async adjustStock(ctx: RequestContext, spareId: number, location: string | undefined, delta: number): Promise<SpareStock> {
    const loc = location ?? DEFAULT_LOCATION;
    const spare = await this.repo.findById(ctx, spareId);
    if (!spare) throw Errors.notFound(`Spare ${spareId} not found`);
    if (delta < 0) {
      const current = (await this.repo.stockByPart(ctx, spareId))
        .find((s) => s.location === loc)?.qtyOnHand ?? 0;
      if (current + delta < 0) {
        throw Errors.badRequest(
          `Adjustment would drive ${loc} negative (on hand ${current}, delta ${delta})`);
      }
    }
    const row = await this.repo.adjustStock(ctx, spareId, loc, round4(delta));
    if (!row) throw Errors.notFound(`Spare ${spareId} not found`);
    return row;
  }

  /** Per-location stock for a spare; 404 if the spare is missing. */
  async stockByPart(ctx: RequestContext, spareId: number): Promise<SpareStock[]> {
    const spare = await this.repo.findById(ctx, spareId);
    if (!spare) throw Errors.notFound(`Spare ${spareId} not found`);
    return this.repo.stockByPart(ctx, spareId);
  }

  /** Replenishment candidates: live spares whose total on-hand <= reorder_level. */
  lowStock(ctx: RequestContext): Promise<LowStockRow[]> {
    return this.repo.lowStock(ctx);
  }

  /** SPARE.EXPORT — CSV of the (filtered) catalog. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Part Code', 'Part Name', 'UOM', 'Unit Price', 'Reorder Level', 'Active', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.partCode, r.partName, r.uom, r.unitPrice, r.reorderLevel, r.isActive, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
