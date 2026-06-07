// Navigation + resource registry. Each resource is a list view backed by a real
// API endpoint; the generic ResourceList renders columns (auto-derived from the
// first row unless overridden). Routes are keyed by `path`.

export interface ResourceDef {
  path: string;       // route segment, unique
  label: string;      // sidebar + page title
  endpoint: string;   // API list endpoint (GET)
  /** explicit columns; when omitted, derived from the first row's scalar keys */
  columns?: { key: string; label: string; kind?: 'num' | 'mono' | 'status' | 'date' }[];
}

export interface NavSection {
  label: string;
  items: ResourceDef[];
}

export const SECTIONS: NavSection[] = [
  {
    label: 'Sales & CRM',
    items: [
      { path: 'enquiries', label: 'Enquiries', endpoint: '/api/enquiries' },
      { path: 'quotations', label: 'Quotations', endpoint: '/api/quotations' },
      { path: 'contracts', label: 'Contracts', endpoint: '/api/contracts' },
    ],
  },
  {
    label: 'Projects',
    items: [
      { path: 'projects', label: 'Projects', endpoint: '/api/projects' },
      { path: 'change-orders', label: 'Change Orders', endpoint: '/api/change-orders' },
      { path: 'delivery-forecasts', label: 'Delivery Forecasts', endpoint: '/api/delivery-forecasts' },
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
      { path: 'boms', label: 'Bills of Material', endpoint: '/api/boms' },
    ],
  },
  {
    label: 'Production & Quality',
    items: [
      { path: 'work-orders', label: 'Work Orders', endpoint: '/api/work-orders' },
      { path: 'fat', label: 'FAT', endpoint: '/api/fat' },
      { path: 'inspections', label: 'Inspections', endpoint: '/api/inspections' },
      { path: 'ncrs', label: 'NCR / CAPA', endpoint: '/api/ncrs' },
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
      { path: 'invoices', label: 'Invoices (AR)', endpoint: '/api/invoices' },
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
