import { ItemType } from './items.constants';

/**
 * A persisted catalog item (camelCase projection of mdm.item). Only the practical,
 * user-facing master fields are exposed here; the table's costing/valuation columns
 * (std_cost, valuation_method, abc_class, is_serialized, is_batch_tracked,
 * lead_time_days) are managed elsewhere and left at their DB defaults on create.
 *
 * hsnSacId is the optional FK to mdm.hsn_sac (the HSN/SAC tax-code master). The
 * table stores the HSN as a foreign key (hsn_sac_id), not as a free-text code, so
 * the API surfaces the id.
 */
export interface Item {
  itemId: number;
  companyId: number;
  itemCode: string;
  itemName: string;
  categoryId: number;
  type: ItemType;
  baseUomId: number;
  hsnSacId: number | null;
  isCritical: boolean;
  reorderLevel: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface ItemListResult {
  rows: Item[];
  total: number;
  page: number;
  pageSize: number;
}
