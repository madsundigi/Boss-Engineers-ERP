// Navigation + resource registry. Each resource is a list view backed by a real
// API endpoint; the generic ResourceList renders columns (auto-derived from the
// first row unless overridden). Routes are keyed by `path`.

export interface ResourceDef {
  path: string;       // route segment, unique
  label: string;      // sidebar + page title
  endpoint: string;   // API list endpoint (GET)
  /** explicit columns; when omitted, derived from the first row's scalar keys */
  columns?: { key: string; label: string; kind?: 'num' | 'mono' | 'status' | 'date' }[];
  /** the row's primary-key field (e.g. 'enquiryId'); derived from the row when omitted */
  idKey?: string;
}

export interface NavSection {
  label: string;
  items: ResourceDef[];
}

export const SECTIONS: NavSection[] = [
  {
    label: 'Sales & CRM',
    items: [
      { path: 'enquiries', label: 'Enquiries', endpoint: '/api/enquiries', idKey: 'enquiryId' },
      { path: 'opportunities', label: 'Opportunities', endpoint: '/api/crm/opportunities', idKey: 'oppId' },
      { path: 'quotations', label: 'Quotations', endpoint: '/api/quotations', idKey: 'quotationId' },
      { path: 'contracts', label: 'Contracts', endpoint: '/api/contracts' },
    ],
  },
  {
    label: 'Projects',
    items: [
      { path: 'projects', label: 'Projects', endpoint: '/api/projects', idKey: 'projectId' },
      { path: 'change-orders', label: 'Change Orders', endpoint: '/api/change-orders', idKey: 'changeOrderId' },
      { path: 'delivery-forecasts', label: 'Delivery Forecasts', endpoint: '/api/delivery-forecasts', idKey: 'forecastId' },
    ],
  },
  {
    label: 'Supply Chain',
    items: [
      { path: 'purchase-requisitions', label: 'Purchase Requisitions', endpoint: '/api/procurement/purchase-requisitions' },
      { path: 'purchase-orders', label: 'Purchase Orders', endpoint: '/api/procurement/purchase-orders' },
      { path: 'grn', label: 'Goods Receipts', endpoint: '/api/procurement/grn' },
      { path: 'stock', label: 'Stock', endpoint: '/api/inventory/stock' },
      { path: 'critical-items', label: 'Critical Items', endpoint: '/api/inventory/critical-items' },
      { path: 'subcontracts', label: 'Subcontracts', endpoint: '/api/subcontracts' },
      { path: 'boms', label: 'Bills of Material', endpoint: '/api/boms', idKey: 'bomId' },
    ],
  },
  {
    label: 'Production & Quality',
    items: [
      { path: 'work-orders', label: 'Work Orders', endpoint: '/api/work-orders' },
      { path: 'fat', label: 'FAT', endpoint: '/api/fat' },
      { path: 'inspections', label: 'Inspections', endpoint: '/api/inspections' },
      { path: 'ncrs', label: 'NCR / CAPA', endpoint: '/api/ncrs' },
      { path: 'documents', label: 'Documents (DMS)', endpoint: '/api/documents', idKey: 'docId' },
    ],
  },
  {
    label: 'Logistics & Service',
    items: [
      { path: 'dispatch', label: 'Dispatch', endpoint: '/api/dispatch' },
      { path: 'installations', label: 'Installations', endpoint: '/api/installations' },
      { path: 'service-tickets', label: 'Service Tickets', endpoint: '/api/service-tickets' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { path: 'invoices', label: 'Invoices (AR)', endpoint: '/api/invoices', idKey: 'invoiceId' },
      { path: 'receipts', label: 'Receipts', endpoint: '/api/invoices/receipts' },
      { path: 'ap-invoices', label: 'AP Invoices', endpoint: '/api/ap-invoices' },
      { path: 'gl-journals', label: 'GL Journals', endpoint: '/api/gl/journals' },
      { path: 'gl-accounts', label: 'Chart of Accounts', endpoint: '/api/gl/accounts' },
      { path: 'tax', label: 'Tax Transactions', endpoint: '/api/tax/transactions' },
      { path: 'profitability', label: 'Profitability', endpoint: '/api/profitability' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: 'employees', label: 'Employees', endpoint: '/api/hr/employees' },
      { path: 'leave', label: 'Leave', endpoint: '/api/hr/leaves' },
      { path: 'allocations', label: 'Workload', endpoint: '/api/workload/allocations' },
    ],
  },
];

export const RESOURCES: ResourceDef[] = SECTIONS.flatMap((s) => s.items);
export function findResource(path: string): ResourceDef | undefined {
  return RESOURCES.find((r) => r.path === path);
}

// ---- Create forms ---------------------------------------------------------
export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'select';
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
}

