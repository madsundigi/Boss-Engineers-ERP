import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  WorkCentersRepository, DuplicateWorkCenterCodeError, WorkCenterInUseError,
} from './workcenters.repository';
import { WorkCenter, WorkCenterListResult } from './workcenters.types';
import { CreateWorkCenterDto, UpdateWorkCenterDto, ListQueryDto } from './workcenters.dto';

/** capacity_per_day numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE4 = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE4) / SCALE4;
}
/** cost_rate numeric(20,6); round to 6 dp. */
const SCALE6 = 1_000_000;
function round6(n: number): number {
  return Math.round(n * SCALE6) / SCALE6;
}

/**
 * WorkCentersService — Work-Centre master (M08) business logic. Stateless; depends only
 * on the injected repository so it is unit-testable without a database. The table has no
 * company_id, so every operation is tenant-scoped through the parent business unit; a
 * buId pointing at another company's BU is rejected (400). No optimistic concurrency
 * (the table has no row_version) and delete is a hard delete (no is_deleted).
 */
export class WorkCentersService {
  constructor(private readonly repo: WorkCentersRepository) {}

  /** Guard: buId must reference a BU in the caller's company. 400 otherwise. */
  private async assertBuInTenant(ctx: RequestContext, buId: number): Promise<void> {
    if (!(await this.repo.buBelongsToCompany(ctx, buId))) {
      throw Errors.badRequest(`Business unit ${buId} does not exist in this company`);
    }
  }

  async create(ctx: RequestContext, dto: CreateWorkCenterDto): Promise<WorkCenter> {
    await this.assertBuInTenant(ctx, dto.buId);
    try {
      return await this.repo.create(ctx, {
        buId: dto.buId,
        wcCode: dto.wcCode,
        wcName: dto.wcName,
        capacityPerDay: dto.capacityPerDay != null ? round4(dto.capacityPerDay) : undefined,
        costRate: dto.costRate != null ? round6(dto.costRate) : undefined,
        isActive: dto.isActive,
      });
    } catch (e) {
      if (e instanceof DuplicateWorkCenterCodeError) {
        throw Errors.conflict(`A work centre with code '${dto.wcCode}' already exists`);
      }
      throw e;
    }
  }

  /** Lookup; 404 if missing or cross-tenant. */
  async getById(ctx: RequestContext, id: number): Promise<WorkCenter> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Work centre ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<WorkCenterListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateWorkCenterDto): Promise<WorkCenter> {
    if (Object.keys(dto).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing
    if (dto.buId !== undefined) await this.assertBuInTenant(ctx, dto.buId); // no cross-tenant move
    const fields = {
      buId: dto.buId,
      wcName: dto.wcName,
      capacityPerDay: dto.capacityPerDay != null ? round4(dto.capacityPerDay) : undefined,
      costRate: dto.costRate != null ? round6(dto.costRate) : undefined,
      isActive: dto.isActive,
    };
    const updated = await this.repo.update(ctx, id, fields);
    if (!updated) throw Errors.notFound(`Work centre ${id} not found`);
    return updated;
  }

  /** Hard delete. 404 if missing; 409 if a routing / work order still references it. */
  async delete(ctx: RequestContext, id: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    try {
      const ok = await this.repo.delete(ctx, id);
      if (!ok) throw Errors.notFound(`Work centre ${id} not found`);
    } catch (e) {
      if (e instanceof WorkCenterInUseError) {
        throw Errors.conflict('Cannot delete a work centre that is still referenced by routings or work orders');
      }
      throw e;
    }
  }
}
