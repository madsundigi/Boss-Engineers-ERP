# CEO Dashboard (M16) — Single-Page Spec

| Field | Detail |
|---|---|
| Document ID | BE-ERP-CEO-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Builds on | REPORTING_ARCHITECTURE, DATABASE_DESIGN (rpt matviews), DESIGN_SYSTEM |
| UI | `app/ui/ceo-dashboard.html` (rendered) |
| Status | Baseline |

One screen, no scrolling for the headline numbers. Read-only, near-real-time, RBAC-gated to leadership (`DASHBOARD.VIEW`, `REPORTS.EXPORT`). Every number drills through to its report/detail. Built on the CEO materialized views so it never touches live transaction tables.

---

## 1. Layout (single page)
```
┌───────────────────────────────────────────────────────────────────────────┐
│ Filter bar: Company · Branch · FY · Currency · "data as of HH:MM" · RAG key │
├───────────────────────────────────────────────────────────────────────────┤
│ HEADLINE KPI ROW:  Order Book │ Revenue YTD │ Gross Margin │ OTD% │ At-Risk │
├──────────────────────────────────────────┬────────────────────────────────┤
│ Project Health (RAG heatmap)             │ Delays / At-Risk Projects (list) │
├───────────────┬───────────────┬──────────┴───────┬───────────┬────────────┤
│ Procurement   │ Production    │ FAT              │ Install   │ Service     │
│ (mini-tiles)  │ (mini-tiles)  │ (mini-tiles)     │ (tiles)   │ (tiles)     │
└───────────────┴───────────────┴──────────────────┴───────────┴────────────┘
```
Responsive: tiles reflow; heatmap + at-risk stack on narrow screens. Refresh badge shows matview age.

## 2. Widget Catalogue (the 9 required areas)
| # | Area | Widget(s) | Shows | Source | Drilldown |
|---|---|---|---|---|---|
| W1 | **Projects** | 3 KPI tiles + **RAG heatmap** | Active projects, OTD %, Projects at risk; per-project R/A/G | `mv_ceo_portfolio`, `mv_project_health_heatmap` | → Project Report (R3) / project detail |
| W2 | **Revenue** | 3 KPI tiles + trend line | Order book, Revenue recognized YTD, Order intake MTD | `mv_ceo_portfolio.active_order_book`, `fact_project_financials` | → Sales Report (R1) / Profitability (R10) |
| W3 | **Profit** | 3 KPI tiles + margin bar | Portfolio gross margin %, Margin variance, Margin-erosion alerts | `fact_project_financials`, `fin.margin_snapshot` | → Profitability Report (R10) |
| W4 | **Delays** | 3 KPI tiles + **at-risk list** | Delayed projects, Avg slippage (days), LD exposure; predicted-late list | `mv_at_risk_projects` (delay_days, risk_level) | → Delivery Prediction (M09) / project |
| W5 | **Procurement** | 4 mini-tiles | Open PO value, Committed cost, On-time vendor delivery %, Critical-item alerts | `fact_procurement` | → Procurement Report (R4) |
| W6 | **Production** | 3 mini-tiles | Schedule adherence %, Scrap/rework %, WIP value | `fact_production` | → Production Report (R6) |
| W7 | **FAT** | 2 mini-tiles | First-pass yield %, Open punch items | `fact_quality`* | → FAT Report (R7) |
| W8 | **Installation** | 3 mini-tiles | Installs in progress, SAT first-pass %, Avg install cycle (days) | `fact_installation`* | → Installation Report (R8) |
| W9 | **Service** | 3 mini-tiles | Open tickets, SLA adherence %, Warranty cost % | `fact_service` | → Service Report (R9) |

`* fact_quality / fact_installation are recommended projections (see REPORTING_ARCHITECTURE R7/R8).`

