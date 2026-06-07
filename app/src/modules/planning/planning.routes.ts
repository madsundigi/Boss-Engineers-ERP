import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { PlanningRepository } from './planning.repository';
import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { PLANNING_PERMS } from './planning.constants';
import {
  createWbsSchema, createTaskSchema, updateTaskSchema, createMilestoneSchema,
  updateMilestoneSchema, createBaselineSchema, approveBaselineSchema,
} from './planning.dto';

/** Compose the planning module (repository -> service -> controller) and routes. */
export function planningRouter(pool: Pool): Router {
  const controller = new PlanningController(new PlanningService(new PlanningRepository(pool)));
  const r = Router();
  const P = PLANNING_PERMS;

  // --- Baseline approval gate — only PLANNING.APPROVE holders. Declared before
  //     the parameterized routes so 'baseline' is never captured as an :id. ---
  r.post('/baseline/approve',
    requirePermission(P.APPROVE),
    validate(approveBaselineSchema),
    asyncHandler(controller.approveBaseline));

  // --- WBS (project-scoped) ---
  r.get('/projects/:projectId/wbs',
    requirePermission(P.VIEW),
    asyncHandler(controller.listWbs));

  r.post('/projects/:projectId/wbs',
    requirePermission(P.CREATE),
    validate(createWbsSchema),
    asyncHandler(controller.createWbs));

  // --- Tasks (project-scoped collection + schedule) ---
  r.get('/projects/:projectId/schedule',
    requirePermission(P.VIEW),
    asyncHandler(controller.schedule));

  r.post('/projects/:projectId/tasks',
    requirePermission(P.CREATE),
    validate(createTaskSchema),
    asyncHandler(controller.createTask));

  // --- Milestones (project-scoped) ---
  r.get('/projects/:projectId/milestones',
    requirePermission(P.VIEW),
    asyncHandler(controller.listMilestones));

  r.post('/projects/:projectId/milestones',
    requirePermission(P.CREATE),
    validate(createMilestoneSchema),
    asyncHandler(controller.createMilestone));

  // --- Baseline (project-scoped create) ---
  r.post('/projects/:projectId/baseline',
    requirePermission(P.CREATE),
    validate(createBaselineSchema),
    asyncHandler(controller.createBaseline));

  // --- Single-task operations ---
  r.get('/tasks/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getTask));

  r.patch('/tasks/:id',
    requirePermission(P.EDIT),
    validate(updateTaskSchema),
    asyncHandler(controller.updateTask));

  // --- Single-milestone operations ---
  r.patch('/milestones/:id',
    requirePermission(P.EDIT),
    validate(updateMilestoneSchema),
    asyncHandler(controller.updateMilestone));

  return r;
}
