# Module M02 — Quotation : Implementation

| Field | Detail |
|---|---|
| Document ID | BE-ERP-IMPL-M02 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Code | `app/src/modules/quotation/`, `app/src/services/{pdf,email}.service.ts`, `app/migrations/002_quotation.sql` |
| Status | **Verified** — 45/45 tests pass on PostgreSQL 16; UI rendered |

Second module. Same enterprise-layered stack as M01 (controller → service → repository, DI, RBAC guard, request-context → DB GUCs for audit). Adds the four requested capabilities and bidirectional **Enquiry sync**.

---

## 1. Requirements delivered
| Requirement | How |
|---|---|
| **Version Control** | Every quote keeps `current_revision`; `POST /:id/revise` snapshots the full state (header + lines) into `sales.quotation_revision`, bumps the revision, and resets to DRAFT. `GET /:id/revisions` lists history. Editing an APPROVED/SENT quote is blocked until revised. |
| **Approval Flow** | DRAFT → `submit` → PENDING_APPROVAL → `approve`/`reject` (guarded by **`QUOTATION.APPROVE`** = Finance/CEO). DOA thresholds (`MIN_MARGIN_PCT=15`, `MAX_DISCOUNT_PCT=10`) compute a `requiresApproval` flag. Decisions stamp `decided_by/at` + reason. |
| **PDF Generation** | `PdfService` (pdfkit, pure-JS — no headless/system deps) renders the quotation to a real PDF buffer. `GET /:id/pdf` streams `application/pdf`. |
| **Email Sending** | `EmailService` over a transport **port**: `OutboxTransport` (dev/test, in-memory) and `SmtpTransport` (nodemailer, prod via `SMTP_URL`). `POST /:id/send` generates the PDF, emails it as an attachment, and marks the quote SENT. |
| **Sync with Enquiry** | `POST /quotations/from-enquiry/:enquiryId` creates a DRAFT quote carrying the lead's details, links `enquiry_id`, and moves the enquiry **QUALIFIED → QUOTED**. Marking the quote **WON** moves the enquiry **QUOTED → CONVERTED** (LOST → LOST). Cross-module via injected `EnquiryRepository`. |

## 2. Lifecycle
`DRAFT → PENDING_APPROVAL → APPROVED → SENT → (NEGOTIATION) → WON | LOST`, with `REJECTED → (revise) → DRAFT`. Illegal transitions → `409`. Optimistic concurrency via `row_version` on every mutation.

## 3. Pricing
Line amount = `qty × unitPrice`; gross = sum of non-optional lines; `total_price = gross × (1 − discount%)`. `margin_pct` is a **generated column** in the DB from `total_cost`/`total_price`. Cost is internal-only on the PDF.

## 4. API (`/api/quotations`)
`GET /` · `POST /` · `POST /from-enquiry/:enquiryId` · `GET /:id` · `PATCH /:id` · `POST /:id/submit` · `POST /:id/approve` · `POST /:id/reject` · `POST /:id/revise` · `POST /:id/send` · `POST /:id/won` · `POST /:id/lost` · `GET /:id/revisions` · `GET /:id/pdf`. Each route carries the correct `QUOTATION.*` permission; approve/reject require `QUOTATION.APPROVE`.

## 5. Database (`migrations/002_quotation.sql`)
Extends base `sales.quotation`: lead snapshot (`customer_name/contact/email`, nullable `customer_id`), `bu_id` (numbering), `subject`, `discount_pct`, `currency_code`, approval fields (`submitted_*`, `decided_*`, `decision_reason`), send fields (`sent_at/to`, `pdf_ref`), `REJECTED` status, email/discount check constraints. Revisions/lines/cost-sheet tables and audit+status-history triggers already exist in the base schema.

## 6. UI (`app/ui/`)
`quotation-list.html` (status + margin columns) and `quotation-detail.html` — the detail screen showcases all four capabilities: action bar (PDF / Re-send / Won / Lost), line items + totals + margin, an **Approval Trail** timeline, and a **Revisions (Version Control)** panel. Built on the design system; `quotation-api-client.js` wires the REST API.

## 7. How to run
```bash
cd app && npm install
psql "$DATABASE_URL" -f migrations/002_quotation.sql   # after 001_enquiry.sql
npm test                                               # unit always; integration when DATABASE_URL set
# email: set SMTP_URL + MAIL_FROM for real SMTP; otherwise messages go to the in-memory outbox
```

## 8. Verification (PostgreSQL 16) — 45/45 tests
- **DB**: migration applies on the full schema; `QTN/MUM/2026-27/000001`, **margin auto-computed 20%**, revision snapshot stored, audit CREATE captured, email check enforced.
- **Unit**: PDF buffer starts `%PDF-`; outbox records the attachment; pricing math; approval guards; reject-needs-reason; send composes PDF+email; won syncs enquiry.
- **Integration (full lifecycle)**: convert from QUALIFIED enquiry → DRAFT (enquiry → QUOTED); price ₹95,00,000 / margin 15.8%; submit → PENDING_APPROVAL; **approve denied for Sales (403), allowed for Finance (200)**; send → SENT + outbox PDF attachment (`%PDF-`); `GET /pdf` → `application/pdf`; **WON → enquiry CONVERTED**; revisions listed; revise a WON quote → 409.
- **UI** rendered headless (list + detail).
