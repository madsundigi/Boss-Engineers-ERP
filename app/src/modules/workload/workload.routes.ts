import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { WorkloadRepository } from './workload.repository';
import { WorkloadService } from './workload.service';
import { WorkloadController } from './workload.controller';
import { WORKLOAD_PERMS, TIMESHEET_PERMS } from './workload.constants';
import {
  createAllocationSchema, listAllocationsSchema, capacityQuerySchema,
  createTimesheetSchema, approveTimesheetSchema,
} from './workload.dto';

/** Compose the workload module (repository -> service -> controller) and routes. */
export function workloadRouter(pool: Pool): Router {
  const controller = new WorkloadController(new WorkloadService(new WorkloadRepository(pool)));
  const r = Router();

  // ---- Allocations (WORKLOAD.*) ----------------------------------------
  // 'capacity' must precede '/allocations/:id' so it is not captured as an id.
  r.get('/allocations/capacity',
    requirePermission(WORKLOAD_PERMS.VIEW),
    validate(capacityQuerySchema, 'query'),
    asyncHandler(controller.capacityLoad));

  r.get('/allocations',
    requirePermission(WORKLOAD_PERMS.VIEW),
    validate(listAllocationsSchema, 'query'),
    asyncHandler(controller.listAllocations));

  r.post('/allocations',
    requirePermission(WORKLOAD_PERMS.CREATE),
    validate(createAllocationSchema),
    asyncHandler(controller.createAllocation));

  r.get('/allocations/:id',
    requirePermission(WORKLOAD_PERMS.VIEW),
    asyncHandler(controller.getAllocation));

  r.post('/allocations/:id/confirm',
    requirePermission(WORKLOAD_PERMS.EDIT),
    validate(approveTimesheetSchema), // { rowVersion }
    asyncHandler(controller.confirmAllocation));

  r.post('/allocations/:id/cancel',
    requirePermission(WORKLOAD_PERMS.EDIT),
    validate(approveTimesheetSchema), // { rowVersion }
    asyncHandler(controller.cancelAllocation));

  // ---- Timesheets (TIMESHEET.*) ----------------------------------------
  r.post('/timesheets',
    requirePermission(TIMESHEET_PERMS.CREATE),
    validate(createTimesheetSchema),
    asyncHandler(controller.createTimesheet));

  r.get('/timesheets/:id',
    requirePermission(TIMESHEET_PERMS.VIEW),
    asyncHandler(controller.getTimesheet));

  r.post('/timesheets/:id/approve',
    requirePermission(TIMESHEET_PERMS.APPROVE),
    validate(approveTimesheetSchema),
    asyncHandler(controller.approveTimesheet));

  return r;
}
