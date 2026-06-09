import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { FatProtocolRepository, DuplicateProtocolCodeError, ParamRow } from './fatprotocol.repository';
import { FatProtocol, FatProtocolListResult } from './fatprotocol.types';
import { CreateProtocolDto, UpdateProtocolDto, ListQueryDto, ParamDto } from './fatprotocol.dto';

/** spec_min / spec_max are numeric(20,6); round to 6 dp to dodge float drift. */
const SCALE = 1_000_000;
function round6(n: number | undefined): number | undefined {
  return n == null ? undefined : Math.round(n * SCALE) / SCALE;
}

/** Map a validated line DTO to a repository row, rounding the spec band. */
function toParamRow(p: ParamDto): ParamRow {
  return { seq: p.seq, paramName: p.paramName, specMin: round6(p.specMin), specMax: round6(p.specMax), uom: p.uom };
}

/**
 * Reject a checklist whose seq values are not unique (the DB also enforces
 * uq_protocol_param, but a clear 400 beats a raw 23505 for a client mistake) or
 * whose spec band is inverted (min > max).
 */
function validateParams(params: ParamDto[]): void {
  const seen = new Set<number>();
  for (const p of params) {
    if (seen.has(p.seq)) throw Errors.badRequest(`Duplicate parameter seq ${p.seq}`);
    seen.add(p.seq);
    if (p.specMin != null && p.specMax != null && p.specMin > p.specMax) {
      throw Errors.badRequest(`Parameter '${p.paramName}': spec min (${p.specMin}) exceeds max (${p.specMax})`);
    }
  }
}

/**
 * FatProtocolService — FAT/SAT test-protocol master-data business logic. Stateless;
 * depends only on the injected repository so it is unit-testable without a database.
 * The protocol is a header + a repeatable list of checklist parameter lines. There
 * is no row_version on the table, so there is NO optimistic concurrency, and DELETE
 * is a HARD delete (cascading to the lines).
 */
export class FatProtocolService {
  constructor(private readonly repo: FatProtocolRepository) {}

  async create(ctx: RequestContext, dto: CreateProtocolDto): Promise<FatProtocol> {
    const params = dto.params ?? [];
    validateParams(params);
    try {
      return await this.repo.create(
        ctx,
        {
          protocolCode: dto.protocolCode,
          protocolName: dto.protocolName,
          itemId: dto.itemId,
          testType: dto.testType,
          isActive: dto.isActive,
        },
        params.map(toParamRow),
      );
    } catch (e) {
      if (e instanceof DuplicateProtocolCodeError) {
        throw Errors.conflict(`A FAT protocol with code '${dto.protocolCode}' already exists`);
      }
      throw e;
    }
  }

  /** Header + its ordered checklist lines; 404 if missing. */
  async getById(ctx: RequestContext, id: number): Promise<FatProtocol> {
    const row = await this.repo.findByIdWithParams(ctx, id);
    if (!row) throw Errors.notFound(`FAT protocol ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<FatProtocolListResult> {
    return this.repo.list(ctx, query);
  }

  /**
   * Edit the header and, when `params` is supplied, REPLACE the whole checklist.
   * protocol_code is immutable. 404 if the protocol is missing in this tenant.
   */
  async update(ctx: RequestContext, id: number, dto: UpdateProtocolDto): Promise<FatProtocol> {
    if (dto.params) validateParams(dto.params);
    const fields = {
      protocolName: dto.protocolName,
      itemId: dto.itemId,
      testType: dto.testType,
      isActive: dto.isActive,
    };
    const updated = await this.repo.update(ctx, id, fields, dto.params?.map(toParamRow));
    if (!updated) throw Errors.notFound(`FAT protocol ${id} not found`);
    return updated;
  }

  /** Hard delete (cascades to the checklist lines). 404 if missing in this tenant. */
  async delete(ctx: RequestContext, id: number): Promise<void> {
    const ok = await this.repo.hardDelete(ctx, id);
    if (!ok) throw Errors.notFound(`FAT protocol ${id} not found`);
  }
}
