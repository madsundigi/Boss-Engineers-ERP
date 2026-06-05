# Document Numbering Architecture — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-NUM-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Implementation | `db/07_numbering.sql` |
| Status | Verified — builds & functionally tested on PostgreSQL 16 |

Covers: Enquiry, Quotation, Project, Purchase Request, PO, GRN, FAT, Dispatch, Installation, Service Ticket, Machine Serial.

---

## 1. Design Principles
| Principle | Mechanism |
|---|---|
| **Auto-generated** | One DB function `mdm.next_document_no(company, branch, doc_type [, model])`; the app never constructs numbers. |
| **No duplicates** | Atomic counter increment under a row lock + `UNIQUE(company, full_number)` on the issuance ledger + `UNIQUE(*_no)` on each document table (three independent guards). |
| **Gapless (statutory)** | Counter increments inside the document's own transaction → a rolled-back document consumes no number; cancelled docs keep their number. |
| **Multi-year** | Period key derived from date + company fiscal-year-start; the counter auto-resets at period rollover (no job, no race). |
| **Multi-branch** | Branch (business unit) is part of the series key → each branch runs an independent counter. |
| **Audit compliant** | Append-only `numbering_allocation` ledger (who/when/number/doc) + gap-detection view; numbers immutable once assigned. |
| **Configurable** | Prefix, format, padding, reset policy are data in `mdm.numbering_rule` — change without code. |

## 2. Number Anatomy
```
  ENQ / MUM / 2026-27 / 000123
  prefix  branch  period   zero-padded sequence (per company+branch+doc_type+period)
```
Template tokens: `{PREFIX} {BRANCH} {FY} {SEQ}` (and `{MODEL}` for serials), configurable separator.

## 3. Per-Document Format
| Document | doc_type | Prefix | Template | Reset | Scope | Example (verified) |
|---|---|---|---|---|---|---|
| Enquiry | `ENQUIRY` | ENQ | `{PREFIX}/{BRANCH}/{FY}/{SEQ}` | Fiscal year | branch | `ENQ/MUM/2026-27/000001` |
| Quotation | `QUOTATION` | QTN | same | FY | branch | `QTN/MUM/2026-27/000045` (rev → `…-R2`) |
| Project | `PROJECT` | PRJ | same | FY | branch | `PRJ/MUM/2026-27/00012` |
| Purchase Request | `PR` | PR | same | FY | branch | `PR/MUM/2026-27/000234` |
| Purchase Order | `PO` | PO | same | FY (statutory) | branch | `PO/MUM/2026-27/000001` (amend → `…-A1`) |
| GRN | `GRN` | GRN | same | FY (gapless) | branch | `GRN/MUM/2026-27/000001` |
| FAT | `FAT` | FAT | same | FY | branch | `FAT/MUM/2026-27/00078` |
| Dispatch | `DISPATCH` | DSP | same | FY (gapless, e-way) | branch | `DSP/MUM/2026-27/000099` |
| Installation | `INSTALL` | INST | same | FY | branch | `INST/MUM/2026-27/00045` |
| Service Ticket | `SERVICE_TICKET` | TKT | same | FY | branch | `TKT/MUM/2026-27/001234` |
| **Machine Serial** | `MACHINE_SERIAL` | BE | `{PREFIX}-{MODEL}-{FY}-{SEQ}` | **Calendar year** | **per model (not branch)** | `BE-XR200-2026-00001` |

**Machine Serial is intentionally different** — a permanent product-identity number stamped on the unit: calendar year of manufacture (not FY), scoped per model (each model restarts at `00001` per year), never reused/renumbered (drives warranty + failure traceability). GST **Invoice** uses the same engine with strict gapless-per-FY-per-GSTIN.

