# Go-Live Review Board — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-GOLIVE-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Board | CTO · QA Director · Security Lead · Database Architect · Product Owner |
| Scope | Entire codebase (app M01/M02 + db/01–09 + outbox + docs) |
| Mandate | Identify issues only (no feature work); produce a GO-LIVE checklist; **do not approve launch unless every critical (S1) issue is resolved** |

## ⛔ DECISION: **LAUNCH NOT APPROVED**
**14 S1 (critical) and 18 S2 (high) issues remain open.** The system is an early, well-engineered **2-of-16-module slice** with strong data/audit foundations, but it is **not functionally complete and not legally operable (no GST/e-invoice)**. No role signs off.

> **Post-review remediation (2026-06-06 · 73 tests green):** ✅ **BUG-01** — the app now runs as the non-superuser **`erp_app`** role (`SET LOCAL ROLE` on reads + writes) so **RLS is actually enforced** — proven by an unfiltered-query isolation test (0 rows for the wrong company, >0 for the right); migration 005 adds the child-table DELETE grants. ✅ **BUG-02** — authentication is **fail-closed** (a verified JWT is required when configured; header identity is rejected in production). **PRM-01** closes with BUG-01. **Launch remains NOT APPROVED** — the remaining S1 (functional scope, statutory, finance, engineering, migration tooling, backup/DR) still stand.

Severity: 🔴 S1 critical (blocker) · 🟠 S2 high · 🟡 S3 medium · ⚪ S4 low. Status: **OPEN** · **PARTIAL** · ✅ FIXED (this engagement).

---

## 1. Bugs
| ID | Sev | Status | Finding · Evidence | Impact |
|---|---|---|---|---|
| BUG-01 | 🔴 | ✅ FIXED | **RLS was bypassed at runtime** — app connected as superuser. **Fixed:** every read/write now `SET LOCAL ROLE erp_app` + tenant GUC; RLS enforced (isolation test; mig 005 grants). | Tenant isolation now enforced at the DB. |
| BUG-02 | 🔴 | ✅ FIXED | **Auth failed open.** **Fixed:** a verified JWT is required when `AUTH_JWT_SECRET` is set (no header fallback), and header identity is rejected when `NODE_ENV=production`. | No silent auth bypass. |
| BUG-03 | 🟠 | OPEN | **Outbox silently drops unknown events** — `relay.ts` marks events with no registered handler as PROCESSED. | When `quotation.won`/etc. are emitted before a handler exists, the event is **lost** (no fan-out, no error). |
| BUG-04 | 🟠 | OPEN | **Dead-lettered outbox events unmonitored** — a permanently failing email → quote is SENT but never delivered; no alert. | Silent non-delivery of customer documents. |
| BUG-05 | 🟠 | OPEN | **Cross-module sync non-atomic** — convert/won/lost update the enquiry in a separate best-effort tx; a `null` (version mismatch) is ignored. | Quote won but enquiry not CONVERTED → inconsistent lifecycle. |
| BUG-06 | 🟡 | OPEN | **Lost-reason not persisted** — enquiry LOST requires a reason (service) but stores `null`. | Lost-reason intelligence discarded. |
| BUG-07 | 🟡 | OPEN | `margin_pct` is NULL when `total_price=0` (convert creates a ₹0 line). | Reports/dashboards must handle null margin. |

## 2. Missing Requirements (Product Owner)
| ID | Sev | Finding | Impact |
|---|---|---|---|
| REQ-01 | 🔴 | **Only 2 of 16 modules built** (Enquiry, Quotation). M03–M16 are design-only. | Not a usable ERP for the business. |
| REQ-02 | 🔴 | **No statutory compliance** — GST, e-invoice (IRN), e-way bill not implemented. | **Legally cannot dispatch/invoice** in India. |
| REQ-03 | 🔴 | **No Finance/Accounting** (GL/AR/AP), **Billing/Invoicing/Revenue Recognition**. | No money movement; profitability cannot be real. |
| REQ-04 | 🔴 | **No Engineering/Design/BOM/PLM**. | Load-bearing for Procurement/Production — they can't function. |
| REQ-05 | 🟠 | **No auth UI/flow** (login, password reset, MFA), **no user-management UI**. | RBAC tables exist but no operable access surface. |
| REQ-06 | 🟠 | No Notifications service; **no file/attachment upload/storage** (tables exist, no impl). | Approvals/SLA alerts and document capture unavailable. |
| REQ-07 | 🟠 | Change/Variation Mgmt, QMS, DMS, HRMS, Subcontracting, full CRM not built. | Operational and quality gaps. |

