# Performance & Scalability Review — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-PERF-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Reviewer | Performance Engineer |
| Targets | 100 / 500 / 1000 concurrent users |
| NFR | Dashboard < 3s · transaction/posting < 1s (per FRD) |
| Method | Code/schema inspection (app M01/M02 + db/01–09 + outbox) + capacity modelling |

ETO manufacturing ERP is **read-heavy** (lists, details, dashboards, reports ≈ 85%) with moderate, control-gated writes (≈ 15%). The data layer is solid; the application has a handful of **specific, fixable bottlenecks** that must be addressed before 500+ users.

---

## 1. Workload Model
| Tier | Active @ peak (~20%) | Avg RPS | Peak RPS | Notes |
|---|---|---|---|---|
| 100 users | ~20 | 3–5 | 10–15 | single node comfortably (after Phase 0 fixes) |
| 500 users | ~100 | 15–25 | 50–75 | needs horizontal app + cache + replica |
| 1000 users | ~200 | 30–40 | 100–150 | + queue workers, autoscale, read/write split |
Plus background load: matview refresh, outbox dispatch (email/PDF), report/export generation, audit sealing.

## 2. Current Bottlenecks (grounded in code)
| # | Bottleneck | Evidence | Impact |
|---|---|---|---|
| B1 | **Per-request permission DB join** | `auth.ts` runs `user_role⋈role_permission⋈permission` on every `/api` call | +1 round-trip/request; scales linearly with RPS |
| B2 | **`ILIKE '%q%'` search without trigram index** on snapshot cols | `enquiry.repository.ts:83`, `quotation.repository.ts:98` (no GIN trgm on `sales.enquiry`/`sales.quotation` — masters have them) | sequential scans on large tables |
| B3 | **`OFFSET` pagination** | both list repos `LIMIT n OFFSET m` | deep pages scan+discard; O(offset) |
| B4 | **Small fixed pool (`max:10`) per instance** | `db/pool.ts:14` | connection starvation under burst; no PgBouncer |
| B5 | **In-memory rate-limit store** | `security.ts` (express-rate-limit default) | inconsistent across instances; not shared |
| B6 | **Polling outbox relay (2s)** | `relay.ts:86` `setInterval(2000)` | +up to 2s dispatch latency; per-instance poll |
| B7 | **Matview refresh not scheduled** | `db/06` refresh is commented | dashboard staleness / manual refresh |
| B8 | **PDF generation on web path-adjacent** | pdfkit in outbox handler (good — already async) | CPU; keep off web instances (worker tier) |
| B9 | **Numbering counter row-lock** | `mdm.next_document_no` (gapless) | serialises a hot doc series (acceptable; monitor) |

## 3. Caching Strategy
| Layer | What | Mechanism | Invalidation |
|---|---|---|---|
| **Connection pooling** | DB connections | **PgBouncer (transaction mode)** in front of PG | n/a (essential ≥500) |
| **Permissions** (fixes B1) | per-user permission set | Redis (shared) / in-proc LRU, **TTL 60s** | on role/permission change (pub-sub bust) |
| **Reference/master data** | currency, numbering rules, `doa_rule`, customer/vendor/item lookups | Redis + in-proc LRU | write-through on master edits |
| **Dashboard / reports** | CEO KPIs, report results | matviews (already) + Redis KPI cache, TTL = refresh interval; show "data as of" | on matview refresh |
| **HTTP** | detail GETs, static UI | gzip/brotli compression, **ETag/conditional GET**, `Cache-Control` + **CDN** for `design-system/`+UI | content hash / TTL |
| **Rate-limit store** (fixes B5) | counters | **Redis store** when >1 instance | TTL window |
> Caching reads is layered carefully **on top of RLS/data-scope** — cache reference data and per-user-scoped results keyed by `(userId, companyId, query)`, never cross-tenant.

## 4. Indexes
**Existing (good):** FK indexes; `(company_id,status)` on enquiry/quotation (migrations 001/002); `pg_trgm` enabled with GIN trigram on `mdm.customer/vendor/item` names; partial `ix_project_due` on active projects; outbox poll partial index; audit BRIN on `event_time` + monthly partitions.

**Add (ready-to-apply — fixes B2/B3; run `CONCURRENTLY`, outside a txn):**
```sql
-- Default list (filter by company, sort by created_at) + keyset cursor support
CREATE INDEX CONCURRENTLY ix_enquiry_company_created
  ON sales.enquiry (company_id, created_at DESC, enquiry_id DESC) WHERE NOT is_deleted;
CREATE INDEX CONCURRENTLY ix_quotation_company_created
  ON sales.quotation (company_id, created_at DESC, quotation_id DESC) WHERE NOT is_deleted;

-- Free-text search (ILIKE '%q%') -> trigram GIN on the snapshot columns
CREATE INDEX CONCURRENTLY ix_enquiry_search_trgm
  ON sales.enquiry USING gin (customer_name gin_trgm_ops, contact_person gin_trgm_ops, email gin_trgm_ops);
CREATE INDEX CONCURRENTLY ix_quotation_search_trgm
  ON sales.quotation USING gin (customer_name gin_trgm_ops, quotation_no gin_trgm_ops);
```
**Replace OFFSET with keyset (seek) pagination (fixes B3):**
```sql
WHERE company_id = $1 AND NOT is_deleted
  AND (created_at, enquiry_id) < ($cursorCreatedAt, $cursorId)
ORDER BY created_at DESC, enquiry_id DESC LIMIT $n;   -- served by ix_enquiry_company_created
```
**Operational:** enable `pg_stat_statements`; periodically `REINDEX`/`ANALYZE`; tune autovacuum for hot tables (`sales.enquiry`, `sales.quotation`, `audit.audit_event`, `mdm.outbox_event`); drop unused indexes found via `pg_stat_user_indexes`.

