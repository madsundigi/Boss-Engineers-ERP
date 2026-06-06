import { QuoteStatus } from './quotation.constants';

export interface QuotationLine {
  lineId?: number;
  description: string;
  qty: number;
  unitPrice: number;
  lineAmount: number;
  isOptional: boolean;
}

export interface Quotation {
  quotationId: number;
  quotationNo: string;
  companyId: number;
  buId: number | null;
  enquiryId: number | null;
  currentRevision: number;
  subject: string | null;
  customerName: string;
  contact: string | null;
  email: string | null;
  quoteDate: string;
  validUntil: string | null;
  currencyCode: string;
  totalCost: number;
  totalPrice: number;
  discountPct: number;
  marginPct: number;
  status: QuoteStatus;
  sentAt: string | null;
  sentTo: string | null;
  pdfRef: string | null;
  createdAt: string;
  rowVersion: number;
  lines: QuotationLine[];
}

export interface QuotationRevision {
  revisionId: number;
  revNo: number;
  reason: string | null;
  snapshot: unknown;
  createdAt: string;
}

export interface QuotationListResult {
  rows: Omit<Quotation, 'lines'>[];
  total: number;
  page: number;
  pageSize: number;
}