## 3. Broken Logic
| ID | Sev | Status | Finding | Impact |
|---|---|---|---|---|
| LOG-01 | 🟠 | OPEN | **DOA value-band not enforced** — `mdm.doa_rule` seeded but `approve()` ignores it; any approver clears any value. | Financial control bypass. |
| LOG-02 | 🟠 | OPEN | **No idempotency on POST create** — retries duplicate enquiries/quotes and consume gapless document numbers. | Duplicate documents; "missing" numbers. |
| LOG-03 | 🟡 | OPEN | **Export ignores data scope & isn't audited** — returns all company rows; no EXPORT audit event. | Over-exposure; compliance gap. |
| LOG-04 | 🟢 | ✅ FIXED | SoD self-approval blocked (code + dual-role test). | — |
| LOG-05 | 🟢 | ✅ FIXED | Double-convert race (unique index); send optimistic lock. | — |

## 4. Performance Risks  *(detail: PERFORMANCE_REVIEW.md — none applied yet)*
| ID | Sev | Finding |
|---|---|---|
| PERF-01 | 🟠 | Per-request permission DB join (no cache). |
| PERF-02 | 🟠 | `ILIKE '%q%'` without trigram on enquiry/quotation snapshot cols + `OFFSET` pagination → sequential scans. |
| PERF-03 | 🟠 | Pool `max:10`, no PgBouncer; **in-memory rate-limit store** (inconsistent across instances). |
| PERF-04 | 🟡 | Matview refresh unscheduled; 2s relay poll latency; no load test vs NFRs (dashboard <3s, posting <1s). |

## 5. Security Risks  *(detail: SECURITY_AUDIT.md)*
| ID | Sev | Status | Finding |
|---|---|---|---|
| SEC-01 | 🔴 | ✅ FIXED | RLS now enforced (BUG-01) + auth fail-closed (BUG-02) — both critical controls resolved & tested. |
| SEC-02 | 🟠 | OPEN | No MFA; no password policy enforced (no login flow); no token lifecycle (refresh/revocation). |
| SEC-03 | 🟠 | OPEN | DOA value-band unenforced (LOG-01). |
| SEC-04 | 🟡 | OPEN | Secrets only in env (no secret manager); dead-letter outbox unmonitored. |
| SEC-05 | 🟢 | ✅ FIXED | XSS (escaping+textContent), nodemailer CVE (upgrade), helmet+CORS+rate-limiting added. SQLi well-mitigated; CSRF n/a (token auth). |

## 6. Permission Gaps
| ID | Sev | Status | Finding |
|---|---|---|---|
| PRM-01 | 🔴 | ✅ FIXED | Tenant isolation now enforced (RLS active via `erp_app` — BUG-01; isolation test). |
| PRM-02 | 🟠 | OPEN | Data scope is **company-only**; territory/owner/branch scope (Sales→own, PM→own per RBAC doc) **not modeled**. |
| PRM-03 | 🟠 | OPEN | DOA value-band unenforced (LOG-01). |
| PRM-04 | 🟡 | OPEN | Export over-exposure (LOG-03). |
| PRM-05 | 🟢 | ✅ FIXED | RBAC guard deny-by-default; SoD self-approval. |

## 7. Reporting Errors
| ID | Sev | Status | Finding | Impact |
|---|---|---|---|---|
| RPT-01 | 🟠 | OPEN | **`rpt.fact_*` have no ETL/loader** — fact tables stay empty. | All 10 catalogue reports return **empty**. |
| RPT-02 | 🟠 | OPEN | FAT/Installation reports reference **`fact_quality`/`fact_installation` which do not exist** in the schema. | Those reports can't be built as specified. |
| RPT-03 | 🟡 | OPEN | CEO matviews read OLTP that is empty (M03–M16 unbuilt) → **zeros**; refresh not scheduled. | Dashboard shows no real numbers; staleness. |
| RPT-04 | 🟡 | OPEN | `margin_pct` NULL handling (BUG-07) in margin reports. | Display/format errors. |

