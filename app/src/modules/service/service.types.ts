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
  complaint: string | null;
  priority: TicketPriority;
  isInWarranty: boolean;
  reportedAt: string;
  slaDueAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  csatRating: number | null;
  status: ServiceTicketStatus;
  assignedEngineerId: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  visits: FieldVisit[];
  spares: SpareIssue[];
}

/**
 * A single ticket with the derived Service Cost figure (the ticket-detail read).
 * `serviceCost` is computed at read time — NOT a stored column — as the sum of
 * field-visit travel cost + spare-part value (qty * unit_cost) for the ticket.
 */
export interface ServiceTicketDetail extends ServiceTicket {
  serviceCost: number;
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

/**
 * Read-only Warranty & Service KPI summary (GET /api/service-tickets/kpis).
 * Every field is a JS number (SQL casts NUMERIC -> float8, COALESCEd to 0) so a
 * company with no tickets yields a fully-populated zero object, never null/NaN.
 * `windowDays` echoes the requested rolling window (omitted when an explicit
 * from/to range — or no filter — was used).
 */
export interface ServiceKpis {
  windowDays?: number;       // rolling window in days, if ?windowDays was used
  mttrHours: number;         // mean (resolved_at - reported_at) in hours, resolved tickets
  slaCompliancePct: number;  // 100 * resolved-on-or-before-SLA / resolved-with-an-SLA
  csatAvg: number;           // mean csat_rating (1..5) over rated tickets
  csatCount: number;         // number of tickets that carry a csat_rating
  firstTimeFixPct: number;   // 100 * resolved-with-exactly-one-visit / resolved
  resolvedCount: number;     // tickets in status RESOLVED or CLOSED
  openCount: number;         // tickets in any other (non-resolved) status
  totalTickets: number;      // all (non-deleted) tickets in the window
}

/** Company-wide warranty/after-sales spend totals (the report header figures). */
export interface WarrantyCostTotals {
  tickets: number;           // all (non-deleted) tickets in the window
  inWarrantyTickets: number; // subset flagged is_in_warranty
  travelCost: number;        // SUM(field_visit.travel_cost)
  spareCost: number;         // SUM(spare_issue.qty * unit_cost)
  claimCost: number;         // SUM(warranty_claim.claim_cost)
  totalCost: number;         // travelCost + spareCost + claimCost
}

/** Per-customer warranty cost driver (descending by totalCost). */
export interface WarrantyCostByCustomer {
  customerId: number;
  customerName: string | null; // mdm.customer.customer_name (null if the customer is gone)
  tickets: number;
  totalCost: number;
}

/** Per-month warranty spend, bucketed on reported_at (chronological). */
export interface WarrantyCostByMonth {
  month: string;  // 'YYYY-MM'
  tickets: number;
  totalCost: number;
}

/**
 * Read-only Warranty Cost Analysis report (GET /api/service-tickets/warranty-cost).
 * Aggregates the three per-ticket cost fragments the ticket-detail serviceCost
 * sums (field-visit travel + spare-part value) PLUS the warranty-claim cost, so
 * management can analyse warranty/after-sales spend. Every figure is a JS number
 * (SQL COALESCEs NUMERIC -> 0); an empty company yields zero totals and empty
 * breakdowns, never null/NaN/throw.
 */
export interface WarrantyCostReport {
  totals: WarrantyCostTotals;
  byCustomer: WarrantyCostByCustomer[]; // top cost drivers, totalCost desc
  byMonth: WarrantyCostByMonth[];       // reported_at month, ascending
}
