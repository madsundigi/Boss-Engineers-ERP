import { ContractStatus, MilestoneStatus } from './contract.constants';

/** A billing milestone (camelCase projection of sales.contract_milestone). */
export interface ContractMilestone {
  milestoneId?: number;
  name: string;
  milestonePct: number | null;
  amount: number;
  dueDate: string | null;
  status: MilestoneStatus;
  sortOrder: number | null;
}

/**
 * A persisted commercial customer contract with its billing milestones
 * (camelCase projection of sales.customer_contract + sales.contract_milestone).
 */
export interface Contract {
  contractId: number;
  contractNo: string;
  companyId: number;
  buId: number | null;
  customerId: number;
  projectId: number | null;
  title: string | null;
  contractValue: number;
  currencyId: number | null;
  paymentTerms: string | null;
  ldPenaltyPct: number;
  ldCapPct: number;
  warrantyMonths: number;
  startDate: string | null;
  endDate: string | null;
  status: ContractStatus;
  signedDate: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  milestones: ContractMilestone[];
}

export interface ContractListResult {
  rows: Omit<Contract, 'milestones'>[];
  total: number;
  page: number;
  pageSize: number;
}
