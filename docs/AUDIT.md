# Enterprise Audit Architecture — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-AUDIT-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Implementation | `db/09_audit.sql` |
| Status | Verified on PostgreSQL 16 — all 8 event types + tamper-detection proven |

Tracks: **Create, Edit, Delete, Approve, Reject, Login, Logout, Export**.
Stores: **User, IP, Timestamp, Old Value, New Value** (+ forensic context).

---

## 1. Two capture channels → one unified stream
| Channel | Captures | Why |
|---|---|---|
| **DB triggers** (automatic, un-bypassable) | CREATE, EDIT, DELETE | Caught at the database — no code path or direct SQL can skip them. |
| **Application emit** (`audit.log_event`) | APPROVE, REJECT, LOGIN, LOGOUT, EXPORT | Business/security events with context the DB can't see (session, intent, export scope). |

Both write to a single append-only table **`audit.audit_event`** — "everything user X did" is one query.

## 2. Event Taxonomy & Capture
| Event | Source | old/new | Notes |
|---|---|---|---|
| CREATE | trigger | new only | full inserted row |
| EDIT | trigger | old + new | field-level diff derivable |
| DELETE | trigger | old only | full removed row |
| APPROVE | app emit | optional | + DOA level, document ref |
| REJECT | app emit | optional | **reason mandatory** |
| LOGIN | app emit (auth) | — | `result` SUCCESS/FAILURE, IP, agent |
| LOGOUT | app emit | — | session close |
| EXPORT | app emit | — | what/scope/format + **purpose** (DPDP/PII) |

## 3. Stored Fields
**Required:** `app_user_id` (User) · `client_ip` (IP) · `event_time` (Timestamp) · `old_value` JSONB · `new_value` JSONB.
**Enrichment (forensics/compliance):** `event_type`, `username` (snapshot), `user_agent`, `session_id`, `company_id`, `module`, `entity` (schema.table), `entity_pk`, `result` (SUCCESS/FAILURE/DENIED), `reason`, `correlation_id`, `row_hash`.

## 4. Tamper-Evidence
1. **Append-only** — `UPDATE/DELETE/TRUNCATE` revoked from `erp_app`; capture is INSERT-only. (Verified: app role denied.)
2. **Per-row hash** — every event gets `row_hash = SHA-256(canonical content)` on insert via a BEFORE-INSERT trigger (no hot-path lock).
3. **Periodic sealed hash-chain** — `audit.seal_period(from,to)` walks the period's events in order producing a running chain hash, each **seal chained to the previous** (`prev_seal_hash`). Seals are tiny and stored separately (ideally **WORM**).
4. **Verification** — `audit.verify_period(seal_id)` recomputes the chain from current rows and returns `(is_valid, first_bad_event)`. Any altered byte changes that row's recomputed hash → chain mismatch → tampering detected. **Even if an attacker also rewrites `row_hash`, the seal (computed/stored earlier) still fails** — proven in test.

## 5. Field-level Diff
`audit.v_field_changes` expands EDIT events into one row per changed field (`field, old_val, new_val`) by diffing old/new JSONB. `audit.v_user_activity` gives a per-user timeline.

## 6. Partitioning, Retention, Performance
- `audit.audit_event` **RANGE-partitioned monthly** on `event_time` (+ DEFAULT partition; rolling creation via `public.ensure_month_partition` / `pg_partman`).
- Indexes: `(app_user_id,event_time)`, `(entity,entity_pk)`, `(event_type,event_time)`, `(correlation_id)`, **GIN** on `new_value`, **BRIN** on `event_time`.
- Hot path = one lightweight INSERT (hash is local; chaining is off-peak). Retention **8 years** (Companies Act / GST); online ~13 months then archived to WORM.

## 7. Security & Privacy
- Read access gated by RBAC `AUDIT_LOG.VIEW` (CEO/Admin/Finance/QC/HR per the matrix). **No role** gets EDIT/DELETE on audit.
- **PII masking**: sensitive keys can be redacted/tokenised in old/new before storage; EXPORT logs *purpose* (DPDP Act).
- **Audit-the-auditor**: audit-config changes are themselves logged; seals are immutable and chained.

## 8. Data Model & API
- Table `audit.audit_event` (partitioned, append-only, hash-stamped).
- Table `audit.integrity_seal` (chained periodic seals).
- Function `audit.log_event(event_type, module, entity, entity_pk, old, new, result, reason, user_id, username, client_ip)` — app emit; reads session GUCs (`app.user_id`, `app.client_ip`, `app.session_id`, `app.company_id`, `app.correlation_id`).
- Function `audit.fn_audit()` — the CRUD trigger body (re-pointed from the legacy `audit_log`).
- Functions `audit.seal_period()`, `audit.verify_period()`; views `audit.v_field_changes`, `audit.v_user_activity`.
- Consolidates and supersedes the earlier `audit.audit_log` and `audit.login_audit`.

## 9. Verification (PostgreSQL 16)
| Test | Result |
|---|---|
| All 8 event types captured | CREATE, EDIT, DELETE, APPROVE, REJECT, LOGIN×2, LOGOUT, EXPORT ✔ |
| Required fields | `user=1, ip=203.0.113.45, timestamp, entity` ✔ |
| Field-level diff | `vendor_name: "Audit Test Vendor" → "…(Renamed)"` ✔ |
| Seal + verify (clean) | `is_valid = true` ✔ |
| Tamper `new_value` | `is_valid = false, first_bad_event = 2` (pinpointed) ✔ |
| Tamper + recompute `row_hash` (cover-up) | `is_valid = false` — chain seal still catches it ✔ |
| Append-only enforcement | `erp_app` denied UPDATE **and** DELETE ✔ |

## Usage
```sql
-- per request, the app sets session context:
SET app.user_id='42'; SET app.client_ip='10.1.2.3'; SET app.session_id='...'; SET app.company_id='1';

-- CRUD is captured automatically by triggers. Business/security events:
SELECT audit.log_event('APPROVE','PURCHASE_ORDER','scm.purchase_order', 5001,
                       NULL, '{"status":"APPROVED"}'::jsonb, 'SUCCESS', 'Within DOA limit');
SELECT audit.log_event('EXPORT','REPORTS','project_pnl', NULL, NULL, NULL, 'SUCCESS', 'Board pack');

-- integrity (run off-peak / nightly):
SELECT audit.seal_period(date_trunc('day',now()), date_trunc('day',now())+interval '1 day');
SELECT * FROM audit.verify_period(:seal_id);   -- (is_valid, first_bad_event)
```
