# Functional Requirements Document (FRD)
## Project-Based Manufacturing ERP — "Boss Engineers ERP"

---

### Document Control

| Field | Detail |
|---|---|
| Document Title | Functional Requirements Document — Project-Based Manufacturing ERP |
| Document ID | BE-ERP-FRD-001 |
| Version | 1.0 (Baseline) |
| Date | 2026-06-06 |
| Author | ERP Architecture (Senior ERP Architect) |
| Classification | Confidential — Internal |
| Manufacturing Model | Engineer-to-Order (ETO) / Project-Based Manufacturing |
| Status | For Review |

| Ver | Date | Change | Approver |
|---|---|---|---|
| 0.1 | 2026-06-06 | Initial draft | — |
| 1.0 | 2026-06-06 | Baseline for review | Pending |

> **Reviewer's note (Architect):** The 16 modules describe a strong **operational backbone** but, as scoped, the system is **not yet a complete ERP** — it is missing the financial spine (GL/AR/AP/Billing/Tax), the engineering spine (Design/BOM/PLM), and several control layers (QMS, DMS, Change Management). These are called out explicitly in **Section 11 — Missing Requirements**. Read that section *first* before committing to a build.

---

## 1. Executive Summary

Boss Engineers operates a **Project-Based / Engineer-to-Order (ETO)** manufacturing model: each customer order is effectively a unique project with its own design, BOM, schedule, cost structure, and acceptance criteria. Unlike repetitive (make-to-stock) manufacturing, ETO success depends on three things the ERP must protect relentlessly:

