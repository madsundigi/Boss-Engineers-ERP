/**
 * Read-only projections for the Central Search Engine. Every entity type produces
 * lightweight `SearchHit` rows (just enough to render a result row and deep-link),
 * grouped by entity type. The shape is resilient to empty data — an unmatched or
 * unpermitted entity simply yields no group.
 */

/** The cross-entity kinds the global search spans. */
export type SearchEntityType =
  | 'enquiry'
  | 'quotation'
  | 'project'
  | 'serial'
  | 'service_ticket'
  | 'customer';

/** One lightweight search result row (document/record summary + optional deep-link). */
export interface SearchHit {
  id: number;            // primary key of the underlying record
  no: string;            // document number / code (enquiry_no, customer_code, serial_no, ...)
  title: string;         // human-friendly name (customer_name / project_name / serial_no / ...)
  subtitle: string | null; // secondary line, e.g. status (nullable)
  path: string | null;   // frontend deep-link segment (e.g. 'enquiries'), or null if none
}

/** Hits for a single entity type, with a display label. */
export interface SearchGroup {
  type: SearchEntityType;
  label: string;         // e.g. 'Enquiries', 'Service Tickets'
  hits: SearchHit[];
}

/** The full response for GET /api/search. */
export interface SearchResults {
  query: string;         // the (trimmed) term that was searched
  groups: SearchGroup[]; // non-empty groups only
  total: number;         // sum of hits across all groups
}
