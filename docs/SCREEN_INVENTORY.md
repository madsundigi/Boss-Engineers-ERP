# Screen Inventory & Navigation Map — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-UX-002 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Builds on | docs/DESIGN_SYSTEM.md (components), docs/RBAC.md (who sees what), docs/FRD.md (modules) |
| Status | Baseline |

Complete inventory of every screen across all 16 modules + foundation/admin, each defined as six archetypes (List, Create, Edit, Detail, Approval, Dashboard), plus the global navigation map. Where an archetype does not apply to a module it is marked **N/A** with the reason — screens are not invented to fill a grid.

---

## 1. Conventions

### 1.1 Canonical routes (entity = the module's primary document)
| Archetype | Route | Notes |
|---|---|---|
| List | `/{entity}` | filters/sort/search persisted in URL query |
| Create | `/{entity}/new` | full page; quick-create may use a modal |
| Detail | `/{entity}/{id}` | read view + action bar |
| Edit | `/{entity}/{id}/edit` | same form as Create, pre-filled |
| Approval | `/{entity}/{id}/approve` | also aggregated in `/approvals` inbox |
| Dashboard | `/{domain}/dashboard` | domain-level, not per-record |

### 1.2 Archetype → design-system components
- **List** → page head + filter bar + `erp-card` table (toolbar, bulk-action bar, sortable sticky header, status badges, pagination).
- **Create / Edit** → `erp-form` (sections, 12-col grid, required markers, inline validation, sticky action footer). Quick-create = `erp-modal`.
- **Detail** → page head + status badge + panels/tabs: definition lists, related-record tables, **activity/audit timeline** (from the audit system), contextual action bar.
- **Approval** → `erp-approval` (sticky action bar with Approve/Reject + reason, document detail, **decision timeline** reflecting the DOA chain).
- **Dashboard** → KPI tiles + panels with charts; read-only, drill-through links.

### 1.3 Global / shared screens (outside any single module)
| Screen | Route | Purpose |
|---|---|---|
| Login | `/login` | auth; emits LOGIN audit event |
| Global search results | `/search?q=` | jump to any record (topbar search) |
| **Approvals Inbox** | `/approvals` | unified queue of all pending approvals across modules, routed by RBAC + DOA |
| Notifications center | `/notifications` | alerts/mentions/SLA breaches |
| My profile / settings | `/me` | preferences, density, sessions |
| Empty / 404 / 403 | — | empty-state, not-found, access-denied patterns |

---

## 2. Module Screen Inventory

> Each table: Screen · Route · Purpose & key components · Primary actions · Roles (RBAC codes).

### M01 — Customer Enquiry  (domain: Sales)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/enquiries` | Enquiry register; filter by status/source/date; columns incl. status badge | New, Export, bulk-assign | SAL, CEO(V) |
| Create | `/enquiries/new` | Capture form: customer, scope/spec, target budget/date, source, attachments | Save draft, Qualify | SAL |
| Edit | `/enquiries/:id/edit` | Amend captured enquiry | Save | SAL |
| Detail | `/enquiries/:id` | Summary, attachments, activity timeline; **Convert → Quotation**; mark Lost (reason) | Convert, Mark Lost | SAL, PLN(V) |
| Approval | `/enquiries/:id/approve` | Light qualification sign-off (strategic/high-value only) | Approve/Reject | SAL(lead), CEO |
| Dashboard | `/sales/dashboard` | Funnel (enquiry→quote→win), source conversion, response-time | drill-through | SAL, CEO, FIN |