1. **Margin integrity** — the gap between the quoted price and actual delivered cost (margin erosion is the #1 killer in ETO).
2. **Schedule integrity** — driven by long-lead/critical items and finite resource capacity.
3. **Quality & acceptance integrity** — FAT/SAT gates, warranty exposure, and closed-loop failure analysis.

This FRD specifies the functional behaviour of all 16 requested modules, their dependencies, approval gates, and data flows, and identifies the gaps that must be closed for the system to function as a true ERP rather than a project-tracking tool.

---

## 2. Business Objectives & Success Metrics

| # | Business Objective | Target KPI |
|---|---|---|
| O1 | Convert enquiries to orders faster and at protected margin | Quote turnaround ↓ 40%; quoted-vs-actual margin variance ≤ 5% |
| O2 | Deliver projects on time | On-Time Delivery (OTD) ≥ 90%; Schedule Performance Index (SPI) ≥ 0.95 |
| O3 | Eliminate surprises on long-lead items | Zero project delays attributable to critical-item stockouts |
| O4 | Protect and grow project profitability | Real-time project P&L; margin leakage visible within 24h |
| O5 | Reduce warranty/failure cost | Warranty cost ≤ X% of revenue; CAPA closure ≤ 30 days |
| O6 | Give leadership a single source of truth | CEO dashboard refreshed in near-real-time across all live projects |

---

## 3. Stakeholders, Roles & RACI

| Role | Primary Modules | Key Responsibility |
|---|---|---|
| Sales / BD | Enquiry, Quotation | Capture, qualify, quote |
| Estimation / Costing | Quotation, Profitability | Build cost & price |
| Project Manager (PM) | Project Creation, Planning, Production | Own scope/schedule/budget |
| Design / Engineering* | (see gap) BOM, Production | EBOM/MBOM, drawings, ECN |
| Procurement / Purchase | Procurement, Inventory | PR→PO→GRN, vendor mgmt |
| Stores / Warehouse | Inventory, Dispatch | Stock, reservation, GRN, issue |
| Production / Shop Floor | Production, FAT | Work orders, assembly, test |
| Quality (QA/QC)* | FAT, Failure Analysis | Inspection, NCR, CAPA |
| HR / Resource Manager | Employee Workload | Capacity, allocation |
| Logistics | Dispatch, Installation | Shipping, e-way bill, site |
| Service / After-Sales | Warranty & Service | Tickets, AMC, SLA |
| Finance / Accounts* | (see gap) Profitability | Billing, AR/AP, GL, tax |
| CEO / Leadership | CEO Dashboard | Portfolio decisions |

*\*Roles marked with asterisk map to modules currently missing or implicit — see Section 11.*

---

## 4. Solution Scope

**In scope (this FRD):** the 16 listed modules plus the master-data and control layers they require to function.
**Manufacturing model:** ETO with elements of Make-to-Order; supports subcontracting/job-work.
**Out of scope (Phase 1, candidate Phase 2+):** full PLM, advanced finite-capacity scheduling (APS), e-commerce, multi-company consolidation — flagged in roadmap.

---

## 5. End-to-End Business Flow (Master Process)

The "order-to-cash + project lifecycle" for one project:

```
Enquiry → Qualify → Quotation (Cost+Price+Approval) → Win
   → Project Creation (WBS, Budget) → Planning & Gantt (Schedule, Resources)
   → [Parallel] Engineering/BOM* + Critical-Item Procurement (early)
   → Procurement (PR→RFQ→PO→GRN) → Inventory (reserve/issue to project)
   → Employee Workload (allocate) → Production (Work Orders → Assembly)
   → FAT (Factory Acceptance) → Dispatch (Invoice/E-way bill)
   → Installation (Site/SAT) → Customer Acceptance → Billing/Milestone*
   → Warranty & Service (AMC/SLA) → Failure Analysis (RCA/CAPA loop)
   → Profitability (Project P&L close) → CEO Dashboard (portfolio rollup)
```

**Three control loops run continuously across this flow:**
- **Cost loop:** Estimate → Budget → Commitment (PO) → Actual → Margin (feeds Profitability).
- **Schedule loop:** Plan (Gantt) → Progress (% complete, EVM) → Forecast (Delivery Prediction).
- **Quality loop:** FAT/SAT → Failure Analysis → CAPA → back into Design/Production standards.

---

## 6. Module Functional Specifications

> Each module uses a consistent template: **Purpose · Key Requirements · Inputs/Outputs · Core Data Entities · Approvals · Dependencies · KPIs · Best-Practice Notes.**

### M01 — Customer Enquiry
- **Purpose:** Single capture point for all inbound demand (RFQ/lead) with qualification.
- **Key requirements:**
  - Multi-channel capture (email, web form, phone, walk-in, sales rep).
  - Enquiry register with unique ID, customer, product/scope, target budget, required date, source.
  - Lead qualification (BANT-style: budget, authority, need, timeline) + technical feasibility flag.
  - Duplicate detection; link to existing customer (CRM master).
  - Convert → Quotation (or Lost, with reason code).
  - Attachments (customer specs, drawings, RFQ docs).
- **Inputs:** Customer/contact, scope/spec, target date, source.
- **Outputs:** Qualified enquiry → triggers Quotation.
- **Core entities:** `Enquiry`, `Customer`, `Contact`, `Enquiry_Line`.
- **Approvals:** Light — qualification sign-off for high-value/strategic enquiries.
- **Dependencies:** Feeds **M02**. Needs Customer master (MDM).
- **KPIs:** Enquiry volume, qualification rate, source-wise conversion, avg response time.
- **Best practice:** Capture **lost reasons** from day one — this is your future win-rate intelligence. Don't let enquiries live in inboxes.

### M02 — Quotation
- **Purpose:** Convert qualified enquiry into a costed, priced, approved proposal.
- **Key requirements:**
  - **Cost estimation engine:** material (from indicative BOM), labour/engineering hours, bought-outs, subcontracting, freight, contingency, overheads.
  - **Pricing:** target margin %, markups, discount handling, optional/alternate line items.
  - **Versioning & revisions** (Quote Rev A/B/C) with full history.
  - **Margin & discount approval workflow** (threshold-based — Section 8).
  - Validity period, payment terms, delivery terms (Incoterms), warranty terms, T&C library.
  - Generate professional proposal PDF; track Sent → Negotiation → Won/Lost.
  - **Win → seed Project** (carry scope, cost baseline, BOM skeleton, terms).
- **Inputs:** Qualified enquiry, cost rates, item/BOM data.
- **Outputs:** Approved quotation; on win → project + **cost baseline**.
- **Core entities:** `Quotation`, `Quote_Revision`, `Quote_Line`, `Cost_Sheet`, `Price_Term`.
- **Approvals:** Margin/discount DOA; T&C deviation approval.
- **Dependencies:** From **M01**; feeds **M03** & **M15** (baseline). Needs Item/Rate masters.
- **KPIs:** Quote turnaround, win rate, quoted margin, revision count, discount given.
- **Best practice:** The **quoted cost sheet becomes the project budget baseline** — lock it on win. Margin discipline starts here, not at delivery.

### M03 — Project Creation
- **Purpose:** Instantiate the won order as a controllable project entity.
- **Key requirements:**
  - Auto-create project from won quote (project code, customer, value, scope).
  - **Work Breakdown Structure (WBS)** — phases, deliverables, work packages.
  - **Budget baseline** by cost category (carried from quote cost sheet).
  - Assign PM, team, sponsor; define milestones & contractual dates (incl. **LD/penalty clauses**).
  - Project charter, contract reference, advance/payment milestone schedule.
  - Project number = costing collector for all downstream actuals.
- **Inputs:** Won quotation, contract.
- **Outputs:** Active project, WBS, budget, milestone schedule.
- **Core entities:** `Project`, `WBS_Element`, `Milestone`, `Project_Budget`, `Project_Team`.
- **Approvals:** Project kickoff/charter approval; budget baseline sign-off.
- **Dependencies:** From **M02**; feeds **M04–M15**. The **project ID is the spine** every downstream cost/transaction posts against.
- **KPIs:** Time quote-to-kickoff, budget at sanction, milestone count.
- **Best practice:** **WBS is non-negotiable** in ETO — without it you cannot cost, schedule, or bill in segments. Map billing milestones to WBS deliverables.

### M04 — Project Planning & Gantt
- **Purpose:** Schedule the project, sequence activities, allocate resources, set the baseline.
- **Key requirements:**
  - Gantt with tasks, durations, dependencies (FS/SS/FF/SF), milestones.
  - **Critical Path Method (CPM)**; baseline vs actual; % complete.
  - Resource assignment & **resource leveling** (links to Employee Workload).
  - Link tasks to WBS, procurement need-by dates, production work orders.
  - **Schedule → triggers material need dates** (drives critical-item procurement).
  - Re-planning, what-if, baseline re-versioning with audit.
- **Inputs:** WBS, resources, lead times, capacity.
- **Outputs:** Baselined schedule, critical path, need-by dates, % progress.
- **Core entities:** `Schedule`, `Task`, `Task_Dependency`, `Baseline`, `Resource_Assignment`.
- **Approvals:** Baseline approval; major re-plan approval.
- **Dependencies:** From **M03**; drives **M05, M07, M08, M09**.
- **KPIs:** SPI, critical-path slack, plan vs actual variance, milestone slippage.
- **Best practice:** Use **Earned Value (PV/EV/AC → SPI/CPI)** — the only objective way to know if an ETO project is really on track vs just "looks busy." Drive procurement from the schedule, not from gut feel.

### M05 — Procurement
- **Purpose:** Source and buy materials/services against project need-by dates, at controlled cost.
- **Key requirements:**
  - **Purchase Requisition (PR)** from BOM/shortage/planning → approval.
  - **RFQ to multiple vendors**, quotation comparison (techno-commercial), negotiation.
  - **PO** generation with DOA-based approval; amendments; blanket/scheduling agreements.
  - **GRN** (Goods Receipt) with inspection hook (QC), 3-way match (PO–GRN–Invoice).
  - Vendor master, vendor rating, lead-time tracking.
  - **Project-pegged procurement** (PO tagged to project & WBS) vs stock replenishment.
  - **Subcontracting / job-work PO** (issue material to vendor, receive processed goods).
- **Inputs:** PR (from BOM/inventory/planning), need-by dates, vendor data.
- **Outputs:** POs, committed cost, incoming material → GRN → inventory.
- **Core entities:** `PR`, `RFQ`, `Vendor_Quote`, `PO`, `PO_Line`, `GRN`, `Vendor`.
- **Approvals:** PR approval; PO value-based DOA; vendor onboarding; rate deviation.
- **Dependencies:** From **M04/M06**; feeds **M06, M08, M15** (committed & actual cost).
- **KPIs:** PO cycle time, on-time vendor delivery, cost savings vs estimate, % project-pegged.
- **Best practice:** **Commitment accounting** — the moment a PO is raised, that money is *committed* against the project even before invoicing. Show committed cost in the project P&L or you'll discover overruns too late.

### M06 — Inventory & Critical Items
- **Purpose:** Manage stock, project reservations, and proactively control long-lead/critical items.
- **Key requirements:**
  - Multi-location/warehouse, bins; lot/serial tracking; UoM management.
  - **Project stock vs free stock** (material reserved/pegged to a project must not be consumed by another).
  - **Material reservation** against project/WBS; issue to production; returns.
  - **Critical Items register:** flag long-lead, single-source, high-value, import items; **early-warning when project schedule implies they must be ordered now**.
  - Re-order levels, safety stock (for common/consumable items), ABC/XYZ classification.
  - Stock valuation (FIFO/weighted avg/standard); physical count/cycle count.
  - Shortage report driving PR generation; GRN inward; QC quarantine.
- **Inputs:** GRN, BOM demand, reservations, issues.
- **Outputs:** Stock availability, critical-item alerts, material issued to production.
- **Core entities:** `Item`, `Stock`, `Reservation`, `Critical_Item`, `Stock_Txn`, `Batch/Serial`.
- **Approvals:** Stock write-off/adjustment; reservation override.
- **Dependencies:** From **M05**; feeds **M08, M11, M15**; informed by **M04** (need dates).
- **KPIs:** Inventory turns, stockout incidents, critical-item lead-time adherence, dead stock value.
- **Best practice:** In ETO, **the critical-items list is your project's heartbeat.** Order long-lead items the day the project is sanctioned, not when production starts. Keep project stock strictly segregated.

### M07 — Employee Workload
- **Purpose:** Plan and balance human capacity (engineers, technicians, fitters) across concurrent projects.
- **Key requirements:**
  - Skill matrix, availability calendar (leave, holidays, shifts).
  - Allocation of people to project tasks (from Gantt); **capacity vs load** view.
  - **Over-allocation / bottleneck alerts**; resource leveling support.
  - **Timesheets** → actual hours per project/WBS (feeds project cost & EVM).
  - Utilization & productivity reporting per person/team/department.
- **Inputs:** Task assignments (M04), HR master, leave, timesheets.
- **Outputs:** Capacity plan, utilization, **actual labour cost to projects**.
- **Core entities:** `Employee`, `Skill`, `Allocation`, `Timesheet`, `Capacity_Calendar`.
- **Approvals:** Timesheet approval; overtime approval.
- **Dependencies:** From **M04**; feeds **M08, M15** (labour actuals). Needs HR master (gap).
- **KPIs:** Utilization %, over-allocation count, plan vs actual hours, billable ratio.
- **Best practice:** Without **timesheets feeding project cost**, your labour cost is fiction and your margin is wrong. This is the most-skipped, most-regretted control in ETO ERPs.

### M08 — Production
- **Purpose:** Execute manufacturing/assembly against the project via work orders.
- **Key requirements:**
  - **Manufacturing BOM (MBOM)** & routing (operations, workcentres, std time).
  - **Work Orders / Job Cards** per assembly/WBS; material issue (backflush or manual).
  - Operation tracking, shop-floor progress, % complete, scrap/rework capture.
  - Subcontracting operations integration; in-process QC checkpoints (NCR linkage).
  - Production scheduling vs capacity; consumption posting (actual material + labour).
  - **As-built record** (serials, batches) for traceability → warranty/failure analysis.
- **Inputs:** MBOM, work orders, issued material (M06), allocated labour (M07).
- **Outputs:** Finished assemblies, production actuals, as-built BOM → FAT.
- **Core entities:** `Work_Order`, `Routing`, `Operation`, `Material_Issue`, `Production_Confirmation`, `As_Built`.
- **Approvals:** Work-order release; over-consumption/scrap approval; rework authorization.
- **Dependencies:** From **M04, M06, M07**; feeds **M09, M10, M15**. **Needs Engineering/BOM (gap).**
- **KPIs:** Production schedule adherence, scrap/rework %, OEE (where relevant), actual vs std cost.
- **Best practice:** Capture **as-built configuration & serials** here — it's the single source for warranty validity and root-cause analysis later. EBOM≠MBOM; manage both.

### M09 — Delivery Prediction
- **Purpose:** Forecast realistic completion/delivery dates and flag at-risk projects early.
- **Key requirements:**
  - Pull current schedule (M04), production progress (M08), material readiness (M06), capacity (M07).
  - **Predicted delivery date** vs committed date; confidence/risk band.
  - Trigger logic: critical-item delays, capacity overload, schedule slippage → revised ETA.
  - Optional ML/analytics on historicals; rule-based as baseline.
  - **Early-warning alerts** to PM/CEO when predicted date breaches contractual date (LD risk).
- **Inputs:** Schedule, production %, material status, capacity, historical performance.
- **Outputs:** Predicted delivery date, delay risk, alerts.
- **Core entities:** `Delivery_Forecast`, `Risk_Flag` (derived/analytical — largely a computed module).
- **Approvals:** N/A (analytical); revised commitment to customer requires PM/commercial approval.
- **Dependencies:** Reads **M04, M06, M07, M08**; feeds **M11, M16**.
- **KPIs:** Forecast accuracy (predicted vs actual), early-warning lead time, OTD.
- **Best practice:** Keep it **rule-based first** (critical path + material readiness + capacity), add ML later once you have clean historical data. A simple, trusted forecast beats a black box no one believes.

### M10 — FAT (Factory Acceptance Test)
- **Purpose:** Formal pre-dispatch acceptance against agreed test protocol.
- **Key requirements:**
  - **FAT protocol/checklist** library by product type; customer-specific protocols.
  - Test execution recording, pass/fail per parameter, measured values.
  - **Punch list / NCR** for failures; rework loop → re-test.
  - **Customer/witness sign-off** (internal QC + customer rep); certificates & evidence (photos/reports).
  - **FAT clearance is a gate to Dispatch** (no dispatch without FAT pass / waiver).
- **Inputs:** Finished product (M08), test protocol, customer spec.
- **Outputs:** FAT report, sign-off, punch list, dispatch clearance.
- **Core entities:** `FAT_Protocol`, `FAT_Execution`, `FAT_Result`, `Punch_Item`, `Acceptance_Signoff`.
- **Approvals:** QC approval; customer witness sign-off; FAT waiver (if dispatched conditionally).
- **Dependencies:** From **M08**; gates **M11**; feeds **M14** (failures) & **M15**.
- **KPIs:** First-pass FAT yield, punch items per project, FAT cycle time, defect categories.
- **Best practice:** Treat FAT as a **hard quality gate**, not a formality. Feed every FAT failure into Failure Analysis (M14) so defects don't repeat across projects.

### M11 — Dispatch
- **Purpose:** Ship the accepted product with full commercial & statutory compliance.
- **Key requirements:**
  - **Dispatch gate checks:** FAT passed + payment milestone met + documentation ready.
  - Packing list, dispatch advice, **commercial invoice**, **GST e-invoice**, **e-way bill** (India), transporter/LR.
  - Serial/batch capture at dispatch (ties to as-built & warranty start).
  - Multi-part / partial dispatch; insurance; gate pass.
  - **Triggers warranty start date & billing milestone.**
- **Inputs:** FAT clearance, payment status, finished goods, customer/ship-to.
- **Outputs:** Shipment, invoice, e-way bill, warranty start trigger.
- **Core entities:** `Dispatch`, `Packing_List`, `Invoice`, `E_Way_Bill`, `Shipment_Serial`.
- **Approvals:** Commercial/finance clearance (payment & credit); dispatch authorization.
- **Dependencies:** From **M10**; gated by Finance (payment); feeds **M12, M13, M15**. **Needs Billing/Tax (gap).**
- **KPIs:** On-time dispatch, dispatch-doc accuracy, partial-dispatch incidents.
- **Best practice:** Make dispatch a **multi-gate release** (Quality + Commercial + Documentation). The classic ETO leak is dispatching before the payment milestone is secured.

### M12 — Installation
- **Purpose:** On-site erection, commissioning, and **Site Acceptance Test (SAT)**.
- **Key requirements:**
  - Installation work orders, site team allocation, site material/tools tracking.
  - **SAT protocol & customer sign-off**; commissioning report.
  - Site punch list → closure; capture site labour/expense to project cost.
  - **Customer acceptance certificate (CAC)** → triggers final billing milestone & warranty confirmation.
  - Field/mobile capability (often offline).
- **Inputs:** Dispatched product (M11), site readiness, install team.
- **Outputs:** Commissioned system, SAT/CAC sign-off, final milestone trigger.
- **Core entities:** `Installation`, `SAT_Protocol`, `Commissioning_Report`, `Acceptance_Certificate`, `Site_Punch_Item`.
- **Approvals:** SAT/customer sign-off; site-expense approval; handover approval.
- **Dependencies:** From **M11**; feeds **M13, M15** (final cost), billing.
- **KPIs:** Install cycle time, SAT first-pass rate, site punch closure time, install cost vs estimate.
- **Best practice:** **Customer Acceptance Certificate is the revenue & warranty trigger** — control it tightly. Capture all site costs; they're notorious for silently eroding margin.

### M13 — Warranty & Service
- **Purpose:** Manage post-handover obligations: warranty, AMC, breakdowns, spares.
- **Key requirements:**
  - **Warranty master** per delivered unit/serial (start = dispatch/CAC, duration, T&C).
  - **AMC/Service contracts** with SLA, preventive-maintenance schedules.
  - **Service ticket/complaint management** (in/out of warranty), engineer dispatch, resolution.
  - Spares management & service inventory; service billing for out-of-warranty.
  - **Warranty cost capture** (parts, labour, travel) → Profitability & Failure Analysis.
  - Customer portal for ticket logging (recommended).
- **Inputs:** Delivered units (M11/M12), complaints, AMC contracts.
- **Outputs:** Resolved tickets, warranty cost, PM compliance, **failure data → M14**.
- **Core entities:** `Warranty`, `Service_Contract`, `Service_Ticket`, `Field_Visit`, `Spare_Issue`, `SLA`.
- **Approvals:** Warranty claim validity; goodwill/concession approval; service billing.
- **Dependencies:** From **M11/M12**; feeds **M14, M15**.
- **KPIs:** SLA adherence, MTTR, warranty cost %, AMC renewal rate, repeat failures.
- **Best practice:** **Every warranty event is a data point** — route it to Failure Analysis. Warranty cost must hit the originating project's P&L (it's the true cost of the sale).

