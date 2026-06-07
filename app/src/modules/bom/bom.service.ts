import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { BomRepository, BomHeaderInput } from './bom.repository';
import { BomHeader, BomListResult, BomLine } from './bom.types';
import { CreateBomDto, UpdateBomDto, ListQueryDto } from './bom.dto';
import { canTransition, BOM_RELEASED_EVENT } from './bom.constants';

/**
 * BomService — business logic for the Engineering / Bill of Materials module.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Enforces the BOM lifecycle DRAFT -> RELEASED -> OBSOLETE:
 * a BOM is editable only in DRAFT, RELEASE freezes the engineering baseline
 * (requires >=1 component line) and emits 'bom.released', OBSOLETE supersedes it.
 */
export class BomService {
  constructor(private readonly repo: BomRepository) {}

  /** Map DTO lines to the domain shape and reject a duplicate component item. */
  private mapLines(dto?: CreateBomDto['lines']): BomLine[] {
    const lines: BomLine[] = (dto ?? []).map((l) => ({
      componentItemId: l.componentItemId,
      qtyPer: l.qtyPer,
      uomId: l.uomId,
      scrapPct: l.scrapPct ?? 0,
      isCritical: l.isCritical ?? false,
    }));
    const seen = new Set<number>();
    for (const l of lines) {
      if (seen.has(l.componentItemId)) {
        throw Errors.badRequest(`Duplicate component item ${l.componentItemId} in the BOM`);
      }
      seen.add(l.componentItemId);
    }
    return lines;
  }

  async create(ctx: RequestContext, dto: CreateBomDto): Promise<BomHeader> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a BOM number');
    }
    const lines = this.mapLines(dto.lines); // validates duplicates before any write
    const header: BomHeaderInput = {
      parentItemId: dto.parentItemId, bomType: dto.bomType, revision: dto.revision,
      projectId: dto.projectId, effectiveFrom: dto.effectiveFrom,
    };
    return this.repo.create(ctx, header, lines);
  }

  async getById(ctx: RequestContext, id: number): Promise<BomHeader> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`BOM ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<BomListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateBomDto): Promise<BomHeader> {
    const { rowVersion, lines, ...rest } = dto;
    const fields = rest as Partial<BomHeaderInput>;
    if (Object.keys(fields).length === 0 && !lines) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT BOM can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(
      ctx, id, rowVersion, fields, lines ? this.mapLines(lines) : undefined,
    );
    if (!updated) {
      throw Errors.conflict('BOM was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Release the BOM (engineering sign-off): DRAFT -> RELEASED. Requires at least
   * one component line. Emits 'bom.released' atomically with the state change so
   * downstream planning / production / costing consume the frozen baseline.
   */
  async release(ctx: RequestContext, id: number, rowVersion: number): Promise<BomHeader> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'RELEASED')) {
      throw Errors.conflict(`Only a DRAFT BOM can be released (current: ${existing.status})`);
    }
    if (existing.lines.length === 0) {
      throw Errors.conflict('A BOM must have at least one component line before release');
    }
    const updated = await this.repo.updateStatus(
      ctx, id, rowVersion, 'RELEASED',
      {
        eventType: BOM_RELEASED_EVENT, aggregateType: 'BOM', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          bomNo: existing.bomNo,
          parentItemId: existing.parentItemId,
          bomType: existing.bomType,
          revision: existing.revision,
        },
      },
    );
    if (!updated) throw Errors.conflict('BOM was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Supersede a RELEASED BOM: RELEASED -> OBSOLETE (a newer revision replaces it). */
  async obsolete(ctx: RequestContext, id: number, rowVersion: number): Promise<BomHeader> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'OBSOLETE')) {
      throw Errors.conflict(`Only a RELEASED BOM can be made OBSOLETE (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'OBSOLETE');
    if (!updated) throw Errors.conflict('BOM was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT BOM can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** BOM.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['BOM No', 'Parent Item', 'Type', 'Revision', 'Status', 'Effective From', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.bomNo, r.parentItemId, r.bomType, r.revision, r.status, r.effectiveFrom, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