### M02 — Quotation  (domain: Sales)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/quotations` | Quotes with status (draft/sent/won/lost), margin, validity | New, Export | SAL, FIN(V), CEO(V) |
| Create | `/quotations/new` | **Cost sheet** (material/labour/bought-out/freight/contingency) + pricing + line items + T&C | Save, Submit for approval | SAL |
| Edit | `/quotations/:id/edit` | Revise; spawns new **revision** (Rev A/B/C) with history | Save revision | SAL |
| Detail | `/quotations/:id` | Revisions, cost vs price, margin, proposal PDF; **Send**, **Win→Project**, Lose | Send, Win, Lose | SAL, FIN(V) |
| Approval | `/quotations/:id/approve` | Margin/discount DOA gate; shows margin vs threshold | Approve/Reject | FIN, CEO |
| Dashboard | `/sales/dashboard` | Win rate, quoted margin, turnaround, revision count | drill-through | SAL, FIN, CEO |

### M03 — Project Creation  (domain: Projects)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/projects` | Project register; health (RAG), value, PM, stage | New, Export | PLN, CEO, FIN, all(V) |
| Create | `/projects/new` | Seed from won quote: code, **WBS**, budget baseline, milestones, team, LD terms | Save, Submit charter | PLN |
| Edit | `/projects/:id/edit` | Amend scope/team/milestones (audited) | Save | PLN |
| Detail | `/projects/:id` | Project 360: scope, team, budget vs actual, milestones, links to plan/procurement/production/P&L | Open plan, Raise change order | PLN, all(V) |
| Approval | `/projects/:id/approve` | Charter + budget baseline sign-off | Approve/Reject | FIN, CEO |
| Dashboard | `/projects/dashboard` | Portfolio health heatmap, milestone slippage, budget burn | drill-through | PLN, CEO, FIN |

### M04 — Project Planning & Gantt  (domain: Projects)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/projects/:id/plan` | Task list / WBS tree for a project (also a cross-project schedule list at `/schedules`) | Add task | PLN |
| Create | `/projects/:id/plan/baseline` | Build baseline schedule: tasks, durations, dependencies, resource assignment | Save baseline | PLN |
| Edit | `/projects/:id/plan/edit` | Re-plan / what-if; re-version baseline | Save, Re-baseline | PLN |
| Detail | `/projects/:id/plan` | **Gantt** with critical path, % complete, EVM (SPI/CPI), need-by dates | Export, Publish | PLN, PRD(V), PUR(V) |
| Approval | `/projects/:id/plan/approve` | Baseline / major re-plan approval | Approve/Reject | PLN(head) |
| Dashboard | `/projects/dashboard` | SPI, critical-path slack, milestone status | drill-through | PLN, CEO |

### M05 — Procurement  (domain: Procurement) — primary entity: Purchase Order
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/purchase-orders` | PO register (status, value, vendor, need-by); compact density | New, Export, bulk-approve | PUR, CEO(V), FIN(V) |
| Create | `/purchase-orders/new` | PO form: vendor, project peg, lines, taxes, delivery; from PR/RFQ | Save, Submit | PUR |
| Edit | `/purchase-orders/:id/edit` | Amend PO (creates amendment `-A1`) | Save amendment | PUR |
| Detail | `/purchase-orders/:id` | PO with lines, committed cost, GRN status, 3-way match, amendments | Send to vendor, Close | PUR, FIN(V) |
| Approval | `/purchase-orders/:id/approve` | Value-band DOA gate (Purchase→CEO); budget impact shown | Approve/Reject | PUR, CEO |
| Dashboard | `/procurement/dashboard` | PO cycle time, on-time vendor delivery, savings vs estimate, exposure | drill-through | PUR, CEO, FIN |

**Sibling document screens (same List/Create/Detail pattern):** Purchase Requisition `/purchase-requisitions` (+ approve), RFQ `/rfqs` (+ `/rfqs/:id/compare` techno-commercial comparison), GRN `/grn` (+ inspection hook, 3-way match).

### M06 — Inventory & Critical Items  (domain: Inventory)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/inventory` | Stock by item/location; free vs project-reserved; ABC class | Adjust, Export | STO, PUR(V), PRD(V) |
| Create | `/inventory/adjustments/new` | Stock adjustment / receipt / count entry | Save | STO |
| Edit | `/inventory/adjustments/:id/edit` | Amend pending adjustment | Save | STO |
| Detail | `/inventory/item/:id` | **Stock card**: balances, reservations, movements, batches/serials, valuation | Reserve, Issue | STO, all(V) |
| Approval | `/inventory/adjustments/:id/approve` | Stock write-off / adjustment approval (Stores + Finance) | Approve/Reject | STO, FIN |
| Dashboard | `/inventory/dashboard` | Turns, stockout incidents, **critical-item alerts**, dead stock | drill-through | STO, PUR, CEO |

