import { Request, Response } from 'express';
import { GlService } from './gl.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateAccountDto, SetActiveDto, AccountQueryDto, PostJournalDto, JournalQueryDto,
  TrialBalanceQueryDto, LedgerQueryDto, PostCostDto,
} from './gl.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class GlController {
  constructor(private readonly service: GlService) {}

  // -------- Chart of accounts --------
  createAccount = async (req: Request, res: Response) => {
    const created = await this.service.createAccount(ctxOf(req), valid<CreateAccountDto>(req));
    res.status(201).json(created);
  };

  listAccounts = async (req: Request, res: Response) => {
    res.json(await this.service.listAccounts(ctxOf(req), valid<AccountQueryDto>(req, 'query')));
  };

  getAccount = async (req: Request, res: Response) => {
    res.json(await this.service.getAccount(ctxOf(req), idOf(req)));
  };

  setActive = async (req: Request, res: Response) => {
    res.json(await this.service.setActive(ctxOf(req), idOf(req), valid<SetActiveDto>(req).isActive));
  };

  accountLedger = async (req: Request, res: Response) => {
    res.json(await this.service.accountLedger(ctxOf(req), idOf(req), valid<LedgerQueryDto>(req, 'query')));
  };

  // -------- Journals --------
  postJournal = async (req: Request, res: Response) => {
    const created = await this.service.postJournal(ctxOf(req), valid<PostJournalDto>(req));
    res.status(201).json(created);
  };

  listJournals = async (req: Request, res: Response) => {
    res.json(await this.service.listJournals(ctxOf(req), valid<JournalQueryDto>(req, 'query')));
  };

  getJournal = async (req: Request, res: Response) => {
    res.json(await this.service.getJournal(ctxOf(req), idOf(req)));
  };

  reverseJournal = async (req: Request, res: Response) => {
    const created = await this.service.reverseJournal(ctxOf(req), idOf(req));
    res.status(201).json(created);
  };

  // -------- Reads --------
  trialBalance = async (req: Request, res: Response) => {
    res.json(await this.service.trialBalance(ctxOf(req), valid<TrialBalanceQueryDto>(req, 'query')));
  };

  exportTrialBalance = async (req: Request, res: Response) => {
    const csv = await this.service.exportTrialBalanceCsv(ctxOf(req), valid<TrialBalanceQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="trial-balance.csv"');
    res.send(csv);
  };

  // -------- Project cost ledger --------
  postCost = async (req: Request, res: Response) => {
    const created = await this.service.postCost(ctxOf(req), valid<PostCostDto>(req));
    res.status(201).json(created);
  };

  projectCostSummary = async (req: Request, res: Response) => {
    res.json(await this.service.projectCostSummary(ctxOf(req), idOf(req)));
  };
}
