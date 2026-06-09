import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  WorkOrder, WorkOrderListResult, WorkOrderOperation, WorkOrderMaterial,
  ProductionConfirmation, AsBuiltSerial,
} from './production.types';
import { ListQueryDto } from './production.dto';
import { DOC_TYPE, WoStatus } from './production.constants';

/** Header columns of mfg.work_order (bu_id added in migration 012). */
const H = `wo_id, wo_no, company_id, bu_id, project_id, wbs_id, item_id, bom_id,
  routing_id, qty, planned_start, planned_end, actual_start, actual_end, status,
  delay_reason, percent_complete,
  created_at, created_by, updated_at, row_version`;

type Header = Omit<WorkOrder, 'operations' | 'materials' | 'confirmations' | 'asBuilt'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    woId: Number(r.wo_id),
    woNo: r.wo_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    itemId: Number(r.item_id),
    bomId: r.bom_id == null ? null : Number(r.bom_id),
    routingId: r.routing_id == null ? null : Number(r.routing_id),
    qty: Number(r.qty),
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    actualStart: r.actual_start,
    actualEnd: r.actual_end,
    status: r.status,
    delayReason: r.delay_reason == null ? null : r.delay_reason,
    percentComplete: r.percent_complete == null ? null : Number(r.percent_complete),
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapOperation(r: QueryResultRow): WorkOrderOperation {
  return {
    woOpId: Number(r.wo_op_id),
    opSeq: Number(r.op_seq),
    workCenterId: Number(r.work_center_id),
    stdTimeMin: Number(r.std_time_min),
    actualTimeMin: Number(r.actual_time_min),
    status: r.status,
  };
}
function mapMaterial(r: QueryResultRow): WorkOrderMaterial {
  return {
    woMatId: Number(r.wo_mat_id),
    itemId: Number(r.item_id),
    requiredQty: Number(r.required_qty),
    issuedQty: Number(r.issued_qty),
  };
}
function mapConfirmation(r: QueryResultRow): ProductionConfirmation {
  return {
    confId: Number(r.conf_id),
    woOpId: Number(r.wo_op_id),
    qtyDone: Number(r.qty_done),
    qtyScrap: Number(r.qty_scrap),
    qtyRework: Number(r.qty_rework),
    labourHours: Number(r.labour_hours),
    confDate: r.conf_date,
    confirmedBy: r.confirmed_by == null ? null : Number(r.confirmed_by),
  };
}
function mapAsBuilt(r: QueryResultRow): AsBuiltSerial {
  return {
    asBuiltId: Number(r.as_built_id),
    serialId: Number(r.serial_id),
    serialNo: r.serial_no,
    parentSerialId: r.parent_serial_id == null ? null : Number(r.parent_serial_id),
    builtAt: r.built_at,
  };
}

export interface CreateWorkOrderRow {
  projectId: number;
  itemId: number;
  qty: number;
  wbsId?: number;
  bomId?: number;
  routingId?: number;
  plannedStart?: string;
  plannedEnd?: string;
  delayReason?: string;
  percentComplete?: number;
  operations?: { opSeq: number; workCenterId: number; stdTimeMin: number }[];
  materials?: { itemId: number; requiredQty: number }[];
}

export type HeaderFields = {
  qty?: number;
  wbsId?: number;
  bomId?: number;
  routingId?: number;
  plannedStart?: string;
  plannedEnd?: string;
  delayReason?: string;
  percentComplete?: number;
};

/** Partial header patch carried alongside a status change (release / complete / hold). */
export type StatusPatch = Partial<Record<
  'planned_start' | 'actual_start' | 'actual_end' | 'delay_reason' | 'percent_complete', unknown>>;

/** One production confirmation to insert against an operation. */
export interface ConfirmationInput {
  woOpId: number;
  qtyDone: number;
  qtyScrap: number;
  qtyRework: number;
  labourHours: number;
  confDate?: string;
  operationDone: boolean;
}

