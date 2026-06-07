import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Fat, FatResultLine, PunchItem, FatListResult } from './fat.types';
import { ListQueryDto } from './fat.dto';
import { DOC_TYPE, FatResult, FatStatus } from './fat.constants';

/** Header columns of qms.fat_execution (status/bu_id added in migration 009). */
const H = `fat_id, fat_no, company_id, bu_id, project_id, wo_id, protocol_id,
  fat_date, status, result, customer_witness, signoff_by,
  created_at, created_by, updated_at, row_version`;

type Header = Omit<Fat, 'resultLines' | 'punchItems'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    fatId: Number(r.fat_id),
    fatNo: r.fat_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: Number(r.project_id),
    woId: r.wo_id == null ? null : Number(r.wo_id),
    protocolId: Number(r.protocol_id),
    fatDate: r.fat_date,
    status: r.status,
    result: r.result,
    customerWitness: r.customer_witness,
    signoffBy: r.signoff_by == null ? null : Number(r.signoff_by),
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapResultLine(r: QueryResultRow): FatResultLine {
  return {
    resultLineId: Number(r.result_line_id),
    paramId: Number(r.param_id),
    measuredValue: r.measured_value == null ? null : Number(r.measured_value),
    passFail: r.pass_fail,
  };
}
function mapPunch(r: QueryResultRow): PunchItem {
  return {
    punchId: Number(r.punch_id),
    description: r.description,
    severity: r.severity,
    status: r.status,
    closedDate: r.closed_date,
  };
}

export interface CreateFatRow {
  projectId: number;
  protocolId: number;
  woId?: number;
  fatDate?: string;
  customerWitness?: string;
}
/** Partial header patch carried alongside a status change (sign-off etc.). */
export type StatusPatch = Partial<Record<'signoff_by' | 'customer_witness' | 'result', unknown>>;

export class FatRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchResultLines(q: Queryable, id: number): Promise<FatResultLine[]> {
    const res = await q.query(
      `SELECT result_line_id, param_id, measured_value, pass_fail
         FROM qms.fat_result_line WHERE fat_id = $1 ORDER BY result_line_id`, [id]);
    return res.rows.map(mapResultLine);
  }
  private async fetchPunchItems(q: Queryable, id: number): Promise<PunchItem[]> {
    const res = await q.query(
      `SELECT punch_id, description, severity, status, closed_date
         FROM qms.punch_item WHERE fat_id = $1 ORDER BY punch_id`, [id]);
    return res.rows.map(mapPunch);
  }
  private async insertResultLines(q: Queryable, id: number, lines: FatResultLine[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO qms.fat_result_line (fat_id, param_id, measured_value, pass_fail)
         VALUES ($1,$2,$3,$4)`,
        [id, l.paramId, l.measuredValue ?? null, l.passFail]);
    }
  }
  private async insertPunchItems(q: Queryable, id: number, items: PunchItem[]): Promise<void> {
    for (const p of items) {
      await q.query(
        `INSERT INTO qms.punch_item (fat_id, description, severity, status)
         VALUES ($1,$2,$3,'OPEN')`,
        [id, p.description, p.severity ?? null]);
    }
  }

  /** Insert, allocating the gapless FAT number inside the same transaction. */
  async create(ctx: RequestContext, data: CreateFatRow): Promise<Fat> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO qms.fat_execution
           (company_id, bu_id, fat_no, project_id, wo_id, protocol_id,
            fat_date, status, customer_witness, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5, COALESCE($6::date, current_date), 'SCHEDULED', $7, $8)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, data.projectId, data.woId ?? null, data.protocolId,
          data.fatDate ?? null, data.customerWitness ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      return { ...header, resultLines: [], punchItems: [] };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Fat | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM qms.fat_execution
          WHERE fat_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return {
        ...mapHeader(res.rows[0]),
        resultLines: await this.fetchResultLines(c, id),
        punchItems: await this.fetchPunchItems(c, id),
      };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<FatListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.result) { params.push(q.result); where.push(`result = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`fat_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM qms.fat_execution WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM qms.fat_execution WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update. Returns null if the version did not match. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number, fields: Partial<CreateFatRow>,
  ): Promise<Fat | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.woId !== undefined) add('wo_id', fields.woId);
    if (fields.fatDate !== undefined) add('fat_date', fields.fatDate);
    if (fields.customerWitness !== undefined) add('customer_witness', fields.customerWitness);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE qms.fat_execution
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE fat_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      return {
        ...mapHeader(res.rows[0]),
        resultLines: await this.fetchResultLines(c, id),
        punchItems: await this.fetchPunchItems(c, id),
      };
    });
  }

  /**
   * Record the test outcome atomically: replace measured result lines + punch
   * items and move the lifecycle status, all in one transaction. Returns null on
   * a row-version mismatch.
   */
  async recordResult(
    ctx: RequestContext, id: number, expectedVersion: number,
    status: FatStatus, result: FatResult, lines: FatResultLine[], punchItems: PunchItem[],
  ): Promise<Fat | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE qms.fat_execution
            SET status = $1, result = $2, updated_by = $3, updated_at = now(),
                row_version = row_version + 1
          WHERE fat_id = $4 AND company_id = $5 AND row_version = $6 AND NOT is_deleted
        RETURNING ${H}`,
        [status, result, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      // Replace child collections (we fully own them for this execution).
      await c.query(`DELETE FROM qms.fat_result_line WHERE fat_id = $1`, [id]);
      await this.insertResultLines(c, id, lines);
      await c.query(`DELETE FROM qms.punch_item WHERE fat_id = $1`, [id]);
      await this.insertPunchItems(c, id, punchItems);
      return {
        ...mapHeader(res.rows[0]),
        resultLines: await this.fetchResultLines(c, id),
        punchItems: await this.fetchPunchItems(c, id),
      };
    });
  }

  /**
   * Lifecycle status change with an optional header patch and an optional outbox
   * event (e.g. 'fat.passed' on sign-off) emitted atomically with the state change.
   * Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: FatStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<Fat | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE qms.fat_execution SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE fat_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      // Atomic with the state change: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return {
        ...mapHeader(res.rows[0]),
        resultLines: await this.fetchResultLines(c, id),
        punchItems: await this.fetchPunchItems(c, id),
      };
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE qms.fat_execution
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE fat_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
