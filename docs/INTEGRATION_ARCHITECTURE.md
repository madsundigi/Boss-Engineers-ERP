# Integration Architecture & Map — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-INT-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Builds on | FRD (deps), SCREEN_INVENTORY (flows), NUMBERING, RBAC, AUDIT, MODULE_ENQUIRY, MODULE_QUOTATION |
| Status | Baseline |

How every module talks to every other module: triggers, source → destination, the data passed, and the validation enforced at each hop — plus the mechanisms and contracts that make it reliable. **Status** marks what is **Built** (running app code / DB) vs **Designed** (schema + screens, not yet coded).

---

## 1. Module Review (implementation status)
| Module | DB schema | Screens | App code | Integrations live |
|---|---|---|---|---|
| M01 Customer Enquiry | ✅ | ✅ | ✅ Built | ↔ Quotation |
| M02 Quotation | ✅ | ✅ | ✅ Built | ↔ Enquiry; → Project (designed) |
| M03 Project Creation | ✅ | ✅ | ⬜ Designed | — |
| M04 Planning & Gantt | ✅ | ✅ | ⬜ Designed | — |
| M05 Procurement | ✅ | ✅ | ⬜ Designed | — |
| M06 Inventory & Critical Items | ✅ | ✅ | ⬜ Designed | — |
| M07 Employee Workload | ✅ | ✅ | ⬜ Designed | — |
| M08 Production | ✅ | ✅ | ⬜ Designed | — |
| M09 Delivery Prediction | ✅ | ✅ | ⬜ Designed | — |
| M10 FAT | ✅ | ✅ | ⬜ Designed | — |
| M11 Dispatch | ✅ | ✅ | ⬜ Designed | — |
| M12 Installation | ✅ | ✅ | ⬜ Designed | — |
| M13 Warranty & Service | ✅ | ✅ | ⬜ Designed | — |
| M14 Failure Analysis | ✅ | ✅ | ⬜ Designed | — |
| M15 Profitability | ✅ | ✅ | ⬜ Designed | — |
| M16 CEO Dashboard | ✅ | ✅ | ⬜ Designed | — |
| Masters (Customer/Vendor/Item/BOM/Employee) | ✅ | ✅ | ⬜ Designed | — |
| **Finance/Billing/Tax** | ⚠️ partial (gap) | ✅ | ⬜ Designed | — |
| **Engineering/Design/BOM** | ⚠️ partial (gap) | ✅ | ⬜ Designed | — |
| Platform: Numbering | ✅ | — | ✅ Built | all modules |
| Platform: RBAC | ✅ | ✅ | ✅ Built | all modules |
| Platform: Audit | ✅ | ✅ | ✅ Built | all modules |
| Platform: Approval/DOA engine | ✅ matrix | ✅ | ⬜ Designed (thresholds built in M02) | approval hops |
| Platform: PDF / Email | — | — | ✅ Built | document send |
| Platform: Notifications | ⬜ | ⬜ | ⬜ Designed | alerts |

---

## 2. Integration Mechanisms (how modules connect)
| # | Mechanism | Use for | Status |
|---|---|---|---|
| 1 | **In-process service call** (modular monolith) | Tight, ordered handoffs between aggregates in one bounded context (e.g. Quotation→Enquiry). Caller invokes the destination module's repository/service. | Built (M01↔M02) |
| 2 | **Transactional outbox + domain events** | Reliable, decoupled fan-out across aggregates (e.g. Quotation.WON → Project). Source writes state + an `outbox` row in one transaction; a relay publishes; consumers apply idempotently. | Recommended / Designed |
| 3 | **Database triggers & constraints** | Referential integrity (FKs), derived data (generated `margin_pct`), audit capture, status-history, gapless numbering. | Built |
| 4 | **Shared platform services** | Cross-cutting concerns every module calls: Numbering, RBAC guard, Audit, Approval/DOA, Notifications, PDF, Email. | Mostly Built |
| 5 | **Read model / projection** | Reporting & executive views (Profitability roll-up, CEO Dashboard) read from a semantic/reporting layer, never write back. | Designed |