### M14 — Failure Analysis
- **Purpose:** Closed-loop root-cause analysis & corrective/preventive action across quality events.
- **Key requirements:**
  - Capture failures from FAT (M10), Installation (M12), Warranty (M13), Production NCRs (M08).
  - **RCA tools** (5-Why, Fishbone/Ishikawa, 8D); failure mode categorization.
  - **CAPA workflow** — corrective + preventive actions, owners, due dates, effectiveness check.
  - **Feedback loop into Design/BOM/Process standards** (prevent recurrence on future projects).
  - Pareto/trend analytics by failure mode, component, vendor, project type.
- **Inputs:** Failure/NCR events from M08/M10/M12/M13.
- **Outputs:** RCA, CAPA actions, standards updates, quality trends.
- **Core entities:** `NCR`, `RCA`, `CAPA`, `Failure_Mode`, `Action_Item`.
- **Approvals:** CAPA approval & closure (QA head); design-change recommendation (Engineering).
- **Dependencies:** From **M08/M10/M12/M13**; feeds Engineering/Design & **M16**.
- **KPIs:** CAPA closure time, recurrence rate, cost of poor quality (COPQ), top failure modes.
- **Best practice:** This module turns project lessons into **organizational learning**. Without the loop back to Design/Process, you'll keep paying for the same defect on every project.

