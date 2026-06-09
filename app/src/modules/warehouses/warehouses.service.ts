import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  WarehousesRepository, DuplicateWarehouseCodeError, BusinessUnitNotFoundError,
  WarehouseInUseError,
} from './warehouses.repository';
import { Warehouse, WarehouseListResult } from './warehouses.types';
import { CreateWarehouseDto, UpdateWarehouseDto, ListQueryDto } from './warehouses.dto';

/**
 * WarehousesService — inventory-location master business logic. Stateless; depends only
 * on the injected repository so it is unit-testable without a database.
 *
 * Adapted from the spares template because mdm.warehouse is minimal: there is no
 * row_version (so no optimistic concurrency on update/delete) and no is_deleted (so
 * DELETE is a hard delete). Tenant scoping is enforced in the repository via a JOIN to
 * mdm.business_unit on company_id.
 */
export class WarehousesService {
  constructor(private readonly repo: WarehousesRepository) {}

  async create(ctx: RequestContext, dto: CreateWarehouseDto): Promise<Warehouse> {
    try {
      return await this.repo.create(ctx, {
        buId: dto.buId,
        whCode: dto.whCode,
        whName: dto.whName,
        isActive: dto.isActive,
      });
    } catch (e) {
      if (e instanceof BusinessUnitNotFoundError) {
        throw Errors.notFound(`Business unit ${dto.buId} not found in this company`);
      }
      if (e instanceof DuplicateWarehouseCodeError) {
        throw Errors.conflict(`A warehouse with code '${dto.whCode}' already exists in this business unit`);
      }
      throw e;
    }
  }

  async getById(ctx: RequestContext, id: number): Promise<Warehouse> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Warehouse ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<WarehouseListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateWarehouseDto): Promise<Warehouse> {
    if (Object.keys(dto).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing / out of tenant
    const updated = await this.repo.update(ctx, id, { whName: dto.whName, isActive: dto.isActive });
    if (!updated) throw Errors.notFound(`Warehouse ${id} not found`);
    return updated;
  }

  /** Hard delete (no is_deleted column). Blocked with a 409 if the warehouse is still
   *  referenced by stock or bins (the DB FK protects against orphaning). */
  async delete(ctx: RequestContext, id: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing / out of tenant
    try {
      const ok = await this.repo.hardDelete(ctx, id);
      if (!ok) throw Errors.notFound(`Warehouse ${id} not found`);
    } catch (e) {
      if (e instanceof WarehouseInUseError) {
        throw Errors.conflict('Cannot delete a warehouse that is still in use (it has stock or bins)');
      }
      throw e;
    }
  }
}
