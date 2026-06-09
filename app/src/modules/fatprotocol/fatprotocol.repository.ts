import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { FatProtocol, FatProtocolParam, FatProtocolListResult } from './fatprotocol.types';
import { ListQueryDto } from './fatprotocol.dto';
import { TestType } from './fatprotocol.constants';

/** Header columns of qms.fat_protocol (no audit / row_version / is_deleted exist). */
const H = `protocol_id, company_id, protocol_code, protocol_name, item_id, test_type, is_active`;
/** Line columns of qms.fat_protocol_param. */
const L = `param_id, protocol_id, seq, param_name, spec_min, spec_max, uom`;

function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapHeader(r: QueryResultRow): FatProtocol {
  return {
    protocolId: Number(r.protocol_id),
    companyId: Number(r.company_id),
    protocolCode: r.protocol_code,
    protocolName: r.protocol_name,
    itemId: num(r.item_id),
    testType: r.test_type as TestType,
    isActive: r.is_active === true,
  };
}
function mapParam(r: QueryResultRow): FatProtocolParam {
  return {
    paramId: Number(r.param_id),
    protocolId: Number(r.protocol_id),
    seq: Number(r.seq),
    paramName: r.param_name,
    specMin: num(r.spec_min),
    specMax: num(r.spec_max),
    uom: (r.uom as string) ?? null,
  };
}

/** Header fields the service supplies for create. */
export interface CreateProtocolRow {
  protocolCode: string;
  protocolName: string;
  itemId?: number;
  testType?: TestType;
  isActive?: boolean;
}
/** One checklist line the service supplies (param_id / protocol_id are DB-assigned). */
export interface ParamRow {
  seq: number;
  paramName: string;
  specMin?: number | null;
  specMax?: number | null;
  uom?: string | null;
}
/** Mutable header fields for update (protocol_code is immutable). */
export type ProtocolFields = Partial<Pick<CreateProtocolRow, 'protocolName' | 'itemId' | 'testType' | 'isActive'>>;

const COL_OF: Record<string, string> = {
  protocolName: 'protocol_name', itemId: 'item_id', testType: 'test_type', isActive: 'is_active',
};

/** Thrown by create when the table-wide protocol_code UNIQUE (23505) is violated. */
export class DuplicateProtocolCodeError extends Error {}

export class FatProtocolRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchParams(q: Queryable, protocolId: number): Promise<FatProtocolParam[]> {
    const res = await q.query(
      `SELECT ${L} FROM qms.fat_protocol_param WHERE protocol_id = $1 ORDER BY seq`, [protocolId]);
    return res.rows.map(mapParam);
  }
  private async insertParams(q: Queryable, protocolId: number, params: ParamRow[]): Promise<void> {
    for (const p of params) {
      await q.query(
        `INSERT INTO qms.fat_protocol_param (protocol_id, seq, param_name, spec_min, spec_max, uom)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [protocolId, p.seq, p.paramName, p.specMin ?? null, p.specMax ?? null, p.uom ?? null]);
    }
  }

  /** Insert a protocol header + its checklist lines in one transaction. company_id =
   *  ctx.companyId so the row passes RLS WITH CHECK. A duplicate protocol_code raises
   *  DuplicateProtocolCodeError. */
  async create(ctx: RequestContext, h: CreateProtocolRow, params: ParamRow[]): Promise<FatProtocol> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO qms.fat_protocol
             (company_id, protocol_code, protocol_name, item_id, test_type, is_active)
           VALUES ($1,$2,$3,$4,COALESCE($5,'FAT'),COALESCE($6,true))
           RETURNING ${H}`,
          [ctx.companyId, h.protocolCode, h.protocolName, h.itemId ?? null,
           h.testType ?? null, h.isActive ?? null]);
        const header = mapHeader(res.rows[0]);
        await this.insertParams(c, header.protocolId, params);
        return { ...header, params: await this.fetchParams(c, header.protocolId) };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateProtocolCodeError();
      throw e;
    }
  }

  /** Header-only lookup (no lines). Used internally by the service for guard checks. */
  async findById(ctx: RequestContext, id: number): Promise<FatProtocol | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM qms.fat_protocol WHERE protocol_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapHeader(res.rows[0]) : null;
    });
  }

  /** Full lookup: the protocol header plus its ordered checklist lines. */
  async findByIdWithParams(ctx: RequestContext, id: number): Promise<FatProtocol | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM qms.fat_protocol WHERE protocol_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), params: await this.fetchParams(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<FatProtocolListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.active !== undefined) { params.push(q.active); where.push(`is_active = $${params.length}`); }
    if (q.testType) { params.push(q.testType); where.push(`test_type = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`); const i = params.length;
      where.push(`(protocol_code ILIKE $${i} OR protocol_name ILIKE $${i})`);
    }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM qms.fat_protocol WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${H} FROM qms.fat_protocol WHERE ${w}
          ORDER BY ${q.sort} ${dir}, protocol_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapHeader);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Update the header fields and, when `params` is supplied, REPLACE the whole
   * checklist (delete-then-insert) — all in one transaction. There is no row_version
   * on this table, so the update is unconditional. Returns null if the protocol is
   * not found in this tenant.
   */
  async update(
    ctx: RequestContext, id: number, fields: ProtocolFields, params?: ParamRow[],
  ): Promise<FatProtocol | null> {
    const set: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      values.push(v); set.push(`${COL_OF[k]} = $${values.length}`);
    }
    return runInContext(this.pool, ctx, async (c) => {
      // Tenant-guarded existence check (and lock) inside the transaction.
      const cur = await c.query(
        `SELECT ${H} FROM qms.fat_protocol WHERE protocol_id = $1 AND company_id = $2 FOR UPDATE`,
        [id, ctx.companyId]);
      if (!cur.rowCount) return null;
      let header = mapHeader(cur.rows[0]);
      if (set.length > 0) {
        values.push(id); const pId = values.length;
        values.push(ctx.companyId); const pCo = values.length;
        const res = await c.query(
          `UPDATE qms.fat_protocol SET ${set.join(', ')}
            WHERE protocol_id = $${pId} AND company_id = $${pCo}
          RETURNING ${H}`, values);
        header = mapHeader(res.rows[0]);
      }
      if (params) {
        await c.query(`DELETE FROM qms.fat_protocol_param WHERE protocol_id = $1`, [id]);
        await this.insertParams(c, id, params);
      }
      return { ...header, params: await this.fetchParams(c, id) };
    });
  }

  /**
   * Hard delete (the table has no is_deleted). The ON DELETE CASCADE on
   * qms.fat_protocol_param removes the checklist lines with it. Tenant-scoped.
   * Returns true if a row was removed.
   */
  async hardDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `DELETE FROM qms.fat_protocol WHERE protocol_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
