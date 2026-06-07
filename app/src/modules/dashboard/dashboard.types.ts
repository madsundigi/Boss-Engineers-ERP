/**
 * Read-only projections for the CEO / Management Dashboard (M16).
 * Every numeric field is a JS number (SQL casts NUMERIC -> float8, or Number() in TS)
 * and every KPI is resilient to empty tables — a fresh company yields zeros, never null.
 */

/** Open sales pipeline: live enquiries + quotations and their indicative value. */
export interface SalesPipeline {
  openEnquiries: number;        // count of sales.enquiry with status='OPEN'
  openEnquiryValue: number;     // Σ sales.enquiry.target_value for those enquiries
  openQuotations: number;       // count of sales.quotation not in a terminal status
  openQuotationValue: number;   // Σ sales.quotation.total_price for those quotations
}

/** The full single-object KPI summary returned by GET /api/dashboard/kpis. */
export interface KpiSummary {
  salesPipeline: SalesPipeline;
  activeProjects: number;       // count of proj.project where status='ACTIVE'
  orderBook: number;            // Σ proj.project.contract_value for ACTIVE projects
  wipWorkOrders: number;        // count of mfg.work_order not in a terminal status
  dispatchesMtd: number;        // count of log.dispatch RELEASED this calendar month
  arOutstanding: number;        // Σ open invoice total_amount − Σ allocated receipts
  apOutstanding: number;        // Σ vendor_invoice total_amount not PAID/DISPUTED
  openNcrs: number;             // count of qms.ncr where status <> 'CLOSED'
  avgMarginPct: number;         // mean margin_pct over the latest snapshot per project
  deliveryAtRisk: number;       // projects whose latest forecast is risk_level='HIGH'
}

/** One stage of the sales funnel (GET /api/dashboard/sales-funnel). */
export interface FunnelRow {
  stage: string;                // ENQUIRY | QUOTATION | WON | PROJECT
  count: number;
}