## 4. Data Model (`db/07_numbering.sql`)
- **`mdm.numbering_rule`** — series definition per `(company, bu_id NULL=company-wide, doc_type)`: `prefix, format_template, pad_width, separator, reset_policy (FY|CALYEAR|MONTH|NONE), start_no, is_gapless`. A branch-specific rule overrides the company-wide fallback automatically.
- **`mdm.numbering_counter`** — live counter `(rule_id, period_key) → next_no`; the only hot/locked row; auto-created per period. For serials, `period_key` carries the model (e.g. `2026|XR200`) so each model has its own sequence.
- **`mdm.numbering_allocation`** — append-only issuance ledger; `UNIQUE(company, full_number)` + `UNIQUE(rule_id, period_key, seq_no)`.

## 5. Allocation Algorithm (concurrency-safe + gapless)
```sql
INSERT INTO mdm.numbering_counter(rule_id, period_key, next_no)
VALUES (rule_id, period_key, start_no + 1)
ON CONFLICT (rule_id, period_key)
DO UPDATE SET next_no = numbering_counter.next_no + 1
RETURNING next_no - 1;     -- the number just allocated
```
- Locks exactly **one** counter row for microseconds; different branches/types/models never contend.
- The increment lives in the **caller's transaction** → if the document insert rolls back, the increment rolls back → **no gap**. A cancelled/void document retains its number, so the series still has no holes.
- `current_setting('app.user_id')` stamps the allocator into the audit ledger.

## 6. Gapless vs Sequence
| Mode | Mechanism | Gaps? | Use for |
|---|---|---|---|
| **Gapless** (default, `is_gapless=true`) | locked counter row, increment in doc txn | none | Invoice, GRN, Dispatch, PO — tax/audit-sensitive |
| Gap-tolerant | native `SEQUENCE` | gaps on rollback | optional, ultra-high-volume non-statutory |
Recommendation: gapless for all 11 — project-manufacturing volumes are far below any contention concern, and auditors specifically query missing statutory numbers.

## 7. Multi-Year & Multi-Branch
- **Period key** is a pure function of date + `company.fiscal_year_start_month` (April → `2026-27`). First allocation on/after Apr 1 auto-creates a fresh counter at `start_no`; deterministic, so the midnight boundary has no race. Old period counters retained for audit.
- **Branch** comes from the originating BU, frozen on the document; transfers never renumber.

## 8. Audit Compliance
- Immutable issuance ledger (INSERT/SELECT only; UPDATE/DELETE revoked, mirroring the `audit` schema).
- **`mdm.v_numbering_gaps`** reconciles `generate_series(min..max)` vs allocated sequences per rule/period — surfaces any missing number for statutory review.
- Triple uniqueness (counter lock + ledger unique + document `*_no` unique). Document numbers never edited (existing audit triggers capture attempts); cancelled docs keep numbers.

## 9. Edge Cases
FY rollover (auto), midnight boundary (deterministic), reprints/amendments (suffix `-A1`/`-R2`, not a new allocation), legacy migration (seed `next_no` past legacy max), cross-branch transfer (no renumber), voids (number retained, gapless preserved), multi-company (scoped by `company_id`; GSTIN-level for invoices).

## 10. Verification (PostgreSQL 16)
Built clean with the full schema and functionally tested:
- **Multi-branch**: `ENQ/MUM/2026-27/000001` and `ENQ/PUN/2026-27/000001` (independent counters) ✔
- **No duplicates**: 5,000 allocations → 5,001 total, **5,001 distinct**, max_seq 5,001 ✔
- **Gapless**: a rolled-back transaction consumed no number (before `000001` → after `000002`) ✔
- **Gap view**: 0 gaps ✔
- **Per-model serials**: `BE-XR200-2026-00001/00002/00003` and `BE-HD500-2026-00001/00002` independent ✔
- **Unique guard**: duplicate ledger insert rejected by `uq_alloc_number` ✔

## Usage
```sql
SET app.user_id = '<current user_id>';   -- for audit stamping
SELECT mdm.next_document_no(:company_id, :branch_bu_id, 'PO');             -- PO/MUM/2026-27/000001
SELECT mdm.next_document_no(:company_id, NULL, 'MACHINE_SERIAL', 'XR200'); -- BE-XR200-2026-00001
```
Call inside the same transaction that inserts the document, then write the returned number to the document's `*_no` column (and optionally back-fill `numbering_allocation.doc_id`).
