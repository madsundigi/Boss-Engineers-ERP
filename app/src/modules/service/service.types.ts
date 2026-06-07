import { ServiceTicketStatus, TicketPriority, ClaimStatus } from './service.constants';

/** A field visit on a ticket (camelCase projection of svc.field_visit). */
export interface FieldVisit {
  visitId?: number;
  engineerId: number | null;
  visitDate: string;
  hours: number | null;
  travelCost: number;
  notes: string | null;
}

/** A spare part issued against a ticket (camelCase projection of svc.spare_issue). */
export interface SpareIssue {
  spareIssueId?: number;
  itemId: number;
  qty: number;
  unitCost: number;
  isChargeable: boolean;
}

/** A persisted service-ticket row (camelCase projection of svc.service_ticket). */
export interface ServiceTicket {
  ticketId: number;
  ticketNo: string;
  companyId: number;
  buId: number | null;
  customerId: number;
  serialId: number | null;
  warrantyId: number | null;
  contractId: number | null;
  priority: TicketPriority;
  isInWarranty: boolean;
  reportedAt: string;
  slaDueAt: string | null;
  resolution: string | null;
  status: ServiceTicketStatus;
  assignedEngineerId: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  visits: FieldVisit[];
  spares: SpareIssue[];
}

/** A warranty-claim row (camelCase projection of svc.warranty_claim). */
export interface WarrantyClaim {
  claimId: number;
  warrantyId: number;
  ticketId: number | null;
  claimDate: string;
  claimCost: number;
  status: ClaimStatus;
  approvedBy: number | null;
}

export interface ServiceTicketListResult {
  rows: Omit<ServiceTicket, 'visits' | 'spares'>[];
  total: number;
  page: number;
  pageSize: number;
}
