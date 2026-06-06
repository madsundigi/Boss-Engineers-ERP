# Test Plan & Testing Matrix — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-QA-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Author | QA Lead |
| Builds on | FRD, RBAC, NUMBERING, AUDIT, INTEGRATION_ARCHITECTURE, MODULE_ENQUIRY, MODULE_QUOTATION |
| Status | Baseline |

Test strategy across six levels — **Unit · Integration · Regression · Security · Performance · UAT** — with a complete module × level testing matrix. Built modules (M01 Enquiry, M02 Quotation) already carry **45 passing automated tests** on PostgreSQL 16; M03–M16 are specified at design level.

---

## 1. Scope & Objectives
- **Goal:** ship each module at a defined quality bar — correctness, security (RBAC/SoD), data integrity, and performance per the NFRs.
- **In scope:** all 16 modules + platform services (Numbering, RBAC, Audit, Approval/DOA, PDF/Email) + the integration hops.
- **Implemented & automatable now:** M01, M02, Numbering, RBAC guard, Audit (DB), PDF/Email.
- **Specified (no app code yet):** M03–M16, Finance/Billing, Engineering/BOM.

## 2. Test Levels (definitions, tools, owners)
| Level | What it proves | Tooling | Owner | Entry | Exit |
|---|---|---|---|---|---|
| **Unit** | Business logic & validation in isolation (services, DTOs, PDF/email, pure functions) | Jest + ts-jest (mocked repos) | Dev | code compiles | ≥80% line cov on services; all green |
| **Integration** | Full stack: HTTP → auth → RBAC → validation → service → repo → PostgreSQL; cross-module contracts | Jest + Supertest + throwaway PG | Dev/QA | unit green | all green on a real DB |
| **Regression** | No previously-fixed defect returns; schema still builds; UI unchanged | Full suite in CI + visual snapshot + schema build | QA/CI | PR opened | suite green, no new diffs |
| **Security** | Authn/Authz, SoD, injection, audit immutability, secrets, deps | Supertest authz cases, `npm audit`, ZAP/OWASP, manual | Security/QA | feature complete | no High/Critical open |
| **Performance** | Latency/throughput vs NFR (dashboard <3s, txn <1s) | k6/JMeter, pgbench, EXPLAIN | Perf eng | integration green | targets met under load |
| **UAT** | Business acceptance by real users on real journeys | Scripted scenarios in staging | Business + QA | system test passed | sign-off per module |

## 3. Environments & Data
- **Local/CI:** ephemeral PostgreSQL 16 (`initdb`/`pg_ctl`) built from `db/00_run_all.sql` + `app/migrations/*` + seed users — the exact pattern the current suite uses.
- **Staging:** production-like; anonymised data; integrated SMTP/e-invoice sandboxes.
- **UAT:** staging + business sign-off scripts.
- **Test data:** factories per module; seeded RBAC users per role (sales/finance/stores…); India-context masters (GST, FY).

## 4. Coverage Matrix (module × level)
Legend: ✅ automated & passing · ◑ partial · ⬜ planned (designed).

| Module / Service | Unit | Integration | Regression | Security | Performance | UAT |
|---|---|---|---|---|---|---|
| M01 Enquiry | ✅ | ✅ | ✅ | ◑ | ⬜ | ⬜ |
| M02 Quotation | ✅ | ✅ | ✅ | ◑ | ⬜ | ⬜ |
| M03 Project | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M04 Planning/Gantt | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M05 Procurement | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M06 Inventory/Critical | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M07 Workload | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M08 Production | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M09 Delivery Prediction | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M10 FAT | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M11 Dispatch | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M12 Installation | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M13 Warranty/Service | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M14 Failure Analysis | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M15 Profitability | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M16 CEO Dashboard | ⬜ | ⬜ | ⬜ | ⬜ | ◑ (matview) | ⬜ |
| Numbering | ✅ (DB) | ✅ | ✅ | ◑ | ◑ (contention) | — |
| RBAC | ✅ | ✅ | ✅ | ◑ | ⬜ | ⬜ |
| Audit | ✅ (DB) | ◑ | ✅ | ◑ | ⬜ | — |
| Approval/DOA | ◑ (M02) | ◑ | ⬜ | ⬜ | ⬜ | ⬜ |
| PDF / Email | ✅ | ✅ | ✅ | ⬜ | ⬜ | — |

## 5. Test Scenarios by Level