## 3. KPI Formulas
| KPI | Formula |
|---|---|
| **Active Projects** | `count(project WHERE status = 'ACTIVE')` → `mv_ceo_portfolio.active_projects` |
| **On-Time Delivery (OTD) %** | `delivered_on_or_before_committed ÷ total_delivered × 100` |
| **Projects at Risk** | `count(project WHERE health_rag='R' OR delay_days>0 OR margin_pct < target)` |
| **Order Book** | `Σ contract_value (status='ACTIVE') − recognized_revenue` |
| **Revenue Recognized YTD** | `Σ revenue_recognized` over FY-to-date (milestone / % completion) |
| **Order Intake MTD** | `Σ contract_value of projects won in current month` |
| **Portfolio Gross Margin %** | `(Σ revenue − Σ actual_cost) ÷ Σ revenue × 100` |
| **Margin Variance** | `quoted_margin% − actual_margin%` (portfolio-weighted) |
| **Margin-Erosion Alerts** | `count(project WHERE quoted_margin% − forecast_margin% > threshold)` |
| **Delayed Projects** | `count(WHERE delay_days > 0)` → `mv_at_risk_projects` |
| **Avg Slippage (days)** | `avg(delay_days WHERE delay_days > 0)` |
| **LD Exposure** | `Σ (weeks_late × ld_pct_per_week × contract_value)` for delayed projects |
| **Open PO Value** | `Σ po_value WHERE status IN ('APPROVED','PARTIALLY_RECEIVED')` |
| **Committed Cost** | `Σ open PO committed cost` (commitment accounting) |
| **On-Time Vendor Delivery %** | `on_time_GRNs ÷ total_GRNs × 100` |
| **Critical-Item Alerts** | `count(critical_item WHERE order_by_date < today AND not_ordered)` |
| **Schedule Adherence %** | `on_time_operations ÷ total_operations × 100` |
| **Scrap/Rework %** | `(scrap_qty + rework_qty) ÷ produced_qty × 100` |
| **WIP Value** | `Σ (material_issued + labour_booked) of open work orders` |
| **First-Pass FAT Yield %** | `FAT_passed_first_time ÷ total_FAT × 100` |
| **Open Punch Items** | `count(punch_item WHERE status='OPEN')` |
| **Installs In Progress** | `count(installation WHERE status IN ('IN_PROGRESS','COMMISSIONING'))` |
| **SAT First-Pass %** | `SAT_passed_first_time ÷ total_SAT × 100` |
| **Avg Install Cycle (days)** | `avg(commissioned_date − install_start_date)` |
| **Open Tickets** | `count(service_ticket WHERE status='OPEN')` |
| **SLA Adherence %** | `tickets_resolved_within_SLA ÷ closed_tickets × 100` |
| **Warranty Cost %** | `warranty_cost ÷ revenue × 100` |
| **CPI / SPI** | `CPI = EV ÷ AC` · `SPI = EV ÷ PV` (from `mv_project_health_heatmap`) |

## 4. Drilldown Map
| From (widget/KPI) | To | Route |
|---|---|---|
| Any project tile / RAG cell | Project detail | `/projects/:id` |
| OTD %, At-Risk, Delays list | Delivery Prediction | `/delivery-forecast/project/:id` |
| Order Book, Revenue | Profitability project P&L | `/profitability/project/:id` |
| Gross Margin, Margin variance | Profitability Report | `/finance/dashboard` → R10 |
| Procurement tiles | Procurement Report | `/procurement/dashboard` → R4 |
| Production tiles | Production Report | `/production/dashboard` → R6 |
| FAT tiles | FAT Report | `/quality/dashboard` → R7 |
| Installation tiles | Installation Report | `/logistics/dashboard` → R8 |
| Service tiles | Service Report | `/service/dashboard` → R9 |

## 5. Data Sources & Refresh
- **Matviews** (`mv_ceo_portfolio`, `mv_project_health_heatmap`, `mv_at_risk_projects`) refresh `CONCURRENTLY` every 5–15 min; the dashboard reads only these + the `fact_*` aggregates — zero load on OLTP.
- **`mv_at_risk_projects`** already exposes `predicted_delivery`, `committed_delivery`, `delay_days`, `risk_level`, `margin_pct` — directly powering W1/W3/W4.
- **Security:** `DASHBOARD.VIEW` (CEO/leadership per RBAC); export via `REPORTS.EXPORT`; every view/export captured by the audit trail. Read-only — no write paths.
