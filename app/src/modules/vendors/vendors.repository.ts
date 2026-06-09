import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Vendor, VendorListResult } from './vendors.types';
import { VendorStatus } from './vendors.constants';
import { ListQueryDto } from './vendors.dto';

/** Columns of mdm.vendor (db/01_security_master.sql). */
const V = `vendor_id, company_id, vendor_code, vendor_name, gstin, pan, msme_flag,
  is_approved, payment_term_id, rating, status, created_at, created_by, updated_at,
  row_version`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapVendor(r: QueryResultRow): Vendor {
  return {
    vendorId: Number(r.vendor_id),
    companyId: Number(r.company_id),
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    gstin: (r.gstin as string) ?? null,
    pan: (r.pan as string) ?? null,
    msmeFlag: r.msme_flag === true,
    isApproved: r.is_approved === true,
    paymentTermId: num(r.payment_term_id),
    rating: num(r.rating),
    status: r.status as VendorStatus,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Fields the service supplies for create. */
export interface CreateVendorRow {
  vendorCode: string;
  vendorName: string;
  gstin?: string;
  pan?: string;
  msmeFlag?: boolean;
  isApproved?: boolean;
  paymentTermId?: number;
  rating?: number;
  status?: VendorStatus;
}
/** Mutable fields for update (vendor_code is immutable). */
export type VendorFields = Partial<Omit<CreateVendorRow, 'vendorCode'>>;

const COL_OF: Record<string, string> = {
  vendorName: 'vendor_name', gstin: 'gstin', pan: 'pan', msmeFlag: 'msme_flag',
  isApproved: 'is_approved', paymentTermId: 'payment_term_id', rating: 'rating',
  status: 'status',
};

/** Thrown by create when the UNIQUE on vendor_code (23505) is violated. */
export class DuplicateVendorCodeError extends Error {}

export class VendorsRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert a vendor. company_id = ctx.companyId so the row passes RLS WITH CHECK.
   *  A duplicate vendor_code raises DuplicateVendorCodeError. */
  async create(ctx: RequestContext, data: CreateVendorRow): Promise<Vendor> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO mdm.vendor
             (company_id, vendor_code, vendor_name, gstin, pan, msme_flag, is_approved,
              payment_term_id, rating, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${V}`,
          [ctx.companyId, data.vendorCode, data.vendorName, data.gstin ?? null,
           data.pan ?? null, data.msmeFlag ?? false, data.isApproved ?? false,
           data.paymentTermId ?? null, data.rating ?? null, data.status ?? 'ACTIVE',
           ctx.userId]);
        return mapVendor(res.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateVendorCodeError();
      throw e;
    }
  }

  async findById(ctx: RequestContext, id: number): Promise<Vendor | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${V} FROM mdm.vendor WHERE vendor_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapVendor(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<VendorListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status !== undefined) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(vendor_code ILIKE $${params.length} OR vendor_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM mdm.vendor WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${V} FROM mdm.vendor WHERE ${w}
          ORDER BY ${q.sort} ${dir}, vendor_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapVendor);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null on a row-version mismatch. */
  async update(ctx: RequestContext, id: number, version: number, fields: VendorFields): Promise<Vendor | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v); set.push(`${COL_OF[k]} = $${params.length}`);
    }
    if (set.length === 0) return this.findById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE mdm.vendor
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE vendor_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${V}`, params);
      return res.rowCount ? mapVendor(res.rows[0]) : null;
    });
  }

  /** Soft delete under optimistic lock. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.vendor
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE vendor_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
