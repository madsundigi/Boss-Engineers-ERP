# Reporting Architecture & Catalogue — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-RPT-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Builds on | DATABASE_DESIGN (rpt star schema), RBAC, DESIGN_SYSTEM, FRD |
| Status | Baseline |

A reporting layer separate from the transactional system, the framework every report shares, and a catalogue of 10 reports — each with **Filters · Metrics · Charts · Export**.

---

## 1. Architecture
```
[OLTP modules: sales, proj, scm, mfg, qms, log, svc, fin]
        │  CDC / scheduled projection (ELT)
        ▼
[rpt.*  star schema]  dims: dim_date, dim_project, dim_customer, dim_vendor, dim_item, dim_employee
                      facts: fact_sales_funnel, fact_project_financials, fact_procurement,
                             fact_production, fact_inventory, fact_service
        │  pre-aggregate hot paths
        ▼
[Materialized views]  mv_ceo_portfolio, mv_project_health_heatmap, mv_at_risk_projects  (refresh 5–15 min)
        │
        ▼
[Semantic layer / report API] ──RBAC + data scope──▶ [Report UI · Export · Schedules · Drill-through]
```
**Principles**
- **Separation from OLTP** — reports read the `rpt` star schema / matviews, never live transaction tables, protecting posting performance (per AUDIT/DESIGN guidance).
- **Single source of truth** — every metric has one governed definition (Appendix A); the dashboard and reports share them.
- **Security** — gated by RBAC `REPORTS.VIEW` / `REPORTS.EXPORT`; **row-level data scope** applies (Sales→own territory, PM→own projects, Finance→all) via `company_id`/`bu_id`.
- **Freshness** — facts refreshed by ELT (nightly + intraday deltas); matviews `REFRESH … CONCURRENTLY` every 5–15 min; each report shows "data as of".
- **Drill-through** — every chart/row links to the underlying List → Detail screen (per SCREEN_INVENTORY).

## 2. Common Report Framework
- **Global filters** (all reports): Company, Branch (BU), Fiscal Year, Date range, Currency.
- **Filter behaviour**: multi-select, saved as named views, encoded in URL (shareable), applied server-side.
- **Export**: CSV (raw), XLSX (formatted + pivots), PDF (board pack), and **scheduled delivery** (email on cron) — all export events captured by the audit trail (`EXPORT` with purpose).
- **Interactions**: sort, column chooser, drill-through, conditional formatting (RAG), compare-to-prior-period.

## 3. Report Catalogue

### R1 — Sales Report  · source `fact_sales_funnel` + dim_customer/date
- **Filters:** branch, FY/date range, source, sales owner, customer, status, lost-reason.
- **Metrics:** enquiries received, qualification rate, **conversion rate** (enquiry→quote→won), **win rate**, avg response time, pipeline value, order-intake value, lost value.
- **Charts:** funnel (enquiry→quote→won), source-wise conversion (bar), monthly intake (line), lost-reason Pareto.
- **Export:** CSV · XLSX · scheduled.

### R2 — Quotation Report  · source `fact_sales_funnel` + sales.quotation
- **Filters:** branch, FY/date, status, customer, sales owner, margin band, value band.
- **Metrics:** quotes raised, total quoted value, **avg quoted margin %**, win rate, **avg turnaround** (enquiry→quote), avg revisions/quote, discount given %, approval cycle time, pending approvals.
- **Charts:** status distribution (donut), quoted-vs-won value (bar), margin histogram, turnaround trend (line).
- **Export:** CSV · XLSX · PDF.

### R3 — Project Report  · source `fact_project_financials` + `mv_project_health_heatmap`
- **Filters:** branch, FY, PM, customer, status, health RAG.
- **Metrics:** active projects, **order book**, contract value vs budget, % complete, **SPI**, **CPI**, milestone slippage, **OTD %**, projects at risk.
- **Charts:** portfolio RAG heatmap, **EVM S-curve** (PV/EV/AC), SPI×CPI scatter, milestone slippage (bar).
- **Export:** CSV · XLSX · PDF.

### R4 — Procurement Report  · source `fact_procurement` + dim_vendor
- **Filters:** branch, FY/date, vendor, project, buyer, item category, status.
- **Metrics:** PR/PO counts, PO value, **committed cost**, **on-time vendor delivery %**, PO cycle time, savings vs estimate, % project-pegged, pending approvals, critical-item lead-time adherence.
- **Charts:** spend by vendor (bar), on-time delivery trend (line), spend by category (pie), PO aging.
- **Export:** CSV · XLSX.