### M15 — Profitability
- **Purpose:** Real-time project P&L and portfolio margin control.
- **Key requirements:**
  - **Cost roll-up:** quoted (baseline) vs budget vs **committed** (PO) vs **actual** (material issued, labour timesheets, subcontract, freight, warranty).
  - Revenue recognition by milestone/% completion; advances; retentions.
  - **Margin tracking & erosion alerts**; change-order/variation impact on margin.
  - Project P&L statement; portfolio profitability; profitability by customer/product/PM.
  - Drill-down to transaction level; **Estimate at Completion (EAC) & forecast margin**.
- **Inputs:** Baseline (M02), commitments (M05), material (M06), labour (M07), production/site/warranty actuals (M08/M12/M13), revenue/billing (Finance gap).
- **Outputs:** Project P&L, margin variance, EAC, portfolio profitability.
- **Core entities:** `Cost_Ledger`, `Revenue_Recognition`, `Margin_Snapshot`, `Change_Order`.
- **Approvals:** Change-order/variation approval; margin-erosion escalation; project financial close.
- **Dependencies:** Aggregates nearly all modules; feeds **M16**. **Critically depends on Finance/Billing (gap).**
- **KPIs:** Quoted vs actual margin, margin erosion %, CPI, EAC variance, cash position per project.
- **Best practice:** Show **committed cost**, not just invoiced cost. ETO projects die from un-tracked commitments. Track **change orders** rigorously — uncompensated scope creep is the silent margin killer.