**Rule of thumb:** same-request, must-be-consistent → mechanism 1 (ideally wrapped by 2's outbox); everything else → mechanism 2.

## 3. Integration Contracts & Principles
- **Context propagation:** every hop carries `company_id, bu_id, user_id, client_ip, session_id`; writes push these into PG session GUCs so audit attributes the change. (Built.)
- **Optimistic concurrency:** cross-module status writes use `row_version` (e.g. Quotation→Enquiry passes the enquiry's version). Mismatch → `409`. (Built.)
- **Idempotency:** async consumers key on `eventId` (or a natural key) so re-delivery is safe.
- **Atomicity / saga:** prefer the outbox so the state change and the event commit together; multi-step flows (e.g. dispatch = quality + payment + docs) run as a saga with compensation, not a distributed transaction.
- **Anti-corruption:** each module **owns its tables**; other modules read/write through the owning module's repository/API — never by writing foreign tables directly.
- **Event envelope:** `{ eventId, type, occurredAt, companyId, buId, actor, correlationId, payload }`. `correlationId` threads a whole business journey for tracing.
- **Validation at every hop:** state precondition (status), RBAC permission, DOA/SoD on approvals, referential checks, and DB constraints as defence in depth.
- **Failure handling:** sync hop → propagate `4xx/409`; async consumer → retry w/ backoff → dead-letter + alert.

---

## 4. Integration Map

> Core columns are the five requested — **Trigger · Source · Destination · Data Passed · Validation** — plus **Status**. `*` = depends on a flagged gap module (Finance/Engineering).

### 4A. Sales → Project (the order-to-cash spine)
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 1 | Enquiry qualified (NEW→QUALIFIED) | M01 Enquiry | M02 Quotation (enables quote) | enquiry id, customer snapshot, requirement | enquiry exists & QUALIFIED; `QUOTATION.CREATE` | Built |
| 2 | Convert enquiry → quotation | M02 Quotation | M01 Enquiry (→QUOTED) | enquiry_id link, quotation_no | enquiry QUALIFIED; optimistic lock (row_version) | Built |
| 3 | Quotation submitted | M02 Quotation | Approval/DOA engine | margin %, discount %, value, DOA band | status DRAFT; thresholds (margin<15 / disc>10); SoD | Built (thresholds) / Designed (engine) |
| 4 | Approver decides | Approval engine | M02 Quotation (APPROVED/REJECTED) | decision, approver, reason | `QUOTATION.APPROVE`; creator≠approver | Built (perm) / Designed (SoD) |
| 5 | **Quotation WON** | M02 Quotation | M03 Project (create) | quotation_id, customer, contract value, **cost baseline**, terms, lines→scope | quote=WON; project not already created; budget baseline locked | Designed |
| 6 | Quotation WON | M02 Quotation | M01 Enquiry (→CONVERTED) | enquiry_id | enquiry=QUOTED; optimistic lock | Built |
| 7 | Quotation LOST | M02 Quotation | M01 Enquiry (→LOST) | enquiry_id, reason | linked enquiry present | Built |

### 4B. Project → Plan → Supply
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 8 | Project created/approved | M03 Project | M04 Planning (seed WBS) | project_id, milestones, budget | project charter APPROVED | Designed |
| 9 | Baseline approved → need-by dates | M04 Planning | M05 Procurement + M06 Critical Items | BOM demand, need-by dates | baseline approved; BOM exists* | Designed |
| 10 | Critical/long-lead item flagged | M06 Inventory | M05 Procurement (early PR) | item, lead time, need-by date | item in critical-item register | Designed |
| 11 | PR raised | M05 Procurement | Approval/DOA | PR value, project peg | DOA band; budget available | Designed |
| 12 | **PO approved** | M05 Procurement | M15 Profitability (commitment) | committed cost, PO value | PO approved; committed ≤ budget | Designed |
| 13 | PO approved | M05 Procurement | M06 Inventory (expected receipt) | item, qty, ETA | PO approved | Designed |
| 14 | GRN posted | M05 Procurement | M06 Inventory (stock ↑) | received qty, batch/serial, location | matches PO; QC inspection pass | Designed |
| 15 | GRN posted | M05 Procurement | Finance AP (3-way match) | PO–GRN–invoice | 3-way match within tolerance | Designed* |
| 16 | Material reserved/issued | M06 Inventory | M08 Production | reservation, issued qty | stock available; project peg | Designed |

### 4C. Resourcing & Production
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 17 | Tasks assigned | M04 Planning | M07 Workload | assignments, dates, skills | capacity check | Designed |
| 18 | Timesheet approved | M07 Workload | M15 Profitability | hours × rate (labour actual) | timesheet approved | Designed |
| 19 | Work order released | M08 Production | M06 Inventory + M07 Workload | BOM consumption, operations | material-short → block; WO release approved | Designed |
| 20 | Production confirmed | M08 Production | M15 Profitability + M09 | actual material+labour, % complete, **as-built/serials** | confirmation valid | Designed |
| 21 | Progress + readiness + capacity | M04/M06/M07/M08 | M09 Delivery Prediction | % complete, material readiness, capacity, history | data freshness | Designed |

### 4D. Quality → Dispatch → Site → Service
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 22 | WO complete | M08 Production | M10 FAT | as-built, serials, test protocol | WO complete | Designed |
| 23 | **FAT pass + sign-off** | M10 FAT | M11 Dispatch (clearance gate) | FAT report, sign-off | FAT passed/waiver; `FAT.APPROVE` (QC) | Designed |
| 24 | Any failure/NCR | M08/M10/M12/M13 | M14 Failure Analysis | failure mode, evidence, source ref | NCR raised | Designed |
| 25 | **Dispatch released** | M11 Dispatch | Finance AR (invoice / e-invoice / e-way bill) | invoice, serials, dispatch date, HSN/tax | **multi-gate**: FAT pass + payment milestone + commercial clearance | Designed* |
| 26 | Payment-milestone gate | Finance AR | M11 Dispatch (clearance) | payment milestone, credit status | credit check; milestone met | Designed* |
| 27 | Dispatch released | M11 Dispatch | M13 Warranty (start clock) | serial, dispatch date, warranty terms | dispatched | Designed |
| 28 | Dispatch released | M11 Dispatch | M12 Installation (create job) | shipment, ship-to, serials | dispatched | Designed |
| 29 | SAT / Customer Acceptance (CAC) | M12 Installation | Finance AR (final milestone) + M13 (warranty confirm) | CAC, commissioning report | customer SAT sign-off | Designed* |
| 30 | Service ticket resolved | M13 Warranty/Service | M15 Profitability + M14 Failure | warranty cost (parts/labour/travel), failure data | warranty valid (serial in-warranty) | Designed |
| 31 | CAPA approved/closed | M14 Failure Analysis | Engineering/BOM + M08/M10 (standards) | design change, CAPA actions | CAPA effectiveness verified | Designed* |

### 4E. Finance & Executive
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 32 | Cost (committed+actual) + revenue (milestones) | M05/M06/M07/M08/M12/M13 + Finance | M15 Profitability (roll-up) | cost ledger, revenue recognition | postings valid | Designed* |
| 33 | Change Order approved | Change Order | M03 + M04 + M15 (re-cost, re-baseline) | scope Δ, price Δ | change approved (customer + commercial) | Designed |
| 34 | Any KPI / P&L update | M01–M15 | M16 CEO Dashboard | aggregated KPIs (read-only) | read-model freshness | Designed |

### 4F. Cross-cutting platform services (every module)
| # | Trigger | Source | Destination | Data Passed | Validation | Status |
|---|---|---|---|---|---|---|
| 35 | Any document created | All modules | **Numbering** service | company, branch, doc_type [, model] | rule exists; branch context; gapless allocation | Built |
| 36 | Any action attempted | All modules | **RBAC** guard | `MODULE.ACTION` permission code | permission held; deny-by-default | Built |
| 37 | Any CRUD / approve / reject / login / logout / export | All modules | **Audit** (append-only) | user, ip, timestamp, old/new, event_type | append-only; tamper-evident hash-chain | Built |
| 38 | Submit / threshold breach | Approval-bearing modules | **Approval/DOA** engine | DOA band, value, approver tier | SoD (creator≠approver); value band; escalation | Designed (RBAC+thresholds built) |
| 39 | Approval pending / SLA breach / critical-item alert | various | **Notifications** | recipient, channel, message, deep-link | recipient resolves; throttling | Designed |
| 40 | Document send (quote / PO / invoice) | M02 / M05 / Finance | **PDF + Email** services | doc model → PDF; recipient | recipient present; template valid | Built (PDF/email) |

---

## 5. End-to-End Integration Flow (text diagram)
```
[M01 Enquiry] --qualified/convert--> [M02 Quotation] --submit--> (Approval/DOA)
      ^  CONVERTED/LOST (sync back)        |  WON
      |                                    v
      +------------------------------ [M03 Project] --seed--> [M04 Planning/Gantt]
                                              |                     | need-by dates
                                              |          +----------+----------+
                                              |          v                     v
                                       [M07 Workload]  [M05 Procurement] --PO--> [M06 Inventory/Critical]
                                              | hours        | commit (M15)        | reserve/issue
                                              +------+-------+---------------------+----+
                                                     v                                  v
                                              [M08 Production] --as-built--> [M10 FAT] --gate--> [M11 Dispatch]
                                                     | actuals (M15)            | NCR (M14)         | invoice (AR*)
                                                     v                          v                  v
                                              [M09 Delivery Prediction]  [M14 Failure]<---[M12 Installation/SAT]
                                                                               ^ CAPA            | warranty start
                                                                               +----[M13 Warranty/Service]
                                                                                         | cost (M15)
                  cross-cutting (all hops): Numbering · RBAC · Audit · Approval/DOA · Notifications
                                                     |
                                              [M15 Profitability] --> [M16 CEO Dashboard]
```
`* invoice/AR/AP and CAPA→Engineering depend on the flagged Finance/Engineering gaps.`

## 6. Reference Integration Contract — `Quotation.WON → Project.Create`
The canonical fan-out hop; implement with the transactional outbox.
```
Trigger:      Quotation status -> WON  (POST /api/quotations/:id/won)
Source:       M02 Quotation        Destination: M03 Project
Validation:   quote=SENT/NEGOTIATION; QUOTATION.EDIT; no existing project for quotation_id;
              creator≠approver already satisfied at approval; budget baseline present
Event:        { eventId, type:"quotation.won", occurredAt, companyId, buId, actor, correlationId,
                payload:{ quotationId, quotationNo, customerName, customerId?, contractValue:totalPrice,
                          costBaseline:totalCost, currencyCode, terms, lines } }
Sequence:     1) M02 tx: set WON + insert outbox(event)  [atomic]
              2) relay publishes event
              3) M03 consumer (idempotent on quotationId): create Project with budget baseline,
                 allocate PROJECT number (Numbering), audit CREATE, raise project.created
              4) M02 sync-back already moved the Enquiry -> CONVERTED (Built)
Compensation: if M03 rejects (duplicate/validation), event dead-letters + alerts Sales; quote stays WON
```
*(Today M02→M01 is a direct in-process call with optimistic locking; M02→M03 will follow this outbox contract when M03 is built.)*

## 7. Implemented vs Designed — summary
- **Built & verified:** M01↔M02 status sync (convert→QUOTED, won→CONVERTED, lost→LOST) via in-process calls with optimistic locking; Numbering, RBAC guard, Audit capture, PDF, Email; approval thresholds in M02.
- **Designed (contracts above, not yet coded):** all hops touching M03–M16 and Finance/Engineering. They share the same five validation classes (state precondition · RBAC · DOA/SoD · referential · DB constraint).

## 8. Recommendations
1. **Adopt the transactional outbox now** (before M03) so cross-aggregate hops are reliable and replayable — retrofitting later is costly.
2. **Close the Finance/Billing/Tax and Engineering/BOM gaps** — hops 5, 9, 15, 25, 26, 29, 31, 32 depend on them; they are load-bearing for the spine.
3. **Build the Approval/DOA engine as a shared service** (it recurs at hops 3, 11, 23, 25, 33) rather than per-module.
4. **Model multi-gate releases (dispatch) as sagas** with explicit compensation.
5. **Stand up a Notifications service** early — approvals, SLA, and critical-item alerts all depend on it.
6. **Thread `correlationId`** from Enquiry through to Dispatch for end-to-end traceability in the audit trail.