export class ProductionRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchOperations(q: Queryable, id: number): Promise<WorkOrderOperation[]> {
    const res = await q.query(
      `SELECT wo_op_id, op_seq, work_center_id, std_time_min, actual_time_min, status
         FROM mfg.work_order_operation WHERE wo_id = $1 ORDER BY op_seq`, [id]);
    return res.rows.map(mapOperation);
  }
  private async fetchMaterials(q: Queryable, id: number): Promise<WorkOrderMaterial[]> {
    const res = await q.query(
      `SELECT wo_mat_id, item_id, required_qty, issued_qty
         FROM mfg.work_order_material WHERE wo_id = $1 ORDER BY wo_mat_id`, [id]);
    return res.rows.map(mapMaterial);
  }
  private async fetchConfirmations(q: Queryable, id: number): Promise<ProductionConfirmation[]> {
    const res = await q.query(
      `SELECT c.conf_id, c.wo_op_id, c.qty_done, c.qty_scrap, c.qty_rework,
              c.labour_hours, c.conf_date, c.confirmed_by
         FROM mfg.production_confirmation c
         JOIN mfg.work_order_operation o ON o.wo_op_id = c.wo_op_id
        WHERE o.wo_id = $1 ORDER BY c.conf_id`, [id]);
    return res.rows.map(mapConfirmation);
  }
  private async fetchAsBuilt(q: Queryable, id: number): Promise<AsBuiltSerial[]> {
    const res = await q.query(
      `SELECT a.as_built_id, a.serial_id, s.serial_no, a.parent_serial_id, a.built_at
         FROM mfg.as_built a
         JOIN scm.serial_number s ON s.serial_id = a.serial_id
        WHERE a.wo_id = $1 ORDER BY a.as_built_id`, [id]);
    return res.rows.map(mapAsBuilt);
  }

  private async insertOperations(
    q: Queryable, id: number, ops: NonNullable<CreateWorkOrderRow['operations']>,
  ): Promise<void> {
    for (const o of ops) {
      await q.query(
        `INSERT INTO mfg.work_order_operation
           (wo_id, op_seq, work_center_id, std_time_min, status)
         VALUES ($1,$2,$3,$4,'PENDING')`,
        [id, o.opSeq, o.workCenterId, o.stdTimeMin]);
    }
  }
  private async insertMaterials(
    q: Queryable, id: number, mats: NonNullable<CreateWorkOrderRow['materials']>,
  ): Promise<void> {
    for (const m of mats) {
      await q.query(
        `INSERT INTO mfg.work_order_material (wo_id, item_id, required_qty)
         VALUES ($1,$2,$3)`,
        [id, m.itemId, m.requiredQty]);
    }
  }

  private async hydrate(q: Queryable, header: Header): Promise<WorkOrder> {
    return {
      ...header,
      operations: await this.fetchOperations(q, header.woId),
      materials: await this.fetchMaterials(q, header.woId),
      confirmations: await this.fetchConfirmations(q, header.woId),
      asBuilt: await this.fetchAsBuilt(q, header.woId),
    };
  }

  /** Insert, allocating the gapless WO number inside the same transaction. */
  async create(ctx: RequestContext, data: CreateWorkOrderRow, event?: OutboxEventInput): Promise<WorkOrder> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO mfg.work_order
           (company_id, bu_id, wo_no, project_id, wbs_id, item_id, bom_id, routing_id,
            qty, planned_start, planned_end, delay_reason, percent_complete, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PLANNED',$13)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, data.projectId, data.wbsId ?? null, data.itemId,
          data.bomId ?? null, data.routingId ?? null, data.qty,
          data.plannedStart ?? null, data.plannedEnd ?? null,
          data.delayReason ?? null, data.percentComplete ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      if (data.operations?.length) await this.insertOperations(c, header.woId, data.operations);
      if (data.materials?.length) await this.insertMaterials(c, header.woId, data.materials);
      if (event) await emitOutbox(c, event);
      return this.hydrate(c, header);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<WorkOrder | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM mfg.work_order
          WHERE wo_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<WorkOrderListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.itemId) { params.push(q.itemId); where.push(`item_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`wo_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM mfg.work_order WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM mfg.work_order WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Optimistic-locked plan update: patch header fields and (when supplied) fully
   * replace the operations / material collections. Returns null on a version
   * mismatch. Only valid pre-release (the service guards the status).
   */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: HeaderFields,
    operations?: NonNullable<CreateWorkOrderRow['operations']>,
    materials?: NonNullable<CreateWorkOrderRow['materials']>,
  ): Promise<WorkOrder | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.qty !== undefined) add('qty', fields.qty);
    if (fields.wbsId !== undefined) add('wbs_id', fields.wbsId);
    if (fields.bomId !== undefined) add('bom_id', fields.bomId);
    if (fields.routingId !== undefined) add('routing_id', fields.routingId);
    if (fields.plannedStart !== undefined) add('planned_start', fields.plannedStart);
    if (fields.plannedEnd !== undefined) add('planned_end', fields.plannedEnd);
    if (fields.delayReason !== undefined) add('delay_reason', fields.delayReason);
    if (fields.percentComplete !== undefined) add('percent_complete', fields.percentComplete);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE mfg.work_order
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE wo_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      // Replace child collections when supplied (we fully own them pre-release).
      if (operations !== undefined) {
        await c.query(`DELETE FROM mfg.work_order_operation WHERE wo_id = $1`, [id]);
        await this.insertOperations(c, id, operations);
      }
      if (materials !== undefined) {
        await c.query(`DELETE FROM mfg.work_order_material WHERE wo_id = $1`, [id]);
        await this.insertMaterials(c, id, materials);
      }
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /**
   * Lifecycle status change with an optional header patch and an optional outbox
   * event emitted atomically with the state change. Returns null on a version
   * mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number | null, status: WoStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<WorkOrder | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      let verClause = '';
      if (expectedVersion !== null) { params.push(expectedVersion); verClause = ` AND row_version = $${params.length}`; }
      const res = await c.query(
        `UPDATE mfg.work_order SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE wo_id = $${pId} AND company_id = $${pCo} AND NOT is_deleted${verClause}
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /**
   * Record a production confirmation against one operation, advance the WO to
   * IN_PROGRESS (stamping actual_start on the first confirmation), roll up the
   * operation's actual time, and optionally mark the operation DONE — all in one
   * transaction. Returns null on a row-version mismatch.
   */
  async confirm(
    ctx: RequestContext, id: number, expectedVersion: number, conf: ConfirmationInput,
  ): Promise<WorkOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mfg.work_order
            SET status = 'IN_PROGRESS',
                actual_start = COALESCE(actual_start, current_date),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE wo_id = $2 AND company_id = $3 AND row_version = $4 AND NOT is_deleted
        RETURNING ${H}`,
        [ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      await c.query(
        `INSERT INTO mfg.production_confirmation
           (wo_op_id, qty_done, qty_scrap, qty_rework, labour_hours, conf_date, confirmed_by)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::date, current_date), $7)`,
        [conf.woOpId, conf.qtyDone, conf.qtyScrap, conf.qtyRework, conf.labourHours,
         conf.confDate ?? null, ctx.userId]);
      // Roll the actual time + status into the operation (labour hours -> minutes).
      await c.query(
        `UPDATE mfg.work_order_operation
            SET actual_time_min = actual_time_min + $1,
                status = CASE WHEN $2 THEN 'DONE'
                              WHEN status = 'PENDING' THEN 'IN_PROGRESS'
                              ELSE status END
          WHERE wo_op_id = $3 AND wo_id = $4`,
        [conf.labourHours * 60, conf.operationDone, conf.woOpId, id]);
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /** Does this operation belong to this work order? (validation helper) */
  async operationBelongsTo(ctx: RequestContext, woId: number, woOpId: number): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM mfg.work_order_operation WHERE wo_op_id = $1 AND wo_id = $2`,
        [woOpId, woId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Complete the WO: register each as-built serial (scm.serial_number, status
   * INSTALLED is not implied — they leave production as WIP), link it via
   * mfg.as_built, stamp actual_end, and move the WO to COMPLETED. A serial that
   * already exists for the item is reused (idempotent on re-run). Returns null on
   * a row-version mismatch.
   */
  async complete(
    ctx: RequestContext, id: number, expectedVersion: number,
    itemId: number, projectId: number,
    asBuilt: { serialNo: string; parentSerialNo?: string }[],
    event?: OutboxEventInput,
  ): Promise<WorkOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mfg.work_order
            SET status = 'COMPLETED',
                actual_end = current_date,
                actual_start = COALESCE(actual_start, current_date),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE wo_id = $2 AND company_id = $3 AND row_version = $4 AND NOT is_deleted
        RETURNING ${H}`,
        [ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;

      for (const b of asBuilt) {
        const serialId = await this.ensureSerial(c, itemId, projectId, b.serialNo);
        const parentId = b.parentSerialNo
          ? await this.ensureSerial(c, itemId, projectId, b.parentSerialNo)
          : null;
        await c.query(
          `INSERT INTO mfg.as_built (wo_id, serial_id, parent_serial_id)
           VALUES ($1,$2,$3)`,
          [id, serialId, parentId]);
      }
      if (event) await emitOutbox(c, event);
      return this.hydrate(c, mapHeader(res.rows[0]));
    });
  }

  /** Find-or-create a serial for an item; returns its serial_id. */
  private async ensureSerial(
    c: Queryable, itemId: number, projectId: number, serialNo: string,
  ): Promise<number> {
    const ins = await c.query<{ serial_id: string }>(
      `INSERT INTO scm.serial_number (item_id, serial_no, project_id, status)
       VALUES ($1,$2,$3,'WIP')
       ON CONFLICT (item_id, serial_no) DO UPDATE SET serial_no = EXCLUDED.serial_no
       RETURNING serial_id`,
      [itemId, serialNo, projectId]);
    return Number(ins.rows[0].serial_id);
  }
}
