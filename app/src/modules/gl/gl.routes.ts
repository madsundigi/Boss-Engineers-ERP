import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { GlRepository } from './gl.repository';
import { GlService } from './gl.service';
import { GlController } from './gl.controller';
import { GL_PERMS } from './gl.constants';
import {
  createAccountSchema, setActiveSchema, accountQuerySchema, postJournalSchema,
  journalQuerySchema, trialBalanceQuerySchema, ledgerQuerySchema, postCostSchema,
} from './gl.dto';

/**
 * Compose the GL module (repository -> service -> controller) and routes.
 * Deny-by-default RBAC per route: posting (journal/cost) + account creation
 * require GL.CREATE; setActive / reverse require GL.EDIT; every read requires
 * GL.VIEW; the CSV export requires GL.EXPORT.
 */
export function glRouter(pool: Pool): Router {
  const controller = new GlController(new GlService(new GlRepository(pool)));
  const r = Router();
  const P = GL_PERMS;

  // ---- Chart of accounts ----
  r.post('/accounts',
    requirePermission(P.CREATE),
    validate(createAccountSchema),
    asyncHandler(controller.createAccount));

  r.get('/accounts',
    requirePermission(P.VIEW),
    validate(accountQuerySchema, 'query'),
    asyncHandler(controller.listAccounts));

  // '/accounts/:id/ledger' is more specific than '/accounts/:id' — Express matches
  // in declaration order, so the static suffix routes are declared first.
  r.get('/accounts/:id/ledger',
    requirePermission(P.VIEW),
    validate(ledgerQuerySchema, 'query'),
    asyncHandler(controller.accountLedger));

  r.patch('/accounts/:id/active',
    requirePermission(P.EDIT),
    validate(setActiveSchema),
    asyncHandler(controller.setActive));

  r.get('/accounts/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getAccount));

  // ---- Trial balance (declare before '/journals/:id' is irrelevant — distinct prefix) ----
  r.get('/trial-balance/export',
    requirePermission(P.EXPORT),
    validate(trialBalanceQuerySchema, 'query'),
    asyncHandler(controller.exportTrialBalance));

  r.get('/trial-balance',
    requirePermission(P.VIEW),
    validate(trialBalanceQuerySchema, 'query'),
    asyncHandler(controller.trialBalance));

  // ---- Journals (immutable; post + reverse only, no update/delete) ----
  r.post('/journals',
    requirePermission(P.CREATE),
    validate(postJournalSchema),
    asyncHandler(controller.postJournal));

  r.get('/journals',
    requirePermission(P.VIEW),
    validate(journalQuerySchema, 'query'),
    asyncHandler(controller.listJournals));

  r.post('/journals/:id/reverse',
    requirePermission(P.EDIT),
    asyncHandler(controller.reverseJournal));

  r.get('/journals/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getJournal));

  // ---- Project cost ledger ----
  r.post('/costs',
    requirePermission(P.CREATE),
    validate(postCostSchema),
    asyncHandler(controller.postCost));

  r.get('/projects/:id/cost-summary',
    requirePermission(P.VIEW),
    asyncHandler(controller.projectCostSummary));

  return r;
}