## 8. Data Integrity Issues
| ID | Sev | Status | Finding | Impact |
|---|---|---|---|---|
| DAT-01 | 🔴 | OPEN | **No migration runner / version table** — migrations applied manually via `psql -f`; no record of what's applied, no ordering/rollback guard. | Schema drift; unrepeatable environments; risky deploys. |
| DAT-02 | 🔴 | OPEN | **No backup / PITR / DR / tested restore.** | Catastrophic, unrecoverable data loss. |
| DAT-03 | 🟠 | OPEN | Cross-module sync non-atomic (BUG-05). | Inconsistent enquiry/quote states. |
| DAT-04 | 🟠 | OPEN | No idempotency (LOG-02). | Duplicate documents. |
| DAT-05 | 🟠 | OPEN | **Semantic audit events not emitted** by the app — APPROVE/REJECT/EXPORT/LOGIN not in `audit.audit_event` as such (only generic CRUD via triggers). | Incomplete statutory audit trail. |
| DAT-06 | 🟢 | ✅ FIXED / STRONG | bu/company composite FK; decimal money; **409 FKs, CHECK constraints, append-only tamper-evident audit, gapless numbering, optimistic locking** all verified. | Solid integrity floor. |

---

## GO-LIVE CHECKLIST (pass / fail)
| # | Gate | Status | Blocking note |
|---|---|---|---|
| 1 | All in-scope modules built (16/16) | ❌ FAIL | 2/16 (REQ-01) |
| 2 | Statutory: GST + e-invoice + e-way bill certified | ❌ FAIL | not implemented (REQ-02) |
| 3 | Finance / Billing / Revenue recognition | ❌ FAIL | not built (REQ-03) |
| 4 | Engineering / BOM / PLM | ❌ FAIL | not built (REQ-04) |
| 5 | Authentication: JWT enforced (no fail-open), MFA, password policy | ◑ PARTIAL | fail-open fixed ✅ (BUG-02); MFA + password/login flow still missing (SEC-02) |
| 6 | Tenant isolation enforced (RLS active via `erp_app`) | ✅ PASS | BUG-01 fixed; proven by isolation test |
| 7 | Authorization: DOA + SoD + data scope | ❌ FAIL | SoD ✅; DOA & scope open (LOG-01, PRM-02) |
| 8 | App security (XSS, deps, headers, rate-limit) | ◑ PARTIAL | controls added (SEC-05); rate-limit store per-instance |
| 9 | Performance load-tested to NFR (dashboard <3s, posting <1s) | ❌ FAIL | not tested; quick wins unapplied (PERF) |
| 10 | Caching + PgBouncer + scaling for target users | ❌ FAIL | not implemented |
| 11 | Data integrity: migration tooling + idempotency + atomic sync | ❌ FAIL | DAT-01/03/04 |
| 12 | Backup + PITR + **tested restore** + DR plan | ❌ FAIL | DAT-02 |
| 13 | Monitoring + alerting + SLOs + on-call | ❌ FAIL | none (structured logging only) |
| 14 | Audit: append-only tamper-evident + **semantic events** | ◑ PARTIAL | DB layer ✅; app semantic events missing (DAT-05) |
| 15 | Reporting: facts populated (ETL) + reports verified | ❌ FAIL | RPT-01/02 |
| 16 | Automated tests + CI green | ◑ PARTIAL | 69 tests for 2 modules; CI defined not run; M03–16 untested |
| 17 | UAT sign-off per module | ❌ FAIL | not performed |
| 18 | Documentation | ✅ PASS | extensive and current |

**Score: 2 PASS · 4 PARTIAL · 12 FAIL** (was 1/3/14 — gate 6 now PASS, gate 5 PARTIAL after the BUG-01/BUG-02 fixes).

## Board Sign-offs
| Role | Verdict | Top reason |
|---|---|---|
| **CTO** | ❌ NOT APPROVED | 2/16 modules; ops layer (backup/DR/monitoring/migrations) absent |
| **QA Director** | ❌ NOT APPROVED | only 2 modules tested; no UAT; open S1/S2; no load test |
| **Security Lead** | ❌ NOT APPROVED | RLS inert, auth fail-open, no MFA/password flow, DOA unenforced |
| **DB Architect** | ❌ NOT APPROVED | no migration tooling, no backup/DR, non-atomic sync, reporting ETL missing |
| **Product Owner** | ❌ NOT APPROVED | statutory + finance + engineering gaps; not feature-complete |

## Conditions to Re-review
**Resolve ALL S1 before any production launch:** BUG-01, BUG-02, REQ-01–04, DAT-01, DAT-02, SEC-01, PRM-01 — i.e. complete the functional + statutory + finance + engineering scope (or formally re-scope an MVP), make RLS effective (`erp_app`), make auth fail-closed in production, add migration tooling, and stand up backups/DR. Then clear S2, run a load test to the NFRs, complete a third-party pen test, and obtain per-module UAT sign-off.

**Optional limited internal pilot** (NOT a public launch) of the Sales→Quotation slice *may* be reconsidered only after BUG-01, BUG-02, DAT-01, DAT-02 are fixed — but full launch remains **NOT APPROVED** until every S1 above is closed.