### 5.1 Unit
| Area | Representative cases | Status |
|---|---|---|
| Enquiry service | create defaults NEW; 404; transition guards; LOST-needs-reason; delete-only-NEW | ✅ 14 |
| Quotation service | price = gross−discount; submit→requiresApproval; approve only PENDING; reject needs reason; send composes PDF+email; won syncs enquiry; revise refuses terminal | ✅ |
| PDF/Email | PDF buffer `%PDF-`; outbox records attachment | ✅ |
| Validation (zod) | required/format/enum/coercion bounds | ✅ (via API) |
| Targets | ≥80% lines on `*.service.ts`; 100% on transition tables | ◑ |

### 5.2 Integration (Supertest + real PG)
| Area | Representative cases | Status |
|---|---|---|
| Enquiry API | 201 w/ auto-number; 403 no perm; 400 bad body; 401 no identity; 404; transition 200/409; CSV export | ✅ 8 |
| Quotation API | convert→DRAFT + enquiry→QUOTED; pricing; submit; **approve 403 sales / 200 finance**; send→PDF+outbox; GET /pdf; **won→enquiry CONVERTED**; revisions; revise-WON 409 | ✅ 8 |
| Cross-module contract | Enquiry↔Quotation sync (built); Quotation.WON→Project (designed contract) | ◑ |
| Migration | each `migrations/*.sql` applies idempotently on full schema | ✅ |

### 5.3 Regression
- **Full automated suite** runs on every PR (currently 45 tests) — gate to merge.
- **Schema build check**: `db/00_run_all.sql` + all migrations build clean on a fresh PG (already verified each turn).
- **Visual regression**: screenshot diff of design-system + key screens.
- **Numbering invariants**: re-run no-duplicate / gapless / per-model tests.
- **Audit invariants**: tamper-detection + append-only re-verified.
- **Defect re-tests**: every fixed issue from the QA issue list gets a permanent test.

### 5.4 Security
| Theme | Cases |
|---|---|
| AuthN | identity headers must be gateway-injected; reject unauthenticated (401); **token/JWT verification when gateway absent** (gap — see issue list) |
| AuthZ (RBAC) | every route enforces `MODULE.ACTION`; deny-by-default; **row-level data scope** (gap); negative tests per role |
| SoD / DOA | creator ≠ approver; value-band DOA (gap — not enforced in code) |
| Injection | parameterized SQL everywhere (verified); no string interpolation of input |
| Audit | append-only (UPDATE/DELETE denied); tamper-evident hash-chain; **EXPORT/APPROVE semantic events emitted** (gap) |
| Secrets/Deps | no secrets in repo; `npm audit`; SMTP creds via env |
| API top-10 | mass-assignment (DTO whitelists), rate limiting, payload size caps (256kb set; line-count cap gap) |

### 5.5 Performance (NFR: dashboard <3s, posting <1s)
| Scenario | Method | Target |
|---|---|---|
| Document numbering hot series | concurrent allocations | no duplicates; p95 < 50ms (row-lock contention measured) |
| List endpoints at scale (100k rows) | k6 ramp; `ILIKE %q%` + OFFSET pagination | p95 < 1s; add keyset pagination + trigram index |
| CEO dashboard | matview read + refresh CONCURRENTLY | < 3s; refresh 5–15 min |
| PDF generation | 50 concurrent | < 1s each; bound memory |
| Audit insert overhead | trigger cost under write load | < 10% posting overhead |

### 5.6 UAT (business journeys)
| Journey | Acceptance |
|---|---|
| Order-to-cash: Enquiry → Quotation → (Project…Dispatch) | numbers correct; approvals route to Finance; PDF received by customer; statuses sync |
| Quotation approval (Finance) | margin/discount gate works; SoD respected; audit shows who/when |
| Executive review | CEO dashboard KPIs match source reports; drilldowns land correctly |
| Statutory | GST/e-invoice/e-way bill on dispatch (when built) |
| Sign-off | per-module business owner approval recorded |

## 6. CI/CD Quality Gates
`lint → typecheck (tsc) → unit → integration (ephemeral PG) → schema build → npm audit → (security scan) → deploy staging → smoke`. Merge blocked unless unit+integration green and no new High/Critical security findings.

## 7. Exit Criteria (per module GA)
- 100% of planned test cases executed; **0 open S1/S2**; ≥80% service line coverage; all NFR targets met; UAT sign-off; the module's edge-case issues (see QA issue list) triaged and S1/S2 closed.

## 8. Traceability & Defects
- Each requirement (FRD/RBAC/NUMBERING/AUDIT) maps to ≥1 test; matrix above is the index.
- **Defect severity:** S1 Critical (data loss/security/blocker) · S2 High · S3 Medium · S4 Low. SLA: S1 fix immediately, S2 before module GA.
- Open defects are tracked in **QA_ISSUE_LIST.md** (edge-case audit) — S1/S2 there are exit-blockers.
