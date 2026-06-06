# Module M01 — Customer Enquiry : Implementation

| Field | Detail |
|---|---|
| Document ID | BE-ERP-IMPL-M01 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Code | `app/` (TypeScript + Express + pg + zod), `app/migrations/001_enquiry.sql` |
| Status | **Verified** — 22/22 tests pass on PostgreSQL 16; UI rendered |

First fully-implemented module. Enterprise-layered, wired to the existing schema, RBAC, document numbering, audit, and design system. Fields: **Customer Name, Contact, Email, Address, Industry, Source, Requirement, Status**.

---

## 1. Architecture (layered, dependency-injected)
```
HTTP ─▶ authenticate ─▶ RBAC guard ─▶ validate(zod) ─▶ controller ─▶ service ─▶ repository ─▶ PostgreSQL
        (req.context)    (ENQUIRY.*)    (DTO)            (HTTP)        (rules)     (SQL)        (triggers: audit + numbering)
```
- **Controller** (`enquiry.controller.ts`) — thin HTTP adapter; no logic.
- **Service** (`enquiry.service.ts`) — business rules; depends only on the repository (unit-testable without a DB).
- **Repository** (`enquiry.repository.ts`) — parameterized SQL, tenant-scoped, optimistic locking; writes run in a transaction that pushes the request identity into PG session GUCs so the **audit triggers** attribute every change.
- **Composition root** — `enquiry.routes.ts` / `app.ts` wire the layers; `server.ts` boots.

## 2. The seven deliverables
| Deliverable | Where | Notes |
|---|---|---|
| **Database** | `app/migrations/001_enquiry.sql` | Extends base `sales.enquiry` with intake fields (contact/email/address/industry/requirement, branch), unifies the Status lifecycle, adds source/email check constraints + indexes, wires audit & status-history triggers. Idempotent. |
| **API** | `enquiry.routes.ts` / `enquiry.controller.ts` | REST: `GET /api/enquiries`, `POST`, `GET/:id`, `PATCH/:id`, `POST/:id/status`, `POST/:id/approve`, `DELETE/:id`, `GET/export`. |
| **Services** | `enquiry.service.ts` | Lifecycle transitions, optimistic-lock conflict mapping, delete guards, qualify/approve, CSV export. |
| **Validation** | `enquiry.dto.ts` (zod) + `common/validate.ts` | Body/query schemas, coercion, field limits, email format, enum guards. |
| **UI** | `app/ui/*.html` + `api-client.js` | List, Create/Edit form, Detail (with audit timeline) on the design system. |
| **Permissions** | `common/rbac.ts` + `common/auth.ts` | `requirePermission('ENQUIRY.*')`; permission set loaded from `sec.role_permission` per user. Deny-by-default. |
| **Tests** | `app/test/*.test.ts` | 14 unit (mocked repo) + 8 integration (supertest + real PG). |

## 3. Business rules enforced
- **Lifecycle:** `NEW → QUALIFIED → QUOTED → CONVERTED`; `→ LOST` / `→ ON_HOLD`; terminal states immutable. Illegal transitions → `409`.
- **LOST requires a reason** (`400` otherwise). **Delete only a NEW draft** (`409` otherwise).
- **Optimistic concurrency** via `row_version` (`409` on mismatch).
- **Number** allocated atomically (`mdm.next_document_no`) → `ENQ/MUM/2026-27/000001` (gapless, branch-scoped).
- **Tenant isolation**: every query scoped by `company_id`; identity/branch come from context, never the client body.

## 4. Security
- RBAC guard on every route (`ENQUIRY.VIEW/CREATE/EDIT/DELETE/APPROVE/EXPORT`).
- Permissions resolved server-side from the RBAC tables; deny-by-default.
- Request identity (user/IP/session) propagated to DB GUCs → captured by the append-only, tamper-evident audit trail.
- Parameterized SQL throughout (no string interpolation of user input); DB check constraints as defence in depth.

## 5. How to run
```bash
cd app && npm install
cp .env.example .env                       # set DATABASE_URL
psql "$DATABASE_URL" -f migrations/001_enquiry.sql   # after the base schema (db/00_run_all.sql)
npm run dev                                # API on :3001
npm test                                   # unit always; integration runs when DATABASE_URL is set
```
Open `app/ui/enquiry-list.html` (served from the repo root) for the UI.

## 6. Verification (PostgreSQL 16)
- **Migration** applies on top of the full 9-part schema; sample enquiry got `ENQ/MUM/2026-27/000001`; **audit CREATE event** captured; **email check** rejects bad input.
- **Tests: 22/22 pass** — 14 unit (transitions, conflicts, guards) + 8 integration:
  - create `201` with auto number; **`403`** without `ENQUIRY.CREATE`; **`400`** on missing name / bad email; **`401`** without identity; list `200`; get `200` / unknown `404`; valid transition `200` & illegal transition `409`; CSV export `200`.
- **UI** rendered in a headless browser: List (status-coloured badges, filters, pagination) and Detail (action bar, definition list, audit timeline).
