import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { QualityRepository } from './quality.repository';
import { QualityService } from './quality.service';
import { QualityController } from './quality.controller';
import { INSPECTION_PERMS } from './quality.constants';
import {
  createInspectionSchema, recordResultsSchema, listQuerySchema,
  registerGaugeSchema, recordCalibrationSchema, gaugeListQuerySchema,
} from './quality.dto';

/** Compose the QMS Quality module (repository -> service -> controller) and routes. */
export function qualityRouter(pool: Pool): Router {
  const controller = new QualityController(new QualityService(new QualityRepository(pool)));
  const r = Router();
  const P = INSPECTION_PERMS;

  // --- Calibration register (static prefix; must precede '/:id') -----------
  r.post('/gauges',
    requirePermission(P.CREATE),
    validate(registerGaugeSchema),
    asyncHandler(controller.registerGauge));

  r.get('/gauges',
    requirePermission(P.VIEW),
    validate(gaugeListQuerySchema, 'query'),
    asyncHandler(controller.listGauges));

  r.get('/gauges/:gaugeId',
    requirePermission(P.VIEW),
    asyncHandler(controller.getGauge));

  r.post('/gauges/:gaugeId/calibrations',
    requirePermission(P.CREATE),
    validate(recordCalibrationSchema),
    asyncHandler(controller.recordCalibration));

  r.get('/gauges/:gaugeId/calibrations',
    requirePermission(P.VIEW),
    asyncHandler(controller.gaugeHistory));

  // --- Inspections ---------------------------------------------------------
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
    validate(createInspectionSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  // Record per-line + overall result — INSPECTION.CREATE (the inspector).
  r.post('/:id/results',
    requirePermission(P.CREATE),
    validate(recordResultsSchema),
    asyncHandler(controller.recordResults));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
