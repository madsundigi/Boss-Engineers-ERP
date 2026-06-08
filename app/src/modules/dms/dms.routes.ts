import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { DmsRepository } from './dms.repository';
import { DmsService } from './dms.service';
import { DmsController } from './dms.controller';
import { DOCUMENT_PERMS } from './dms.constants';
import {
  createDocumentSchema, addVersionSchema, updateDocumentSchema, versionSchema, listQuerySchema,
} from './dms.dto';

/** Compose the Document Management System module (repository -> service ->
 *  controller) and its routes. Mounted at /api/documents by the composition root. */
export function documentRouter(pool: Pool): Router {
  const controller = new DmsController(new DmsService(new DmsRepository(pool)));
  const r = Router();
  const P = DOCUMENT_PERMS;

  // Export must precede '/:id' so it is not captured as an id.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createDocumentSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateDocumentSchema),
    asyncHandler(controller.update));

  // Versions. listing reads (VIEW); adding a version is a create (CREATE) — the
  // client has already uploaded the file to object storage and passes the storageKey.
  r.get('/:id/versions',
    requirePermission(P.VIEW),
    asyncHandler(controller.listVersions));

  r.post('/:id/versions',
    requirePermission(P.CREATE),
    validate(addVersionSchema),
    asyncHandler(controller.addVersion));

  // Lifecycle transitions (DOCUMENT.EDIT).
  r.post('/:id/activate',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.activate));

  r.post('/:id/archive',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.archive));

  r.post('/:id/obsolete',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.markObsolete));

  r.delete('/:id',
    requirePermission(P.DELETE),
    validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  return r;
}
