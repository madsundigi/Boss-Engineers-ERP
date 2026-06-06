# Edge-Case & Issue Register — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-QA-002 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Author | QA Lead |
| Method | Code audit of built modules (M01 Enquiry, M02 Quotation, platform) + design review of M03–M16 |
| Status | Baseline — triage required |

Every module searched for **Missing Validation · Broken Workflow · Permission Issues · Data Loss Risk · Race Conditions · Concurrency Issues**. Each issue is tagged **[BUILT]** (found in running code, with evidence) or **[DESIGN]** (anticipated in a designed-but-unbuilt module).

**Severity:** S1 Critical (data loss / security / correctness — block release) · S2 High (fix before module GA) · S3 Medium · S4 Low.

**Summary:** 34 issues — **S1: 4 · S2: 16 · S3: 12 · S4: 2**. Top blockers: gateway/JWT trust, cross-module non-atomicity, missing row-level data scope, SoD/DOA not enforced, inventory reservation race.

---

## A. Missing Validation
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| MV-01 | S2 | Platform [BUILT] | Identity (`x-user-id/-company-id/-bu-id`) is **trusted from headers** with no token verification — `src/common/auth.ts` (gateway stub). | Auth bypass / tenant spoofing if deployed without an enforcing gateway. | Verify a signed JWT; derive tenant server-side; never trust raw headers at the edge. |
| MV-02 | S2 | Enquiry, Quotation [BUILT] | `bu_id` is **not checked to belong to `company_id`** before numbering (`*.repository.create`). | Cross-branch/tenant number allocation; integrity break. | Validate `business_unit.company_id = company_id` (FK-scoped lookup) before allocate. |
| MV-03 | S2 | All [BUILT] | **Money computed in JS floating point** then rounded to 2dp, while DB is `NUMERIC(20,4)` — `quotation.service.ts` `round()`, `qty*unitPrice`. | Precision drift / reconciliation mismatches on large ₹ values and 4-dp totals. | Use a decimal library (decimal.js) or compute totals in SQL `NUMERIC`. |
| MV-04 | S3 | Quotation [BUILT] | `currencyCode` is a free 3-char string, not validated against a currency master — `quotation.dto.ts`. | Invalid currency (e.g. 'XYZ') persisted. | Enum/FK against `mdm.currency`. |
| MV-05 | S3 | Quotation [BUILT] | `validUntil` only format-checked; not required future-dated or ≥ `quote_date`. | Quotes "valid until" a past date. | Add date-logic validation. |
| MV-06 | S3 | Quotation [BUILT] | **No upper bound on line count**; body cap 256kb only. | Large payload → memory/CPU (mini-DoS). | Cap `lines` (e.g. ≤ 500) in the DTO. |
| MV-07 | S3 | Quotation [BUILT] | No sanity check `totalCost` vs `totalPrice` (negative margin silently allowed beyond the approval flag). | Loss-making quotes slip through if approver inattentive. | Warn/block when margin < 0 unless explicitly overridden. |
| MV-08 | S3 | Masters [DESIGN] | No customer/vendor **dedupe** (name/GSTIN) at create. | Duplicate masters; split history. | Unique GSTIN + fuzzy-match guard. |

