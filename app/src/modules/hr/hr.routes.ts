import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { HrRepository } from './hr.repository';
import { HrService } from './hr.service';
import { HrController } from './hr.controller';
import { EMPLOYEE_PERMS, LEAVE_PERMS } from './hr.constants';
import {
  createEmployeeSchema, updateEmployeeSchema, listEmployeesSchema,
  createDepartmentSchema, createDesignationSchema,
  applyLeaveSchema, approveLeaveSchema, rejectLeaveSchema, listLeavesSchema,
  attendanceQuerySchema,
} from './hr.dto';

/**
 * Compose the HRMS core module (repository -> service -> controller) and mount
 * its routes. Mounted by the composition root at /api/hr; sub-paths:
 *   /employees     — employee master CRUD + CSV export (EMPLOYEE.*)
 *   /departments   — department reference data (EMPLOYEE.*)
 *   /designations  — designation reference data (EMPLOYEE.*)
 *   /leaves        — leave application + approval workflow (LEAVE.*)
 *   /attendance    — month attendance summary (EMPLOYEE.VIEW)
 */
export function hrRouter(pool: Pool): Router {
  const controller = new HrController(new HrService(new HrRepository(pool)));
  const r = Router();
  const E = EMPLOYEE_PERMS;
  const L = LEAVE_PERMS;

  // ---- Employees (static paths before '/:id') ----------------------------
  r.get('/employees/export',
    requirePermission(E.EXPORT),
    validate(listEmployeesSchema, 'query'),
    asyncHandler(controller.exportEmployees));

  r.get('/employees',
    requirePermission(E.VIEW),
    validate(listEmployeesSchema, 'query'),
    asyncHandler(controller.listEmployees));

  r.post('/employees',
    requirePermission(E.CREATE),
    validate(createEmployeeSchema),
    asyncHandler(controller.createEmployee));

  r.get('/employees/:id',
    requirePermission(E.VIEW),
    asyncHandler(controller.getEmployeeById));

  r.patch('/employees/:id',
    requirePermission(E.EDIT),
    validate(updateEmployeeSchema),
    asyncHandler(controller.updateEmployee));

  r.delete('/employees/:id',
    requirePermission(E.DELETE),
    asyncHandler(controller.deleteEmployee));

  // ---- Departments / Designations (reference data, EMPLOYEE.*) -----------
  r.get('/departments',
    requirePermission(E.VIEW),
    asyncHandler(controller.listDepartments));

  r.post('/departments',
    requirePermission(E.CREATE),
    validate(createDepartmentSchema),
    asyncHandler(controller.createDepartment));

  r.get('/designations',
    requirePermission(E.VIEW),
    asyncHandler(controller.listDesignations));

  r.post('/designations',
    requirePermission(E.CREATE),
    validate(createDesignationSchema),
    asyncHandler(controller.createDesignation));

  // ---- Attendance summary (EMPLOYEE.VIEW) --------------------------------
  r.get('/attendance',
    requirePermission(E.VIEW),
    validate(attendanceQuerySchema, 'query'),
    asyncHandler(controller.attendance));

  // ---- Leaves (LEAVE.*) --------------------------------------------------
  r.get('/leaves',
    requirePermission(L.VIEW),
    validate(listLeavesSchema, 'query'),
    asyncHandler(controller.listLeaves));

  r.post('/leaves',
    requirePermission(L.CREATE),
    validate(applyLeaveSchema),
    asyncHandler(controller.applyLeave));

  r.get('/leaves/:id',
    requirePermission(L.VIEW),
    asyncHandler(controller.getLeaveById));

  r.post('/leaves/:id/approve',
    requirePermission(L.APPROVE),
    validate(approveLeaveSchema),
    asyncHandler(controller.approveLeave));

  r.post('/leaves/:id/reject',
    requirePermission(L.APPROVE),
    validate(rejectLeaveSchema),
    asyncHandler(controller.rejectLeave));

  return r;
}
