import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { EnquiryRepository } from '../enquiry/enquiry.repository';
import { PdfService } from '../../services/pdf.service';
import { EmailService } from '../../services/email.service';
import { QuotationRepository } from './quotation.repository';
import { QuotationService } from './quotation.service';
import { QuotationController } from './quotation.controller';
import { QUOTE_PERMS } from './quotation.constants';
import {
  createQuotationSchema, updateQuotationSchema, convertSchema, versionSchema,
  decisionSchema, reviseSchema, sendSchema, listQuerySchema,
} from './quotation.dto';

export function quotationRouter(pool: Pool, email: EmailService): Router {
  const service = new QuotationService(
    new QuotationRepository(pool), new EnquiryRepository(pool), new PdfService(), email);
  const c = new QuotationController(service);
  const r = Router();
  const P = QUOTE_PERMS;

  r.get('/', requirePermission(P.VIEW), validate(listQuerySchema, 'query'), asyncHandler(c.list));
  r.post('/', requirePermission(P.CREATE), validate(createQuotationSchema), asyncHandler(c.create));
  r.post('/from-enquiry/:enquiryId', requirePermission(P.CREATE), validate(convertSchema), asyncHandler(c.convert));

  r.get('/:id', requirePermission(P.VIEW), asyncHandler(c.getById));
  r.get('/:id/revisions', requirePermission(P.VIEW), asyncHandler(c.revisions));
  r.get('/:id/pdf', requirePermission(P.VIEW), asyncHandler(c.pdf));

  r.patch('/:id', requirePermission(P.EDIT), validate(updateQuotationSchema), asyncHandler(c.update));
  r.post('/:id/submit', requirePermission(P.EDIT), validate(versionSchema), asyncHandler(c.submit));
  r.post('/:id/revise', requirePermission(P.EDIT), validate(reviseSchema), asyncHandler(c.revise));
  r.post('/:id/send', requirePermission(P.EDIT), validate(sendSchema), asyncHandler(c.send));
  r.post('/:id/won', requirePermission(P.EDIT), validate(versionSchema), asyncHandler(c.won));
  r.post('/:id/lost', requirePermission(P.EDIT), validate(decisionSchema), asyncHandler(c.lost));

  // approval gate — only QUOTATION.APPROVE holders (Finance / CEO)
  r.post('/:id/approve', requirePermission(P.APPROVE), validate(versionSchema), asyncHandler(c.approve));
  r.post('/:id/reject', requirePermission(P.APPROVE), validate(decisionSchema), asyncHandler(c.reject));

  return r;
}