**Sibling screens:** Material Issue `/material-issues`, Reservations `/reservations`, **Critical-Item Register** `/critical-items` (long-lead early-warning list).

### M07 — Employee Workload  (domain: Resourcing)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/workload` | Capacity/allocation board (people × weeks); over-allocation flags | Allocate, Export | PLN, HR, PRD |
| Create | `/workload/allocations/new` | Assign person to project task; capacity vs load | Save | PLN, HR |
| Edit | `/workload/allocations/:id/edit` | Re-allocate / level resources | Save | PLN, HR |
| Detail | `/workload/person/:id` | Person profile: skills, allocations, utilization, timesheets | Adjust allocation | HR, PLN |
| Approval | `/workload/timesheets/:id/approve` | Timesheet / overtime approval (feeds project cost) | Approve/Reject | PRD, PLN, HR |
| Dashboard | `/resourcing/dashboard` | Utilization %, over-allocation, plan vs actual hours | drill-through | HR, PLN, CEO |

**Sibling screens:** Timesheet entry `/timesheets/new` (per-user), Skill matrix `/skills`.

### M08 — Production  (domain: Production) — primary entity: Work Order
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/work-orders` | WO register (status, project, % complete) | New, Export | PRD, PLN(V) |
| Create | `/work-orders/new` | WO from project/MBOM: operations, routing, material list | Save | PRD, PLN |
| Edit | `/work-orders/:id/edit` | Amend WO | Save | PRD |
| Detail | `/work-orders/:id` | Operations, material issue, confirmations, scrap/rework, **as-built/serials** | Issue material, Confirm | PRD, STO(V), QC(V) |
| Approval | `/work-orders/:id/approve` | WO release (blocks if material short) | Approve/Reject | PRD(head) |
| Dashboard | `/production/dashboard` | Schedule adherence, scrap/rework %, WIP, actual vs std cost | drill-through | PRD, CEO |

**Sibling screens:** Shop-floor Production Confirmation `/work-orders/:id/confirm` (mobile), MBOM/Routing `/boms`.

### M09 — Delivery Prediction  (domain: Delivery)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/delivery-forecast` | Projects: predicted vs committed date, risk band, delay drivers | Filter at-risk | PLN, PRD, CEO |
| Create | N/A | System-generated from schedule + material + capacity | — | — |
| Edit | N/A | Computed; not directly editable | — | — |
| Detail | `/delivery-forecast/project/:id` | Forecast drill: critical-item delays, capacity overload, schedule slip | Investigate | PLN, PRD |
| Approval | `/delivery-forecast/:id/commit` | Record revised customer commitment when predicted date breaches contract | Confirm commitment | PLN, SAL, CEO |
| Dashboard | `/delivery/dashboard` | Forecast accuracy, early-warning lead time, OTD | drill-through | CEO, PLN |

### M10 — FAT (Factory Acceptance Test)  (domain: Quality)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/fat` | FAT register/schedule by project/product, status, first-pass yield | New, Export | QC, PRD(V) |
| Create | `/fat/new` | New FAT from protocol library; assign witnesses | Save, Start | QC |
| Edit | `/fat/:id/edit` | Record test results in-progress | Save | QC |
| Detail | `/fat/:id` | Protocol, pass/fail per parameter, **punch list**, evidence, sign-off | Add punch, Re-test | QC, INS(V) |
| Approval | `/fat/:id/approve` | QC + customer witness sign-off (gates Dispatch) | Approve/Waiver | QC, customer |
| Dashboard | `/quality/dashboard` | First-pass FAT yield, punch items, defect categories | drill-through | QC, CEO |