/** One column in a repeatable line-item editor (header + N lines documents). */
export interface LineField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  required?: boolean;
  options?: readonly string[];
}

/** A line-item document: header fields (FORMS) + a repeatable line array. */
export interface DocFormDef {
  /** payload key the line rows are nested under (e.g. 'lines') */
  lineKey: string;
  /** columns of the repeatable line editor */
  lineFields: LineField[];
  /** require at least one line on submit (mirrors the backend `.min(1)`) */
  minLines?: number;
}

const ENQUIRY_SOURCE = ['EMAIL', 'WEB', 'PHONE', 'WALKIN', 'REP', 'REFERRAL', 'EXHIBITION', 'OTHER'];
const RISK_CATEGORY = ['SCHEDULE', 'COST', 'QUALITY', 'SUPPLY', 'SAFETY', 'COMMERCIAL', 'TECHNICAL'];
const RISK_LEVEL = ['LOW', 'MEDIUM', 'HIGH'];
const DRIVER = ['MATERIAL', 'CAPACITY', 'SCHEDULE', 'QUALITY'];
const EMPLOYEE_STATUS = ['ACTIVE', 'INACTIVE', 'LEFT'];
const INCIDENT_TYPE = ['INJURY', 'NEARMISS', 'SPILL', 'FIRE', 'PROPERTY', 'OTHER'];
const INCIDENT_SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const BOM_TYPE = ['EBOM', 'MBOM']; // mirrors app bom.constants BOM_TYPE

/** Create-form field configs, keyed by resource path. Fields map 1:1 to the
 *  module's create DTO; FK references are entered as numeric ids (visible in
 *  their own list screens). Modules without an entry are list/view-only. */
