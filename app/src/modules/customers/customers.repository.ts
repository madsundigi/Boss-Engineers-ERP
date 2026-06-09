import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Customer, CustomerListResult } from './customers.types';
import { CustomerType, CustomerStatus } from './customers.constants';
import { ListQueryDto } from './customers.dto';

/** Columns of mdm.customer (db/01_security_master.sql). */
const C = `customer_id, company_id, customer_code, customer_name, customer_type, gstin,
  pan, credit_limit, payment_term_id, default_currency_id, status,
  created_at, created_by, updated_at, row_version`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapCustomer(r: QueryResultRow): Customer {
  return {
    customerId: Number(r.customer_id),
    companyId: Number(r.company_id),
    customerCode: r.customer_code,
    customerName: r.customer_name,
    customerType: r.customer_type as CustomerType,
    gstin: (r.gstin as string) ?? null,
    pan: (r.pan as string) ?? null,
    creditLimit: Number(r.credit_limit),
    paymentTermId: num(r.payment_term_id),
    defaultCurrencyId: Number(r.default_currency_id),
    status: r.status as CustomerStatus,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Fields the service supplies for create. */
export interface CreateCustomerRow {
  customerCode: string;
  customerName: string;
  customerType?: CustomerType;
  gstin?: string;
  pan?: string;
  creditLimit?: number;
  paymentTermId?: number;
  defaultCurrencyId: number;
  status?: CustomerStatus;
}
/** Mutable fields for update (customer_code + company_id are immutable). */
export type CustomerFields = Partial<Pick<CreateCustomerRow,
  'customerName' | 'customerType' | 'gstin' | 'pan' | 'creditLimit' |
  'paymentTermId' | 'defaultCurrencyId' | 'status'>>;

const COL_OF: Record<string, string> = {
  customerName: 'customer_name', customerType: 'customer_type', gstin: 'gstin', pan: 'pan',
  creditLimit: 'credit_limit', paymentTermId: 'payment_term_id',
  defaultCurrencyId: 'default_currency_id', status: 'status',
};

/** Thrown by create when the UNIQUE customer_code (23505) is violated. */
export class DuplicateCustomerCodeError extends Error {}

export class CustomersRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert a customer. company_id = ctx.companyId. A duplicate customer_code raises
   *  DuplicateCustomerCodeError. */
  async create(ctx: RequestContext, data: CreateCustomerRow): Promise<Customer> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO mdm.customer
             (company_id, customer_code, customer_name, customer_type, gstin, pan,
              credit_limit, payment_term_id, default_currency_id, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${C}`,
          [ctx.companyId, data.customerCode, data.customerName, data.customerType ?? 'OTHER',
           data.gstin ?? null, data.pan ?? null, data.creditLimit ?? 0,
           data.paymentTermId ?? null, data.defaultCurrencyId, data.status ?? 'ACTIVE',
           ctx.userId]);
        return mapCustomer(res.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateCustomerCodeError();
      throw e;
    }
  }

  /** Header lookup scoped to the tenant; null when missing or soft-deleted. */
  async findById(ctx: RequestContext, id: number): Promise<Customer | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${C} FROM mdm.customer WHERE customer_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapCustomer(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<CustomerListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status !== undefined) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(customer_code ILIKE $${params.length} OR customer_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM mdm.customer WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${C} FROM mdm.customer WHERE ${w}
          ORDER BY ${q.sort} ${dir}, customer_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapCustomer);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null on a row-version mismatch. */
  async update(ctx: RequestContext, id: number, version: number, fields: CustomerFields): Promise<Customer | null> {
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
        `UPDATE mdm.customer
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE customer_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${C}`, params);
      return res.rowCount ? mapCustomer(res.rows[0]) : null;
    });
  }

  /** Soft delete under optimistic lock. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.customer
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE customer_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