**Sibling screens:** FAT Protocol Library `/fat-protocols` (master).

### M11 — Dispatch  (domain: Logistics)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/dispatch` | Dispatch register; FAT/payment gate status | New, Export | STO, FIN(V) |
| Create | `/dispatch/new` | Dispatch from FAT-cleared goods: packing list, invoice, e-way bill, serials | Save | STO |
| Edit | `/dispatch/:id/edit` | Amend before release | Save | STO |
| Detail | `/dispatch/:id` | Packing list, **invoice + GST e-invoice + e-way bill**, transporter, gate pass | Print docs | STO, SAL(V) |
| Approval | `/dispatch/:id/approve` | Multi-gate clearance: Quality (QC) + Commercial/payment (FIN) | Approve/Reject | QC, FIN |
| Dashboard | `/logistics/dashboard` | On-time dispatch, doc accuracy, partial dispatches | drill-through | STO, CEO |

### M12 — Installation  (domain: Logistics)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/installations` | Installation jobs by project/site, status | New, Export | INS, SVC(V) |
| Create | `/installations/new` | Create install job: site team, tools, material | Save | INS |
| Edit | `/installations/:id/edit` | Amend job / site allocation | Save | INS |
| Detail | `/installations/:id` | SAT protocol, **site punch list**, commissioning report, site costs, CAC | Capture cost, Commission | INS |
| Approval | `/installations/:id/approve` | SAT / **Customer Acceptance Certificate** sign-off (triggers final billing + warranty) | Approve/Reject | INS, customer |
| Dashboard | `/logistics/dashboard` | Install cycle time, SAT first-pass, site cost vs estimate | drill-through | INS, CEO |

### M13 — Warranty & Service  (domain: Service) — primary entity: Service Ticket
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/service-tickets` | Ticket queue; SLA timers, in/out of warranty | New, Export | SVC |
| Create | `/service-tickets/new` | Log complaint; auto warranty check by serial | Save | SVC |
| Edit | `/service-tickets/:id/edit` | Update ticket | Save | SVC |
| Detail | `/service-tickets/:id` | Warranty status, field visits, spares issued, resolution, SLA | Dispatch engineer, Resolve | SVC, FIN(V) |
| Approval | `/service-tickets/:id/approve` | Warranty claim validity / goodwill / service billing | Approve/Reject | SVC, FIN |
| Dashboard | `/service/dashboard` | SLA adherence, MTTR, warranty cost %, AMC renewals, repeat failures | drill-through | SVC, CEO, FIN |

**Sibling screens:** Warranty Register `/warranties`, AMC/Service Contracts `/service-contracts` (+ PM schedules), Spares `/spares`.

### M14 — Failure Analysis  (domain: Quality) — primary entity: NCR / RCA / CAPA
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/ncr-capa` | NCR / CAPA register; source (FAT/install/warranty/production), status | New, Export | QC |
| Create | `/ncr-capa/new` | Raise NCR; categorize failure mode; link source event | Save | QC, PRD, STO, INS, SVC |
| Edit | `/ncr-capa/:id/edit` | Add RCA / CAPA actions | Save | QC |
| Detail | `/ncr-capa/:id` | **RCA tools** (5-Why, Fishbone, 8D), CAPA actions + owners + due dates, effectiveness | Add action, Verify | QC |
| Approval | `/ncr-capa/:id/approve` | CAPA closure (effectiveness check); design-change recommendation | Approve/Close | QC(head) |
| Dashboard | `/quality/dashboard` | CAPA closure time, recurrence rate, COPQ, top failure modes (Pareto) | drill-through | QC, CEO |

