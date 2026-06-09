import { EnquiryService } from '../src/modules/enquiry/enquiry.service';
import { EnquiryRepository } from '../src/modules/enquiry/enquiry.repository';
import { RequestContext } from '../src/common/request-context';
import { Enquiry } from '../src/modules/enquiry/enquiry.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 1, username: 'tester', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

const sample: Enquiry = {
  enquiryId: 10, enquiryNo: 'ENQ/MUM/2026-27/000010', companyId: 1, buId: 1,
  customerName: 'Acme', contact: null, email: null, address: null, industry: null,
  source: null, requirement: null, mobile: null, machineType: null, application: null,
  quantity: null, budget: null, salesExecutive: null, followUpDate: null, remarks: null,
  status: 'NEW', createdAt: 't', createdBy: 1, updatedAt: 't', rowVersion: 1,
};

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    changeStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<EnquiryRepository>;
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('EnquiryService', () => {
  let repo: jest.Mocked<EnquiryRepository>;
  let service: EnquiryService;
  beforeEach(() => { repo = makeRepo(); service = new EnquiryService(repo); });

  describe('create', () => {
    it('creates with branch context and defaults status NEW', async () => {
      repo.create.mockResolvedValue(sample);
      const out = await service.create(ctx, { customerName: 'Acme' });
      expect(out).toBe(sample);
      expect(repo.create).toHaveBeenCalledWith(ctx, { customerName: 'Acme' });
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(status(service.create({ ...ctx, buId: null }, { customerName: 'A' }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
    it('forwards the additional intake fields to the repository', async () => {
      repo.create.mockResolvedValue(sample);
      const dto = { customerName: 'Acme', machineType: 'EOT Crane', quantity: 2, budget: 1500000 };
      await service.create(ctx, dto);
      expect(repo.create).toHaveBeenCalledWith(ctx, dto);
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(status(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('update', () => {
    it('400 when no fields supplied', async () => {
      await expect(status(service.update(ctx, 10, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when enquiry is terminal (CONVERTED/LOST)', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'CONVERTED' });
      await expect(status(service.update(ctx, 10, { rowVersion: 1, customerName: 'X' }))).resolves.toBe(409);
    });
    it('409 on row-version mismatch', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.update.mockResolvedValue(null);
      await expect(status(service.update(ctx, 10, { rowVersion: 1, customerName: 'X' }))).resolves.toBe(409);
    });
    it('updates only supplied fields', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.update.mockResolvedValue({ ...sample, customerName: 'X', rowVersion: 2 });
      const out = await service.update(ctx, 10, { rowVersion: 1, customerName: 'X' });
      expect(out.customerName).toBe('X');
      expect(repo.update).toHaveBeenCalledWith(ctx, 10, 1, { customerName: 'X' });
    });
  });

  describe('changeStatus', () => {
    it('409 on an illegal transition (NEW -> CONVERTED)', async () => {
      repo.findById.mockResolvedValue(sample);
      await expect(status(service.changeStatus(ctx, 10, { status: 'CONVERTED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('400 when marking LOST without a reason', async () => {
      repo.findById.mockResolvedValue(sample);
      await expect(status(service.changeStatus(ctx, 10, { status: 'LOST', rowVersion: 1 }))).resolves.toBe(400);
    });
    it('allows a valid transition (NEW -> QUALIFIED)', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.changeStatus.mockResolvedValue({ ...sample, status: 'QUALIFIED', rowVersion: 2 });
      const out = await service.changeStatus(ctx, 10, { status: 'QUALIFIED', rowVersion: 1 });
      expect(out.status).toBe('QUALIFIED');
    });
  });

  describe('approve', () => {
    it('409 unless current status is NEW', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'QUALIFIED' });
      await expect(status(service.approve(ctx, 10, 1))).resolves.toBe(409);
    });
    it('qualifies a NEW enquiry', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.changeStatus.mockResolvedValue({ ...sample, status: 'QUALIFIED', rowVersion: 2 });
      expect((await service.approve(ctx, 10, 1)).status).toBe('QUALIFIED');
    });
  });

  describe('delete', () => {
    it('409 unless status is NEW (draft)', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'QUALIFIED' });
      await expect(status(service.delete(ctx, 10))).resolves.toBe(409);
    });
    it('soft-deletes a NEW enquiry', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 10);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 10);
    });
  });
});
