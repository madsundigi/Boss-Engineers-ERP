import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { VendorsRepository, DuplicateVendorCodeError } from './vendors.repository';
import { Vendor, VendorListResult } from './vendors.types';
import { CreateVendorDto, UpdateVendorDto, ListQueryDto } from './vendors.dto';

/**
 * VendorsService — supplier master business logic. Stateless; depends only on the
 * injected repository so it is unit-testable without a database. Vendors are
 * soft-delete only and updated under optimistic concurrency (row_version -> 409).
 */
export class VendorsService {
  constructor(private readonly repo: VendorsRepository) {}

  async create(ctx: RequestContext, dto: CreateVendorDto): Promise<Vendor> {
    try {
      return await this.repo.create(ctx, {
        vendorCode: dto.vendorCode,
        vendorName: dto.vendorName,
        gstin: dto.gstin,
        pan: dto.pan,
        msmeFlag: dto.msmeFlag,
        isApproved: dto.isApproved,
        paymentTermId: dto.paymentTermId,
        rating: dto.rating,
        status: dto.status,
      });
    } catch (e) {
      if (e instanceof DuplicateVendorCodeError) {
        throw Errors.conflict(`A vendor with code '${dto.vendorCode}' already exists`);
      }
      throw e;
    }
  }

  async getById(ctx: RequestContext, id: number): Promise<Vendor> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Vendor ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<VendorListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateVendorDto): Promise<Vendor> {
    const { rowVersion, ...rest } = dto;
    if (Object.keys(rest).length === 0) throw Errors.badRequest('No fields supplied to update');
    await this.getById(ctx, id); // 404 if missing
    const updated = await this.repo.update(ctx, id, rowVersion, {
      vendorName: rest.vendorName,
      gstin: rest.gstin,
      pan: rest.pan,
      msmeFlag: rest.msmeFlag,
      isApproved: rest.isApproved,
      paymentTermId: rest.paymentTermId,
      rating: rest.rating,
      status: rest.status,
    });
    if (!updated) throw Errors.conflict('Vendor was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Soft delete under optimistic concurrency. */
  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Vendor was modified by someone else (row version mismatch)');
  }
}