## B. Broken Workflow
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| BW-01 | S2 | Quotation↔Enquiry [BUILT] | **Cross-module sync runs in a separate transaction** from the quote mutation, best-effort, silent — `quotation.service.ts` convert/markWon/markLost call `enquiries.changeStatus(...)` after the quote tx; the returned `null` (version mismatch) is ignored. | Quote created/won but enquiry **not advanced** → inconsistent lifecycle; no error surfaced. | Transactional outbox / shared tx; on sync failure, reconcile or fail loudly. |
| BW-02 | S2 | Quotation [BUILT] | **Email sent before the DB commit** — `quotation.service.ts:157` emails the PDF, then `:163` updates status to SENT (no version lock). If the update fails, the customer has the quote but the system shows APPROVED; retry double-sends. | Customer/system divergence; duplicate emails. | Commit state first (or outbox), dispatch email from the relay; idempotent send. |
| BW-03 | S3 | Quotation [BUILT] | `markWon` only syncs the enquiry **if its status is exactly `QUOTED`** (`:176`); any other state silently skips. | Enquiry can stay QUOTED after the quote is WON. | Reconcile by `enquiry_id` link regardless of state, or assert+alert. |
| BW-04 | S2 | All [BUILT] | **App never emits semantic audit events** (`audit.log_event` is unused) — APPROVE/REJECT/EXPORT/LOGIN/LOGOUT are not recorded as such; only generic CRUD via DB triggers. | Audit/compliance gap: cannot distinguish an approval or an export in the trail. | Call `audit.log_event` on approve/reject/send/export/login. |
| BW-05 | S2 | Dispatch [DESIGN] | Multi-gate release (FAT + payment + commercial) has **no saga/compensation** defined. | A partial gate pass could dispatch un-paid/un-tested goods. | Model as a saga with explicit gate checks + compensation. |
| BW-06 | S2 | Installation→Finance [DESIGN] | CAC triggers **final billing**, but the Billing/AR module is a **gap**. | Accepted installs are unbillable; dangling trigger. | Build Finance/Billing before wiring M12 billing trigger. |
| BW-07 | S3 | Enquiry [BUILT] | LOST requires a reason in the service, but the reason is **not persisted** (`lost_reason_id` stays null). | Lost-reason intelligence is discarded. | Persist reason (link `mdm.reason_code` or a text column). |

## C. Permission Issues
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| PI-01 | S2 | All [BUILT] | **No row-level data scope** — repositories filter by `company_id` only; `created_by`/territory/branch not enforced, contradicting RBAC doc (Sales→own territory, PM→own projects). | A Sales user can read/edit/delete **any** enquiry/quote in the company. | Implement PostgreSQL RLS + scope predicates per role. |
| PI-02 | S2 | Quotation [BUILT] | **DOA value-band not enforced** — any `QUOTATION.APPROVE` holder approves any value (`quotation.routes`/`service.approve`). | A junior approver clears a high-value, margin-thin quote. | Enforce approver tier vs value band in the approval engine. |
| PI-03 | S2 | Quotation [BUILT] | **Segregation of Duties not enforced at runtime** — `decided_by` is not checked `≠ created_by/submitted_by`; the SoD table exists in DB but no code check. | Creator can approve their own quote if they hold APPROVE. | Block self-approval; consult `sec.sod_conflict`. |
| PI-04 | S3 | All [BUILT] | Export endpoints return **all company rows ignoring data scope** (compounds PI-01). | Over-exposure of records a user shouldn't see. | Apply the same scope to exports; audit the export. |
| PI-05 | S3 | Platform [BUILT] | Permissions re-loaded from DB **every request, no cache**; also no rate limiting. | DB load under concurrency; brute-force surface. | Cache perms (short TTL) + rate-limit auth. |

## D. Data Loss Risk
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| DL-01 | S1 | Platform [DESIGN] | **No codified backup / PITR / DR procedure** for the application DB (audit WORM seals aside). | Catastrophic loss on failure. | Define backups, PITR, restore drills before go-live. |
| DL-02 | S2 | All [BUILT] | **No idempotency keys** on `POST` create — retry/double-click creates **duplicate** enquiries/quotes and **consumes gapless document numbers** irreversibly. | Duplicate documents; "missing" numbers questioned by auditors. | Idempotency-Key header + dedupe window. |
| DL-03 | S3 | Quotation [BUILT] | Update **replaces all lines** (DELETE+INSERT) — `quotation.repository.update`; line ids/history lost each edit. | No line-level history; harder audit of what changed. | Soft-version lines or diff-apply. |
| DL-04 | S3 | Quotation [BUILT] | Sent PDF is **not persisted** — `pdf_ref` is a logical string; the exact emitted artifact isn't stored. | Cannot reproduce "what the customer received". | Store the rendered PDF (object store) keyed by `pdf_ref`. |
| DL-05 | S2 | Inventory/Production [DESIGN] | Stock adjustments / consumption without an immutable movement ledger reconciliation could mask loss. | Untraceable stock variance. | Enforce double-entry stock-movement ledger. |

