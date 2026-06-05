# RBAC & Permissions — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-RBAC-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Implementation | `db/08_rbac.sql` |
| Status | Verified on PostgreSQL 16 — 12 roles, 234 permissions, 534 grants, 10 SoD rules |

Roles: CEO, Admin, Sales, Purchase, Stores, Production, Planning, QC, Installation, Service, Finance, HR.
Actions: View (V), Create (C), Edit (E), Delete (D), Approve (A), Export (X).

---

## 1. Principles
1. **Deny by default** — nothing is permitted without an explicit role grant.
2. **Least privilege** — each role gets only what its function requires.
3. **Separation of Duties** — capability is in the role; **creator ≠ approver** is enforced per-user by the approval engine + DOA, not by role.
4. **Admin ≠ business approver** — `ADMIN` administers security/config only; holds no business APPROVE (verified: 0 business-approve grants).
5. **CEO is read + approve, not operate** — VIEW/EXPORT all, top-tier APPROVE, no CREATE/EDIT/DELETE (verified: 0 C/E/D grants).
6. **Data-level scoping** layered on action-level grants (Section 6).
7. **Audit is append-only for all** — no role can EDIT/DELETE `audit.*` (enforced at DB).

## 2. Action Semantics
| Action | Meaning |
|---|---|
| View | Read records (within data scope) |
| Create | Insert (usually DRAFT) |
| Edit | Modify in editable states |
| Delete | Soft-delete / void DRAFT only |
| Approve | Authorize at a workflow gate (bounded by DOA value limits) |
| Export | Download / print / report (PII & financials restricted) |

## 3. Permission Matrix
Codes: `V C E D A X`; `·` = none. Role columns: CEO · ADM · SAL · PUR · STO · PRD · PLN · QC · INS · SVC · FIN · HR.

### Master Data
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Customer | VX | VCEDX | VCEX | · | · | · | V | · | V | VX | VX | · |
| Vendor | VX | VCEDX | · | VCEX | V | · | · | V | · | V | VX | · |
| Item | VX | VCEDX | V | V | VCE | V | VCE | V | · | V | V | · |
| BOM | V | VCEDX | · | V | · | VCE | VCE | V | · | V | · | · |
| Employee (PII) | VX | VCEDX | · | · | · | · | V | · | · | · | V | VCEDX |

### Sales & Project
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Enquiry | VX | V | VCEDX | · | · | · | V | · | · | · | · | · |
| Quotation | VAX | V | VCEDX | · | · | · | V | · | · | · | VAX | · |
| Project | VAX | V | V | V | V | V | VCEX | V | V | V | VAX | V |
| Planning/Gantt | VX | V | · | V | · | V | VCEDAX | · | V | · | V | V |
| Change Order | VAX | V | VC | · | · | V | VCEX | · | · | · | VAX | · |
| Delivery Forecast | VX | V | V | · | · | V | VCEX | · | · | · | V | · |

### Procurement & Inventory
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Purchase Requisition | VX | V | · | VCEDAX | VC | VC | VC | · | · | VC | V | · |
| Purchase Order | VAX | V | · | VCEDAX | V | V | V | · | · | · | VX | · |
| GRN | VX | V | V | VCEDAX | · | · | · | VE | · | · | VX | · |
| Inventory/Stock | VX | V | · | V | VCEDAX | V | V | V | V | V | VAX | · |
| Material Issue | VX | V | · | · | VCEDAX | VC | V | · | · | · | V | · |
| Critical Item | VX | V | · | VCEAX | VE | V | VCE | · | · | · | V | · |

### Production & HCM
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Work Order | VX | V | · | · | V | VCEDAX | VC | V | · | · | V | · |
| Production Conf. | VX | V | · | · | V | VCEDX | V | V | · | · | V | · |
| Workload/Capacity | VX | V | · | · | · | VE | VCEX | · | · | · | V | VCEAX |
| Timesheet | VX | V | C | C | C | VCA | VCA | C | C | C | VX | VCEDAX |

### Quality, Dispatch, Service
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FAT | VX | V | V | · | · | V | V | VCEDAX | V | · | · | · |
| NCR / RCA / CAPA | VX | V | · | V | VC | VC | V | VCEDAX | VC | VC | V | · |
| Dispatch | VX | V | V | · | VCEX | V | V | VA | V | V | VAX | · |
| Installation / SAT | VX | V | V | · | · | V | V | V | VCEDAX | V | V | · |
| Warranty | VX | V | V | · | · | · | · | V | V | VCEDAX | VX | · |
| Service Ticket | VX | V | V | · | · | · | · | V | V | VCEDAX | V | · |

