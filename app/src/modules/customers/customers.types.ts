import { CustomerType, CustomerStatus } from './customers.constants';

/**
 * A persisted customer (camelCase projection of mdm.customer, created in
 * db/01_security_master.sql).
 */
export interface Customer {
  customerId: number;
  companyId: number;
  customerCode: string;
  customerName: string;
  customerType: CustomerType;
  gstin: string | null;
  pan: string | null;
  creditLimit: number;
  paymentTermId: number | null;
  defaultCurrencyId: number;
  status: CustomerStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface CustomerListResult {
  rows: Customer[];
  total: number;
  page: number;
  pageSize: number;
}