## E. Race Conditions
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| RC-01 | S2 | Quotation [BUILT] | **Double-convert race** — two concurrent `from-enquiry` calls both read the enquiry as QUALIFIED and both create quotes; the 2nd enquiry `changeStatus` fails the version check and is ignored → **two quotations for one enquiry**. | Duplicate quotes; ambiguous lineage. | Lock the enquiry (`SELECT … FOR UPDATE`) or unique constraint on `(enquiry_id)` for active quotes. |
| RC-02 | S2 | Quotation [BUILT] | **`send` has no optimistic lock** — `updateStatus(ctx,id,null,'SENT',…)` (`:163`); TOCTOU between `getById` and the write. | Concurrent send / send-during-revise both succeed; double email. | Pass `rowVersion`; re-check status under lock. |
| RC-03 | S1 | Inventory [DESIGN] | **Concurrent project reservations** against the same stock can **oversell** (no reservation lock defined). | Negative/oversold stock; production starved. | `SELECT … FOR UPDATE` on stock row; atomic reserve. |
| RC-04 | S2 | Production [DESIGN] | Backflush consumption **double-posts** under concurrent WO confirmations. | Inventory under-stated; cost wrong. | Idempotent confirmation + row locks. |
| RC-05 | S3 | Numbering [BUILT] | Gapless counter row-lock **serializes a hot series** (by design) — correctness OK, but a contention point. | Throughput ceiling on a very hot doc type. | Per-branch series (already) + monitor; sequence mode for non-statutory. |

## F. Concurrency Issues
| ID | Sev | Module | Issue & Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| CC-01 | S2 | Architecture [BUILT] | **No shared transaction across modules** — each `runInContext` is its own tx; multi-aggregate ops aren't atomic (root cause of BW-01/BW-02/RC-01). | Partial failures leave inconsistent state. | Adopt the **transactional outbox** before building M03 (per INTEGRATION_ARCHITECTURE §8). |
| CC-02 | S1 | Dispatch/Finance [DESIGN] | Payment-gate + invoice + e-way bill across services with no distributed-consistency strategy. | Goods shipped without secured payment; tax docs mismatched. | Saga + idempotent external calls + reconciliation. |
| CC-03 | S3 | Audit [BUILT] | Hash-chain **seal** computed by a periodic job; the live insert path isn't chained — a tamper within the unsealed window is only caught at next seal. | Short detection-latency window. | Seal frequently; consider per-row prev-hash for statutory docs. |
| CC-04 | S4 | CEO Dashboard [BUILT] | Matviews are **eventually consistent** (5–15 min). | Stale executive numbers. | Acceptable; the UI shows "data as of" (already). |
| CC-05 | S4 | Platform [BUILT] | Per-request permission DB reads add load under concurrency (see PI-05). | Scaling cost. | Cache with TTL. |

---

## G. Correctly Handled (verified — no action)
- **Optimistic concurrency** via `row_version` on `submit/approve/reject/won/lost/update/revise` (except `send` — RC-02).
- **Gapless, no-duplicate numbering** under concurrency (row-locked counter; tested).
- **Append-only audit** at the DB layer (UPDATE/DELETE revoked; tamper-evident — tested).
- **Parameterized SQL** throughout — no SQL injection surface.
- **RBAC guard** on every route; deny-by-default (table-level).
- **Tenant company scoping** on all queries.
- **Migration idempotency** and full-schema build verified each iteration.

## H. Remediation Priority (do in this order)
1. **MV-01 / PI-04** — enforce gateway JWT (security).
2. **CC-01 / BW-01 / BW-02 / RC-01** — transactional outbox + fix email-before-commit (consistency).
3. **RC-03** — inventory reservation locking (before building M06).
4. **PI-01 / PI-04** — row-level data scope (RLS).
5. **PI-02 / PI-03 / BW-04** — DOA + SoD + semantic audit in the approval engine.
6. **RC-02** — optimistic lock on `send`.
7. **MV-03 / DL-02** — decimal money + idempotency keys.
8. **DL-01 / CC-02** — backup/DR + dispatch saga before go-live.