### R5 — Inventory Report  · source `fact_inventory` + dim_item
- **Filters:** branch, warehouse/location, item category, ABC class, project (reserved), stock status.
- **Metrics:** stock value, **inventory turns**, days of inventory, stockout incidents, dead/slow-stock value, **critical-item alerts**, reserved vs free stock.
- **Charts:** stock value by category (bar), ABC distribution, critical-item alert list, stock aging.
- **Export:** CSV · XLSX.

### R6 — Production Report  · source `fact_production`
- **Filters:** branch, work center, project, WO status, period.
- **Metrics:** WO count, **schedule adherence %**, **scrap/rework %**, WIP value, actual vs std cost, throughput, on-time WO completion.
- **Charts:** schedule adherence trend (line), scrap/rework Pareto, WIP aging, workcenter load (bar).
- **Export:** CSV · XLSX.

### R7 — FAT Report  · source qms.fat_execution → (recommend `fact_quality`)
- **Filters:** branch, project, product, period, result.
- **Metrics:** FATs conducted, **first-pass yield %**, avg punch items/FAT, FAT cycle time, re-test rate, defect categories.
- **Charts:** first-pass yield trend (line), defect Pareto, punch-item distribution.
- **Export:** CSV · XLSX · PDF (FAT certificates).

### R8 — Installation Report  · source log/svc installation → (recommend `fact_installation`)
- **Filters:** branch, project, region/site, period, status.
- **Metrics:** installations completed, **install cycle time**, **SAT first-pass %**, site punch closure time, install cost vs estimate, on-time commissioning.
- **Charts:** cycle-time trend (line), SAT first-pass (bar), site cost variance.
- **Export:** CSV · XLSX.

### R9 — Service Report  · source `fact_service`
- **Filters:** branch, customer, product/serial, ticket type (warranty/AMC/paid), period, SLA status.
- **Metrics:** tickets logged/closed, **SLA adherence %**, **MTTR**, **warranty cost %**, AMC renewal rate, repeat failures, spares consumed.
- **Charts:** SLA adherence trend, MTTR trend, warranty cost by product (bar), top failure modes (Pareto).
- **Export:** CSV · XLSX.

### R10 — Profitability Report  · source `fact_project_financials` + fin.margin_snapshot + `mv_project_health_heatmap`
- **Filters:** branch, FY, project, customer, PM, status.
- **Metrics:** revenue, cost (**quoted/budget/committed/actual**), **gross margin %**, **margin variance** (quoted vs actual), **EAC**, **CPI**, contribution, **margin erosion**, cash position.
- **Charts:** quoted-vs-actual margin waterfall, margin by project (bar), EAC trend, portfolio margin distribution.
- **Export:** CSV · XLSX · PDF (board pack).

---

## Appendix A — Metric Definitions (governed)
| Metric | Formula |
|---|---|
| Conversion rate | won_quotes ÷ enquiries_received |
| Win rate | won_quotes ÷ quotes_decided (won+lost) |
| Quoted margin % | (total_price − total_cost) ÷ total_price × 100 *(DB generated column)* |
| Quote turnaround | quote_date − enquiry_date (days) |
| Order book | Σ contract_value (status ACTIVE) − recognized_revenue |
| SPI | EV ÷ PV · **CPI** = EV ÷ AC |
| % complete | EV ÷ BAC |
| OTD % | delivered_on_or_before_committed ÷ total_delivered × 100 |
| EAC | AC + (BAC − EV) ÷ CPI |
| Committed cost | Σ open PO value |
| On-time vendor delivery % | on_time_GRNs ÷ total_GRNs × 100 |
| Inventory turns | COGS ÷ avg_inventory_value |
| Schedule adherence % | on_time_operations ÷ total_operations × 100 |
| Scrap/rework % | (scrap_qty + rework_qty) ÷ produced_qty × 100 |
| First-pass FAT yield % | FAT_passed_first_time ÷ total_FAT × 100 |
| SAT first-pass % | SAT_passed_first_time ÷ total_SAT × 100 |
| SLA adherence % | tickets_resolved_within_SLA ÷ closed_tickets × 100 |
| MTTR | Σ (resolved_at − raised_at) ÷ closed_tickets |
| Warranty cost % | warranty_cost ÷ revenue × 100 |
| Gross margin % | (revenue − actual_cost) ÷ revenue × 100 |
| Margin variance | quoted_margin% − actual_margin% |
| Margin erosion | quoted_margin% − forecast_margin% |
| LD exposure | Σ (weeks_late × ld_pct_per_week × contract_value) for delayed projects |