export const FORMS: Record<string, FormField[]> = {
  enquiries: [
    { name: 'customerName', label: 'Customer Name', required: true },
    { name: 'contact', label: 'Contact Person' },
    { name: 'mobile', label: 'Mobile' },
    { name: 'email', label: 'Email' },
    { name: 'industry', label: 'Industry' },
    { name: 'machineType', label: 'Machine Type' },
    { name: 'application', label: 'Application' },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'budget', label: 'Budget', type: 'number' },
    { name: 'source', label: 'Source', type: 'select', options: ENQUIRY_SOURCE },
    { name: 'salesExecutive', label: 'Assigned Sales Executive' },
    { name: 'followUpDate', label: 'Follow-Up Date', type: 'date' },
    { name: 'requirement', label: 'Requirement', type: 'textarea' },
    { name: 'address', label: 'Address', type: 'textarea' },
    { name: 'remarks', label: 'Remarks', type: 'textarea' },
  ],
  projects: [
    { name: 'projectName', label: 'Project Name', required: true },
    { name: 'customerId', label: 'Customer ID', type: 'number', required: true },
    { name: 'pmUserId', label: 'PM User ID', type: 'number', required: true },
    { name: 'contractValue', label: 'Contract Value', type: 'number' },
    { name: 'budgetCost', label: 'Budget Cost', type: 'number' },
    { name: 'plannedStart', label: 'Planned Start', type: 'date' },
    { name: 'plannedEnd', label: 'Planned End', type: 'date' },
  ],
  'change-orders': [
    { name: 'projectId', label: 'Project ID', type: 'number', required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'reason', label: 'Reason', type: 'textarea' },
    { name: 'costImpact', label: 'Cost Impact', type: 'number' },
    { name: 'priceImpact', label: 'Price Impact', type: 'number' },
    { name: 'scheduleImpactDays', label: 'Schedule Impact (days)', type: 'number' },
  ],
  'delivery-forecasts': [
    { name: 'projectId', label: 'Project ID', type: 'number', required: true },
    { name: 'predictedDelivery', label: 'Predicted Delivery', type: 'date', required: true },
    { name: 'committedDelivery', label: 'Committed Delivery', type: 'date' },
    { name: 'riskLevel', label: 'Risk Level', type: 'select', options: RISK_LEVEL },
    { name: 'driver', label: 'Driver', type: 'select', options: DRIVER },
  ],
  risks: [
    { name: 'projectId', label: 'Project ID', type: 'number', required: true },
    { name: 'title', label: 'Title', required: true },
    { name: 'category', label: 'Category', type: 'select', options: RISK_CATEGORY },
    { name: 'likelihood', label: 'Likelihood (1-5)', type: 'number', required: true },
    { name: 'impact', label: 'Impact (1-5)', type: 'number', required: true },
    { name: 'mitigation', label: 'Mitigation', type: 'textarea' },
    { name: 'dueDate', label: 'Due Date', type: 'date' },
  ],
  employees: [
    { name: 'empCode', label: 'Employee Code', required: true },
    { name: 'fullName', label: 'Full Name', required: true },
    { name: 'departmentId', label: 'Department ID', type: 'number' },
    { name: 'designationId', label: 'Designation ID', type: 'number' },
    { name: 'costRate', label: 'Cost Rate', type: 'number' },
    { name: 'billingRate', label: 'Billing Rate', type: 'number' },
    { name: 'doj', label: 'Date of Joining', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: EMPLOYEE_STATUS },
  ],
  spares: [
    { name: 'partCode', label: 'Part Code', required: true },
    { name: 'partName', label: 'Part Name', required: true },
    { name: 'uom', label: 'UoM' },
    { name: 'unitPrice', label: 'Unit Price', type: 'number' },
    { name: 'reorderLevel', label: 'Reorder Level', type: 'number' },
  ],
  ehs: [
    { name: 'incidentType', label: 'Incident Type', type: 'select', options: INCIDENT_TYPE, required: true },
    { name: 'severity', label: 'Severity', type: 'select', options: INCIDENT_SEVERITY },
    { name: 'location', label: 'Location' },
    { name: 'projectId', label: 'Project ID', type: 'number' },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'correctiveAction', label: 'Corrective Action', type: 'textarea' },
  ],
  // ---- line-item documents (header fields; lines live in DOC_FORMS) --------
  quotations: [
    { name: 'customerName', label: 'Customer Name', required: true },
    { name: 'subject', label: 'Subject' },
    { name: 'contact', label: 'Contact Person' },
    { name: 'email', label: 'Email' },
    { name: 'currencyCode', label: 'Currency Code', placeholder: 'INR' },
    { name: 'validUntil', label: 'Valid Until', type: 'date' },
    { name: 'totalCost', label: 'Total Cost', type: 'number' },
    { name: 'discountPct', label: 'Discount %', type: 'number' },
    { name: 'taxPct', label: 'Tax %', type: 'number' },
    { name: 'deliveryTerms', label: 'Delivery Terms' },
    { name: 'paymentTerms', label: 'Payment Terms' },
    { name: 'warrantyTerms', label: 'Warranty Terms' },
    { name: 'enquiryId', label: 'Enquiry ID', type: 'number' },
  ],
  invoices: [
    { name: 'customerId', label: 'Customer ID', type: 'number', required: true },
    { name: 'projectId', label: 'Project ID', type: 'number' },
    { name: 'milestoneId', label: 'Milestone ID', type: 'number' },
    { name: 'currencyId', label: 'Currency ID', type: 'number' },
    { name: 'invoiceDate', label: 'Invoice Date', type: 'date' },
  ],
  boms: [
    { name: 'parentItemId', label: 'Parent Item ID', type: 'number', required: true },
    { name: 'bomType', label: 'BOM Type', type: 'select', options: BOM_TYPE, required: true },
    { name: 'revision', label: 'Revision', required: true },
    { name: 'projectId', label: 'Project ID', type: 'number' },
    { name: 'effectiveFrom', label: 'Effective From', type: 'date' },
  ],
  opportunities: [
    { name: 'customerId', label: 'Customer ID', type: 'number', required: true },
    { name: 'title', label: 'Title', required: true },
    { name: 'enquiryId', label: 'Enquiry ID', type: 'number' },
    { name: 'estValue', label: 'Est. Value', type: 'number' },
    { name: 'probabilityPct', label: 'Probability %', type: 'number' },
    { name: 'expectedCloseDate', label: 'Expected Close', type: 'date' },
  ],
  documents: [
    { name: 'title', label: 'Title', required: true },
    { name: 'category', label: 'Category', type: 'select',
      options: ['DRAWING', 'SPEC', 'CERTIFICATE', 'CONTRACT', 'REPORT', 'MANUAL', 'OTHER'] },
    { name: 'entityType', label: 'Linked Entity', placeholder: 'PROJECT, DISPATCH…' },
    { name: 'entityId', label: 'Linked Entity ID', type: 'number' },
  ],
};