### M16 — CEO Dashboard
- **Purpose:** Executive, near-real-time view of the whole portfolio for decision-making.
- **Key requirements:**
  - **Portfolio KPIs:** order book/pipeline, revenue, margin, OTD, cash, utilization.
  - **Project health heatmap** (RAG by schedule/cost/quality) with drill-down.
  - At-risk projects (delivery prediction + margin erosion + critical-item delays).
  - Sales funnel (enquiry→quote→win), procurement exposure, warranty cost trend.
  - Configurable, role-based, drill-through; mobile; scheduled exec reports.
- **Inputs:** Aggregated, read-only from all modules.
- **Outputs:** Dashboards, alerts, exec reports.
- **Core entities:** Derived/analytical (data warehouse/semantic layer recommended).
- **Approvals:** N/A (consumption); strategic decisions taken from it.
- **Dependencies:** Reads **M01–M15**.
- **KPIs:** (It *is* the KPI layer.) Adoption, decision latency, data freshness.
- **Best practice:** Build on a **separate reporting/semantic layer**, not live transactional tables, to protect performance and give a single, governed version of the truth.

---

## 7. Cross-Module Dependency Matrix

| Module | Depends On (Upstream) | Feeds (Downstream) | Critical Data Passed |
|---|---|---|---|
| M01 Enquiry | Customer master | M02 | Scope, target date |
| M02 Quotation | M01, Item/Rate master | M03, M15 | **Cost baseline, price, terms** |
| M03 Project | M02 | M04–M15 | Project ID, WBS, **budget** |
| M04 Planning | M03 | M05, M07, M08, M09 | Schedule, **need-by dates** |
| M05 Procurement | M04, M06, BOM* | M06, M08, M15 | PO, **committed cost**, GRN |
| M06 Inventory | M05, M04 | M08, M11, M15 | Stock, **critical-item alerts**, reservations |
| M07 Workload | M04, HR* | M08, M15 | Allocation, **labour actuals** |
| M08 Production | M04, M06, M07, BOM* | M09, M10, M15 | As-built, production actuals |
| M09 Delivery Pred. | M04, M06, M07, M08 | M11, M16 | Predicted date, risk |
| M10 FAT | M08 | M11, M14, M15 | FAT result, **dispatch clearance** |
| M11 Dispatch | M10, Finance* | M12, M13, M15 | Invoice, e-way bill, **warranty start** |
| M12 Installation | M11 | M13, M15 | SAT/CAC, **final milestone** |
| M13 Warranty | M11, M12 | M14, M15 | Tickets, **warranty cost** |
| M14 Failure | M08, M10, M12, M13 | Design*, M16 | RCA, CAPA, standards |
| M15 Profitability | M02, M05–M08, M12, M13, Finance* | M16 | Project P&L, margin |
| M16 CEO Dash | M01–M15 | — | Portfolio KPIs |

