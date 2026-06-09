import { EnquirySource, EnquiryStatus } from './enquiry.constants';

/** A persisted enquiry row (camelCase projection of sales.enquiry). */
export interface Enquiry {
  enquiryId: number;
  enquiryNo: string;
  companyId: number;
  buId: number | null;
  customerName: string;
  contact: string | null;
  email: string | null;
  address: string | null;
  industry: string | null;
  source: EnquirySource | null;
  requirement: string | null;
  mobile: string | null;
  machineType: string | null;
  application: string | null;
  quantity: number | null;
  budget: number | null;
  salesExecutive: string | null;
  followUpDate: string | null;
  remarks: string | null;
  status: EnquiryStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface EnquiryListResult {
  rows: Enquiry[];
  total: number;
  page: number;
  pageSize: number;
}