/** Line-item editor configs, keyed by resource path. Mirrors each module's
 *  create DTO `lines` array; FK references are numeric-id inputs. */
export const DOC_FORMS: Record<string, DocFormDef> = {
  quotations: {
    lineKey: 'lines',
    minLines: 1,
    lineFields: [
      { name: 'description', label: 'Description', required: true },
      { name: 'qty', label: 'Qty', type: 'number', required: true },
      { name: 'unitPrice', label: 'Unit Price', type: 'number', required: true },
    ],
  },
  invoices: {
    lineKey: 'lines',
    minLines: 1,
    lineFields: [
      { name: 'description', label: 'Description', required: true },
      { name: 'qty', label: 'Qty', type: 'number', required: true },
      { name: 'unitRate', label: 'Unit Rate', type: 'number', required: true },
      { name: 'taxCodeId', label: 'Tax Code ID', type: 'number' },
    ],
  },
  boms: {
    lineKey: 'lines',
    // backend allows a BOM to be drafted with no lines; require none here.
    lineFields: [
      { name: 'componentItemId', label: 'Component Item ID', type: 'number', required: true },
      { name: 'qtyPer', label: 'Qty Per', type: 'number', required: true },
      { name: 'uomId', label: 'UoM ID', type: 'number', required: true },
      { name: 'scrapPct', label: 'Scrap %', type: 'number' },
    ],
  },
};

export function docFormFor(path: string): DocFormDef | undefined {
  return DOC_FORMS[path];
}

export function formFor(path: string): FormField[] | undefined {
  return FORMS[path];
}

/** Foreign-key-looking id fields that must never be treated as a row's own PK. */
function looksForeign(key: string): boolean {
  return /^(customer|company|bu|branch|tenant|created|updated|pm|user|parent|component|uom|tax|currency|milestone|department|designation|enquiry)/i.test(key);
}

/**
 * Resolve a row's primary key value. Prefers an explicit `def.idKey`; otherwise
 * derives it: the path's singular-ish name + 'Id' if present, else the first key
 * ending in 'Id' that doesn't look like a foreign key, else the first 'Id' key.
 */
export function idOf(row: Record<string, unknown>, def: ResourceDef): unknown {
  if (def.idKey && row[def.idKey] != null) return row[def.idKey];
  const keys = Object.keys(row);
  // singular-ish guess from the path: 'quotations' -> 'quotationId'
  const singular = def.path.replace(/-/g, '').replace(/s$/, '') + 'Id';
  const exact = keys.find((k) => k.toLowerCase() === singular.toLowerCase());
  if (exact) return row[exact];
  const idKeys = keys.filter((k) => /Id$/.test(k));
  const own = idKeys.find((k) => !looksForeign(k));
  return row[own ?? idKeys[0] ?? ''];
}