*\*Items marked with asterisk reference modules in Section 11 (Missing Requirements).*

**Most critical dependency chain (the "delivery spine"):**
`M04 (schedule) → M06 (critical items) → M05 (procurement) → M08 (production) → M10 (FAT) → M11 (dispatch)`. A break anywhere here = late delivery. Instrument it heavily.

---

## 8. Approval / Workflow Matrix (Delegation of Authority — illustrative, configurable)

| # | Process | Trigger | Approval Levels (DOA — example) | System Control | Escalation |
|---|---|---|---|---|---|
| A1 | Quotation margin/discount | Margin < target or discount > X% | Sales Head → Finance → CEO (by band) | Block send until approved | Auto-escalate on aging |
| A2 | T&C deviation | Non-standard terms | Legal/Commercial Head | Flag deviation | — |
| A3 | Project charter/budget | Project creation | PM Head → Finance → CEO (by value) | Block kickoff | — |
| A4 | Schedule baseline / re-plan | Baseline set or major shift | PM → PM Head | Lock baseline, audit | Notify CEO if milestone slips |
| A5 | Purchase Requisition | PR raised | Dept Head → Project Mgr | Block RFQ | — |
| A6 | Purchase Order | PO value band | Buyer → Purchase Head → Director → CEO | Block PO release | Aging escalation |
| A7 | Vendor onboarding | New vendor | Purchase + QA | Block PO to unapproved vendor | — |
| A8 | Stock adjustment/write-off | Variance/obsolete | Stores Head → Finance | Block posting | — |
| A9 | Timesheet / overtime | Period close / OT | Reporting Manager | Block cost posting | — |
| A10 | Work-order release | Production start | Production Head | Block issue if material short | — |
| A11 | FAT sign-off | FAT complete | QC + Customer witness | Block dispatch | — |
| A12 | Dispatch clearance | Ready to ship | QC + Finance (payment) + Commercial | Block dispatch/invoice | — |
| A13 | SAT / Customer acceptance | Commissioning done | Site Lead + Customer | Trigger final billing | — |
| A14 | Change Order / Variation | Scope change | PM → Commercial → Customer | Recost, re-baseline | Margin alert |
| A15 | Warranty claim / goodwill | Service event | Service Head (+ Finance if cost) | Validate warranty | — |
| A16 | CAPA closure | RCA done | QA Head | Block closure w/o effectiveness check | — |
| A17 | Project financial close | Delivery complete | PM + Finance | Lock project costs | — |

**Principle:** Every approval is a **value/threshold-driven, role-based, auditable gate** with configurable DOA and auto-escalation on aging. Bake in **segregation of duties** (e.g., the person raising a PO cannot approve it).

---

## 9. Data Flow & Data Architecture

### 9.1 Master Data (single source of truth — MDM)
`Customer · Vendor · Item/Material · BOM (E/M) · Employee · Workcentre/Resource · Chart of Accounts · Tax/HSN · Currency/UoM · T&C library`
→ These must be governed centrally; **80% of ERP failures are master-data failures.**