### Finance & Administration
| Module | CEO | ADM | SAL | PUR | STO | PRD | PLN | QC | INS | SVC | FIN | HR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Invoice (AR) | VX | V | V | · | · | · | V | · | · | V | VCEDAX | · |
| Vendor Invoice (AP) | VX | V | · | V | · | · | · | · | · | · | VCEDAX | · |
| GL / Journals | VX | V | · | · | · | · | · | · | · | · | VCEDAX | · |
| Profitability | VX | V | · | · | · | · | VA | · | · | · | VCEAX | · |
| Tax / GST | VX | V | · | · | · | · | · | · | · | · | VCEDAX | · |
| Dashboard | VX | V | V | V | V | V | V | V | V | V | VX | V |
| Reports | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX | VX |
| User Mgmt | V | VCEDAX | · | · | · | · | · | · | · | · | · | · |
| Role / Permission | V | VCEDAX | · | · | · | · | · | · | · | · | · | · |
| Approval Config (DOA) | VA | VCEDX | · | · | · | · | · | · | · | · | V | · |
| Audit Log | VX | VX | · | · | · | · | · | V | · | · | VX | V |
| System Config | V | VCEDX | · | · | · | · | · | · | · | · | V | · |

## 4. Approval Authority (holders of **A**, bounded by DOA limits)
| Document | Approver role(s) |
|---|---|
| Quotation (margin/discount) | FINANCE → CEO (by band) |
| Project budget / charter | FINANCE + CEO |
| Schedule baseline / re-plan | PLANNING |
| Change Order | FINANCE + CEO |
| Purchase Requisition | PURCHASE |
| Purchase Order | PURCHASE → CEO (by value) |
| GRN posting | STORES |
| Stock write-off | STORES + FINANCE |
| Work-order release | PRODUCTION |
| Timesheet | PRODUCTION / PLANNING (mgr) + HR |
| FAT sign-off | QC |
| Dispatch clearance | QC + FINANCE (multi-gate) |
| SAT / acceptance | INSTALL |
| Warranty claim | SERVICE |
| CAPA closure | QC |
| Invoice / AP / GL / Tax | FINANCE |
| Project financial close | FINANCE + PLANNING (PM) |

## 5. Segregation of Duties
A role may hold both CREATE and APPROVE (so small teams function), but the approval engine blocks a user from approving what they created, and DOA forces a higher-level approver above thresholds. Seeded in `sec.sod_conflict`; detected by `sec.v_user_sod_violations` (a user holding both sides of a conflict via combined roles). Conflicts include: `PO.CREATE↔PO.APPROVE`, `PR.CREATE↔PR.APPROVE`, `VENDOR.CREATE↔PO.APPROVE`, `AP_INVOICE.CREATE↔AP_INVOICE.APPROVE`, `INVOICE.CREATE↔INVOICE.APPROVE`, `INVENTORY.EDIT↔INVENTORY.APPROVE`, `TIMESHEET.CREATE↔TIMESHEET.APPROVE`, `GRN.CREATE↔PO.APPROVE`, `USER_MGMT.CREATE↔QUOTATION.APPROVE`, `WORK_ORDER.CREATE↔WORK_ORDER.APPROVE`.

## 6. Data Scope (row-level, layered on the matrix)
- **Company** isolation via `company_id`; **branch** via `bu_id` (PostgreSQL Row-Level Security).
- **Sales** → own customers/territory · **Planning/PM** → own projects · **Service** → own region tickets · **Purchase** → POs within plant · **HR** → employee PII restricted to HR + Admin · **Finance** → all financials company-wide · **CEO** → all (read/export).

## 7. Data Model & Enforcement
`sec.app_user → sec.user_role → sec.role → sec.role_permission → sec.permission` (perm_code = `MODULE.ACTION`). A user's effective permission set is the union across assigned roles. Helper views: `sec.v_role_permission` (role→permission report), `sec.v_user_sod_violations` (SoD detection). The application checks `MODULE.ACTION` before every operation; the DB enforces grants, RLS, and append-only audit independently (defence in depth).

## 8. Verification (PostgreSQL 16)
- Roles **12**, permissions **234** (39 modules × 6 actions), grants **534**, SoD rules **10**.
- **CEO** Create/Edit/Delete grants = **0** (least privilege upheld).
- **ADMIN** business-approve grants = **0** (security-only; no god-mode).
- Multi-gate **Dispatch** approval resolves to **QC + FINANCE**; **PO** approval to **PURCHASE + CEO**; **Quotation** to **FINANCE + CEO**.
- `v_user_sod_violations` = **0** (clean baseline; fires when a user is assigned conflicting roles).