### M15 — Profitability  (domain: Finance) — primary entity: Project P&L
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | `/profitability` | Project profitability list: quoted vs actual margin, CPI, status | Export | FIN, CEO, PLN(V) |
| Create | N/A | P&L is a system cost roll-up (no manual create) | — | — |
| Edit | `/profitability/change-orders/new` | The editable lever: change orders / cost adjustments | Save | FIN, PLN |
| Detail | `/profitability/project/:id` | Project P&L drill: quoted/budget/**committed**/actual, EAC, margin, txn drill-down | Drill to txn | FIN, CEO |
| Approval | `/profitability/:id/approve` | Change-order / margin-erosion / project financial close | Approve/Reject | FIN, PLN, CEO |
| Dashboard | `/finance/dashboard` | Portfolio margin, erosion alerts, CPI, cash per project | drill-through | FIN, CEO |

### M16 — CEO Dashboard  (domain: Executive)
| Screen | Route | Purpose & key components | Primary actions | Roles |
|---|---|---|---|---|
| List | N/A | Executive view is not a record list | — | — |
| Create | N/A | — | — | — |
| Edit | `/exec/dashboard/customize` | Personalize widgets/layout | Save layout | CEO |
| Detail | drill-through | Reuses module Detail screens (no bespoke detail) | — | CEO |
| Approval | `/approvals` (CEO view) | Top-tier approvals surface in the unified inbox, filtered to CEO DOA | Approve/Reject | CEO |
| Dashboard | `/exec/dashboard` | **Executive cockpit**: order book/pipeline, revenue, margin, OTD, cash, utilization, project RAG heatmap, at-risk projects | drill-through | CEO |

---

## 3. Foundation & Admin Screens

### 3.1 Master Data  (domain: Masters)
| Entity | List | Create | Edit | Detail | Approval | Dashboard |
|---|---|---|---|---|---|---|
| Customer | `/customers` | `…/new` | `…/:id/edit` | `…/:id` | N/A | `/masters/dashboard` (data quality) |
| Vendor | `/vendors` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` (onboarding: QA+FIN) | ↑ |
| Item | `/items` | `…/new` | `…/:id/edit` | `…/:id` | N/A | ↑ |
| BOM (E/M) | `/boms` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` (ECN/ECO) | ↑ |
| Employee | `/employees` | `…/new` | `…/:id/edit` | `…/:id` | N/A | ↑ |

### 3.2 Finance  (domain: Finance) — beyond Profitability
| Entity | List | Create | Edit | Detail | Approval | Dashboard |
|---|---|---|---|---|---|---|
| Invoice (AR) | `/invoices` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` | `/finance/dashboard` |
| Vendor Invoice (AP) | `/ap-invoices` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` | ↑ |
| GL / Journals | `/gl` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` | ↑ |
| Tax / GST | `/tax` | `…/filings/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` | ↑ |

### 3.3 Security / Administration  (domain: Admin)
| Entity | List | Create | Edit | Detail | Approval | Dashboard |
|---|---|---|---|---|---|---|
| Users | `/admin/users` | `…/new` | `…/:id/edit` | `…/:id` | N/A | `/admin/dashboard` |
| Roles & Permissions | `/admin/roles` | `…/new` | `…/:id/edit` | `…/:id` (matrix) | N/A | ↑ |
| Approval / DOA config | `/admin/approvals` | `…/new` | `…/:id/edit` | `…/:id` | `…/:id/approve` (policy) | ↑ |
| Numbering config | `/admin/numbering` | `…/new` | `…/:id/edit` | `…/:id` | N/A | ↑ |
| **Audit Log** | `/admin/audit` | N/A (append-only) | N/A | `/admin/audit/:id` | N/A | ↑ |
| System config | `/admin/settings` | — | `/admin/settings` | — | — | ↑ |

---

## 4. Navigation Map

### 4.1 Sidebar information architecture (role-filtered per RBAC)
```
Sales        → Enquiries · Quotations
Projects     → Projects · Planning (Gantt) · Change Orders · Delivery Forecast
Procurement  → Purchase Requisitions · RFQs · Purchase Orders · GRN · Vendors
Inventory    → Stock · Material Issues · Reservations · Critical Items
Resourcing   → Workload · Timesheets
Production   → Work Orders · Production Confirmation · BOM
Quality      → FAT · NCR / CAPA · Failure Analysis
Logistics    → Dispatch · Installations
Service      → Service Tickets · Warranties · Service Contracts · Spares
Finance      → Invoices · AP · GL · Tax · Profitability
Analytics    → CEO / Executive Dashboard · (module dashboards)
Masters      → Customers · Vendors · Items · BOM · Employees
Admin        → Users · Roles · Approvals (DOA) · Numbering · Audit Log · Settings
```
Every sidebar item is shown only if the user holds `MODULE.VIEW` (RBAC). Counts (e.g. pending approvals) render as nav badges.

### 4.2 Route tree (abridged)
```
/login  /search  /approvals  /notifications  /me
/{domain}/dashboard                         (sales, projects, procurement, inventory,
                                             resourcing, production, quality, logistics,
                                             service, finance, delivery, exec, masters, admin)
