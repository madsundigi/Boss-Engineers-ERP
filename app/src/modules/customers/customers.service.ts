import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CustomersRepository, DuplicateCustomerCodeError } from './customers.repository';
import { Customer, CustomerListResult } from './customers.types';
import { CreateCustomerDto, UpdateCustomerDto, ListQueryDto } from './customers.dto';

/** credit_limit is numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * CustomersService — Customer master (M01) business logic. Stateless; depends only on
 * the injected repository so it is unit-testable without a database. The master is
 * company-scoped, soft-delete only, and optimistically locked on row_version.
 */
export class CustomersService {
  constructor(private readonly repo: CustomersRepository) {}

  async create(ctx: RequestContext, dto: CreateCustomerDto): Promise<Customer> {
    try {
      return await this.repo.create(ctx, {
        customerCode: dto.customerCode,
        customerName: dto.customerName,
        customerType: dto.customerType,
        gstin: dto.gstin,
        pan: dto.pan,
        creditLimit: dto.creditLimit != null ? round4(dto.creditLimit) : undefined,
        paymentTermId: dto.paymentTermId,
        defaultCurrencyId: dto.defaultCurrencyId,
        status: dto.status,
      });
    } catch (e) {
      if (e instanceof DuplicateCustomerCodeError) {
        throw Errors.conflict(`A customer with code '${dto.customerCode}' already exists`);
      }
      throw e;
    }
  }

  /** Header lookup; 404 if missing. */
  async getById(ctx: RequestContext, id: number): Promise<Customer> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Customer ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<CustomerListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateCustomerDto): Promise<Customer> {
    const { rowVersion, ...rest } = dto;
    if (Object.keys(rest).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing
    const fields = {
      customerName: rest.customerName,
      customerType: rest.customerType,
      gstin: rest.gstin,
      pan: rest.pan,
      creditLimit: rest.creditLimit != null ? round4(rest.creditLimit) : undefined,
      paymentTermId: rest.paymentTermId,
      defaultCurrencyId: rest.defaultCurrencyId,
      status: rest.status,
    };
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Customer was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Soft delete under optimistic lock. */
  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Customer was modified by someone else (row version mismatch)');
  }
}