### 9.2 Transactional Data Flow (narrative)
1. **Demand in:** Enquiry → Quotation (cost sheet) → on win, **cost sheet becomes Project Budget**.
2. **Plan out:** Project → WBS → Schedule → **need-by dates + resource demand**.
3. **Supply:** Schedule/BOM → PR → PO (**commitment**) → GRN → Inventory (**reservation to project**).
4. **Make:** Reserved material + allocated labour → Work Orders → **consumption (actual cost)** → as-built.
5. **Prove:** Production → FAT (**quality gate**) → Dispatch (**invoice, e-way bill, warranty start**).
6. **Deliver:** Dispatch → Installation → **SAT/CAC (revenue + warranty trigger)**.
7. **Serve:** Warranty/Service tickets → **warranty cost back to project** → Failure Analysis (CAPA → standards).
8. **Account:** All cost (committed + actual) + revenue (milestones) → **Project P&L** → **CEO Dashboard**.

### 9.3 Data Flow Diagram (logical, text form)
```
[Customer/CRM]→[Enquiry]→[Quotation/Cost Sheet]
                                   | (win)
                                   v
                         [Project + WBS + Budget]-----------+
                                   |                         |
                 +-----------------+-----------------+       |
                 v                 v                 v       |
         [Planning/Gantt]   [Engineering/BOM*]  [Workload]   |
                 |                 |                 |        |
       need-by   v     BOM demand  v      alloc      v        |
            [Procurement]--PO-->[Inventory/Critical]-issue-->[Production]
                 |  commit          | reserve            | actuals
                 +------------------+------+             v
                                           |          [FAT]--gate-->[Dispatch]
                                           |             |            | invoice
                                           |             v            v
                                           |      [Failure Analysis]<[Installation/SAT]
                                           |             ^            |
                                           |             +--tickets--[Warranty/Service]
                                           v
                           [PROFITABILITY: committed+actual cost vs revenue]
                                           v
                                  [CEO DASHBOARD]
```
`* Engineering/BOM and the Finance/Billing layer are gaps — see Section 11.`

### 9.4 Integration & Platform Notes
- **Reporting/analytics** on a separate read layer (data warehouse/semantic model) — protects OLTP performance.
- **Audit trail** on every transaction (who/what/when/before/after).
- **RBAC** + segregation of duties enforced at data and action level.
- **APIs** for: e-invoice/e-way bill (statutory), payment/banking, email, customer/vendor portals, optional PLM/CAD.
- **Mobile/offline** for shop floor (M08), site install (M12), field service (M13).

---

## 10. Non-Functional Requirements (NFR)

| Category | Requirement |
|---|---|
| Security | RBAC, segregation of duties, encryption at rest/in transit, MFA, full audit trail |
| Performance | Dashboards < 3s; transaction posting < 1s; concurrent users scalable |
| Availability | 99.5%+; defined RPO/RTO; backup & DR |
| Scalability | Support growth in projects/users without re-architecture |
| Usability | Role-based UI, minimal clicks, mobile-responsive, multilingual-ready |
| Auditability | Immutable logs, approval history, version control on quotes/BOM/schedule |
| Compliance | GST/e-invoice/e-way bill (India), data privacy, statutory reporting |
| Integration | Open APIs, webhook/event support |
| Configurability | Workflows, DOA, forms, document templates configurable without code |
| Data integrity | MDM governance, referential integrity, controlled deletions |

---

## 11. Missing Requirements / Gap Analysis  ⚠️ (Read this)

The 16 modules cover **operations** well but, from an architecture standpoint, the following are required for this to be a true ERP — several are not optional:

**Tier 1 — Mandatory (the system breaks without these):**
1. **Engineering / Design / BOM & PLM** — *Critical.* ETO **is** engineering. Production exists but there is no module that creates **EBOM/MBOM, drawings, revisions, and ECN/ECO (Engineering Change Notice/Order)**. Procurement, Inventory, and Production all depend on BOM. This is the single biggest gap.
2. **Finance & Accounting (GL, AP, AR, costing)** — Profitability cannot be real without a ledger. Vendor invoices (AP), customer payments (AR), cost postings, and reconciliations live here.
3. **Billing / Invoicing & Revenue Recognition** — Milestone/advance/progress billing, retention, credit notes. Dispatch (M11) and Installation (M12) trigger billing — but there's no billing engine defined.
4. **Taxation & Statutory (India)** — GST, **e-invoicing (IRN)**, **e-way bill**, HSN/SAC, TDS. Legally mandatory for dispatch/invoicing.
5. **Change / Variation Management** — Scope changes are constant in ETO; without formal change orders, margin erosion is invisible. (Referenced in M15 but needs to be a first-class capability.)

**Tier 2 — Strongly recommended:**
6. **Quality Management System (QMS)** — Incoming/in-process inspection, NCR, gauge/calibration; ties M05→M06→M08→M10→M14 together.
7. **Document Management System (DMS)** — Drawings, specs, test certs, contracts with **version control & controlled access**. ETO is document-heavy.
8. **HRMS core** — Employee master, leave, attendance, payroll. M07 (Workload) and timesheets depend on it.
9. **Subcontracting / Job-Work management** — Issue material to vendor, track WIP at vendor, receive — extremely common in manufacturing.
10. **Contract Management** — Customer contracts, LD/penalty clauses, payment terms, warranty obligations.
11. **CRM (full)** — Beyond enquiry: pipeline, follow-ups, customer 360, repeat business.