/{entity}                 → List
/{entity}/new             → Create
/{entity}/{id}            → Detail
/{entity}/{id}/edit       → Edit
/{entity}/{id}/approve    → Approval   (also aggregated in /approvals)
```

### 4.3 Cross-screen navigation flows
```
List ──select──▶ Detail ──Edit──▶ Edit ──save──▶ Detail
  │                 │
  │ New             │ submit
  ▼                 ▼
Create ──save──▶ Detail ──▶ Approval ──approve──▶ Detail(next state)
                                  ▲
Approvals Inbox ──open item──────┘   (unified queue, all modules, DOA-routed)

Dashboard ──drill KPI──▶ filtered List ──▶ Detail
Global Search ──▶ any Detail
Breadcrumb ──▶ ancestor List / Detail
```

### 4.4 End-to-end business journey (screen path — the FRD master flow)
```
Enquiry List→Detail ─Convert→ Quotation Create→Approval→ (Win)
 → Project Create→Approval → Planning/Gantt → [Critical-Item Register + PO Create→Approval]
 → GRN → Inventory (reserve) → Work Order Create→Approval→Confirm
 → FAT Detail→Approval ─gate→ Dispatch Create→Approval(QC+FIN)
 → Installation Detail→Approval(SAT/CAC)
 → Service Ticket (post-handover) → NCR/CAPA (on failure)
 → Profitability project P&L → Executive Dashboard (portfolio rollup)
```

### 4.5 Global navigation patterns
- **Topbar**: global search (Ctrl+/), Approvals badge → `/approvals`, Notifications → `/notifications`, user menu → `/me`.
- **Approvals Inbox** is the single place an approver works; each item deep-links to that module's Approval screen and back.
- **Breadcrumbs** on every Detail/Edit screen reflect the route hierarchy.
- **Deep-linking**: List filters/sort and Detail tab are encoded in the URL (shareable, bookmarkable).
- **Drill-through**: every dashboard KPI links to the underlying filtered List, then Detail.
- **Role-based rendering**: nav items, screens, and in-screen actions are gated by the RBAC permission matrix (e.g. only QC/FIN see Dispatch Approve).

---

## 5. Screen Count Summary
| Group | Modules/Entities | Approx. distinct screens |
|---|---|---|
| Core modules (M01–M16) | 16 | ~84 (six archetypes minus documented N/A + sibling docs) |
| Foundation (Masters, Finance) | 9 entities | ~40 |
| Admin / Security | 6 entities | ~22 |
| Global / shared | 6 | 6 |
| **Total** | — | **~150 screens** |

Sibling-document screens (PR, RFQ, GRN, Material Issue, Timesheet, Production Confirmation, Warranty, AMC, Spares, FAT Protocols, etc.) each add their own List/Create/Detail and are catalogued inline above.