## 5. Queue System
Keep the **transactional outbox** (atomic write — never lose it); evolve the **dispatch**:
| Tier | Dispatch | Workers |
|---|---|---|
| 100 | In-process relay poll (current) — lower interval or add `LISTEN/NOTIFY` wake-up | web process |
| 500 | **NOTIFY-driven** relay + safety poll; **dedicated worker tier** (separate process) for email/PDF/reports | 1–2 workers |
| 1000 | **Outbox → broker bridge**: relay reads outbox, publishes to **Redis Streams / BullMQ**; workers consume & autoscale | 2–4+ workers (autoscale) |

Design: idempotent consumers (key on `event_id`); concurrency limits + backpressure; **DLQ** (outbox `DEAD` already + broker DLQ + alert); separate the **web** and **worker** tiers so PDF/email/report CPU never steals request latency; route `quotation.won → Project` (M03) and dispatch/e-invoice/e-way-bill calls through the same queue.

## 6. Background Jobs
| Job | Cadence | Runner |
|---|---|---|
| Outbox relay (email, PDF, integrations, `quotation.won→project`) | continuous | worker tier |
| Matview refresh (`mv_ceo_portfolio`, `mv_project_health_heatmap`, `mv_at_risk_projects`) `CONCURRENTLY` (fixes B7) | 5–15 min | **pg_cron** / scheduler |
| Audit hash-chain **sealing** | hourly/daily | pg_cron / worker |
| Partition maintenance (audit, outbox) + archival to cold/WORM | daily | **pg_partman** / pg_cron |
| Report generation + **scheduled exports** | on schedule / on demand | queue + worker |
| Delivery-prediction recompute (M09), SLA timers (M13), AMC/PM/warranty reminders | per domain | scheduler + queue |
| `ANALYZE`/index maintenance, dead-tuple cleanup | nightly | pg_cron |
> Numbering FY-rollover needs **no job** (period key is a pure function of the date). The outbox relay holds the row lock during a handler, so there are **no stuck `PROCESSING` rows** to reclaim.

## 7. Capacity Sizing (indicative)
| Tier | App instances | App size | PostgreSQL | PgBouncer | Read replicas | Redis | Workers | CDN |
|---|---|---|---|---|---|---|---|---|
| 100 | 1 | 2 vCPU / 2 GB | 4 vCPU / 8 GB | optional | 0 | optional | in-proc | optional |
| 500 | 2–3 (LB) | 2 vCPU / 4 GB | 8 vCPU / 32 GB | yes (pool ~30) | 1 (reports/dash) | yes | 1–2 | yes |
| 1000 | 4–6 (autoscale) | 2–4 vCPU / 4–8 GB | 16 vCPU / 64 GB | yes, txn mode (pool ~50) | 2 (read/write split) | HA | 2–4 (autoscale) | yes |

PG tuning at scale: `shared_buffers ≈ 25% RAM`, `effective_cache_size ≈ 70%`, sane `work_mem` per op, `max_wal_size`, autovacuum scale factors lowered for hot tables; **max_connections stays modest** — PgBouncer multiplexes.

## 8. Optimization Plan (phased)
**Phase 0 — foundational (do first; mostly quick wins, benefits every tier)**
1. Apply the **index pack** (§4) + switch lists to **keyset pagination** → kills B2/B3.
2. **Permission cache** (Redis/LRU, 60s TTL) → kills B1.
3. **Response compression** (gzip/brotli) + HTTP caching headers/ETag.
4. **PgBouncer** in front of PG; size app pool to match.
5. Enable `pg_stat_statements` + slow-query log; baseline with k6.

**Phase 1 — ≤100 users:** single app + DB + PgBouncer + in-proc cache + in-proc relay. Load-test to NFRs; confirm headroom. *(Phase 0 alone likely carries 100 users comfortably.)*

**Phase 2 — ≤500 users:** horizontal app (2–3) behind a load balancer; **Redis** shared cache (permissions/reference/dashboard) + **Redis rate-limit store** (fixes B5); **1 read replica** routing report/dashboard `SELECT`s; **dedicated worker tier**; **NOTIFY-driven** outbox (fixes B6).

**Phase 3 — ≤1000 users:** app **autoscale** (4–6); **broker-backed queue** (BullMQ/Redis Streams) with worker autoscale; **2 read replicas** + read/write split; **partitioning + archival**; **CDN** for static UI; DB parameter tuning; consider **CQRS read models** for the heaviest dashboards.

### SLOs (validate by load test at each tier ×1.5 peak, 1h soak)
| Operation | p95 target |
|---|---|
| List endpoints | < 500 ms |
| Detail GET | < 300 ms |
| Write / posting | < 1 s |
| CEO dashboard | < 3 s |
| Email / PDF | async (queued; delivered < 60 s) |
| Error rate | < 0.1% · cache hit (perm/reference) > 85% |

**Load testing:** k6, 80/20 read/write browse model, ramp to each tier, soak; track p50/p95/p99, RPS, error %, DB connections, cache-hit ratio, queue lag, CPU/IO.
**Observability:** OpenTelemetry/APM; `pg_stat_statements` top-N; RED (rate/errors/duration) + USE (util/saturation/errors); queue depth + DLQ alerts; replication lag.

## 9. Quick Wins (apply now, low risk, high impact)
- The **index pack** (§4) — removes seq scans on search/list.
- **Keyset pagination** in both list repositories.
- **Permission cache** in `auth.ts` (Redis or in-proc LRU, TTL 60s, bust on role change).
- **Compression** middleware + ETags.
- **PgBouncer**; **Redis store** for the rate limiter once >1 instance.
- **Schedule the matview refresh** (pg_cron) — already designed, just not wired.