**Tier 3 — Value-adds (phase later):**
12. **Customer Portal & Vendor Portal** (self-service tickets, PO acknowledgement).
13. **Plant Maintenance / Asset & Tooling** (own machines/tools).
14. **Risk & Issue Register** (project-level).
15. **Notifications/Alerts engine** (cross-cutting).
16. **Spares catalog & service inventory** (supports M13).
17. **EHS / Compliance** (site safety, statutory).
18. **Cash-flow & treasury** view (project-linked cash).

> **Recommendation:** Do **not** start the build until at least **Engineering/BOM (1)** and the **Finance/Billing/Tax layer (2–4)** are scoped. They are load-bearing for almost every listed module. The other gaps can be phased.

---

## 12. Industry Best Practices (ETO / Project Manufacturing)

1. **Lock the quote cost sheet as the project budget baseline.** Margin discipline starts at quoting, not delivery.
2. **Drive procurement from the schedule; order critical/long-lead items at project sanction.** This is the #1 lever on OTD.
3. **Use commitment accounting** — show committed (PO) cost in project P&L, not just invoiced.
4. **Adopt Earned Value (CPI/SPI)** for objective schedule & cost truth.
5. **Manage EBOM vs MBOM separately** and run **formal Engineering Change Management (ECN/ECO)**.
6. **Make timesheets mandatory** — labour cost is fiction without them.
7. **Gate dispatch on Quality + Commercial + Documentation** (FAT pass, payment milestone, e-invoice/e-way bill).
8. **Close the quality loop:** FAT/SAT/Warranty failures → RCA → CAPA → Design/Process standards.
9. **Treat Change Orders as sacred** — every scope change re-costs and re-baselines; uncompensated scope creep is the silent margin killer.
10. **One MDM source of truth** for Item/BOM/Vendor/Customer — govern it ruthlessly.
11. **Segregation of duties + DOA-based approvals** with full audit trail.
12. **Mobile/offline for shop floor & field** (production, installation, service).
13. **Reporting on a separate semantic/warehouse layer** for the CEO dashboard.
14. **Phase the go-live** (see roadmap) — never big-bang an ETO ERP.
15. **Customer Acceptance Certificate = revenue & warranty trigger** — control it tightly.

---

## 13. Recommended Implementation Roadmap (phased)

| Phase | Modules | Rationale |
|---|---|---|
| **P0 Foundation** | MDM (Customer/Vendor/Item/BOM), RBAC, Audit, **Engineering/BOM**, **Finance/GL/Tax** | Load-bearing — must exist first |
| **P1 Order Intake** | M01 Enquiry, M02 Quotation, basic CRM | Front-end value, win-rate data |
| **P2 Project Backbone** | M03 Project, M04 Planning/Gantt, M07 Workload | The project spine |
| **P3 Supply** | M05 Procurement, M06 Inventory & Critical Items, Subcontracting | Critical-item control |
| **P4 Make & Prove** | M08 Production, M10 FAT, QMS | Execution + quality gates |
| **P5 Deliver** | M11 Dispatch (+Billing/E-invoice/E-way bill), M12 Installation | Revenue triggers |
| **P6 Serve & Learn** | M13 Warranty/Service, M14 Failure Analysis | Closed-loop quality |
| **P7 Insight** | M09 Delivery Prediction, M15 Profitability, M16 CEO Dashboard | Analytics on clean data |

> Delivery Prediction (M09) and the dashboards (M16) come **last** deliberately — they're only as good as the operational data feeding them.

---

## 14. Assumptions, Risks & Constraints

| Type | Item |
|---|---|
| Assumption | India statutory context (GST/e-invoice/e-way bill) applies |
| Assumption | Predominantly ETO with subcontracting; some repeat/configurable products |
| Risk | **Missing Engineering/BOM & Finance layers** — top project risk if unaddressed |
| Risk | Master-data quality at migration |
| Risk | Shop-floor & field adoption (mobile/offline UX) |
| Risk | Scope creep across 16+ modules — mitigate via phasing |
| Constraint | Statutory integrations (e-invoice/e-way bill) are mandatory, non-negotiable |

---

## 15. Glossary (selected)

**ETO** Engineer-to-Order · **WBS** Work Breakdown Structure · **EBOM/MBOM** Engineering/Manufacturing BOM · **CPM** Critical Path Method · **EVM** Earned Value Mgmt (PV/EV/AC→CPI/SPI) · **DOA** Delegation of Authority · **PR/PO/GRN** Purchase Requisition/Order, Goods Receipt Note · **FAT/SAT** Factory/Site Acceptance Test · **NCR** Non-Conformance Report · **CAPA** Corrective & Preventive Action · **RCA** Root Cause Analysis · **AMC** Annual Maintenance Contract · **SLA** Service Level Agreement · **CAC** Customer Acceptance Certificate · **EAC** Estimate at Completion · **ECN/ECO** Engineering Change Notice/Order · **LD** Liquidated Damages.

---

*End of FRD v1.0.*
