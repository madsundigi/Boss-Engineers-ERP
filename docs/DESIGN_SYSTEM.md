# ERP Design System — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-UX-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Implementation | `design-system/tokens.css`, `design-system/components.css`, `design-system/index.html` |
| Status | Verified — renders in browser (screenshots taken) |
| References | SAP Fiori / Horizon · Oracle Redwood · Microsoft Fluent 2 / Dynamics 365 |

A **framework-agnostic, token-driven** component library for an enterprise ERP. Plain HTML + CSS custom properties — ports cleanly to React, Angular, Vue, or Blazor. No build step required to view (`design-system/index.html`).

---

## 1. Design Principles (the guardrails)
1. **Function over decoration.** This is a data tool used 8 hours a day. Clarity, density, and scan-ability beat visual flair. *No startup UI.*
2. **Restraint.** One accent colour (action blue). Neutral greys. Minimal radii (2–4px). Flat by default; elevation only for true overlays.
3. **Motion is functional, never decorative.** Transitions ≤120ms, limited to hover/focus/state. `prefers-reduced-motion` disables all of it. *No fancy animations.*
4. **Density is a first-class feature.** Standard (40px rows) and Compact (32px) modes via one body class — high-volume ERP screens need to show more without scrolling.
5. **System fonts only.** No web-font downloads — fast, native, familiar (Segoe UI / -apple-system / Roboto stack).
6. **Tokens are the contract.** Components never hard-code colour/spacing/size; they read CSS variables. Re-theme by editing `tokens.css` alone. *No vibe coding — everything is specified.*
7. **Accessible by default.** WCAG 2.1 AA contrast, visible focus rings, full keyboard operation, semantic HTML + ARIA on overlays.

## 2. Foundations (tokens — see `tokens.css`)
- **Colour:** neutral canvas/surfaces; one primary (`#0a6ed1`); semantic success/warning/error/info (text + subtle-bg pairs); a dedicated **ERP document-status palette** (draft, pending, in-progress, on-hold, approved, rejected, closed); shell colours (dark topbar, light sidebar).
- **Type:** system stack + mono (for IDs/amounts); scale 11→24px, **base 13px** for data density; weights 400/500/600/700; tabular numerals for figures.
- **Spacing:** 4px base scale (`--sp-1…--sp-10`).
- **Radius:** 2px / 4px / pill. **Elevation:** card / popover / modal (subtle).
- **Layout metrics:** topbar 48px, sidebar 240px (48px collapsed), page max 1440px.
- **Density:** `--row-h`, `--control-h` (flip with `body.density-compact`).
- **Z-index scale** and **motion tokens** (`--motion-fast`, `--ease`).

## 3. Components

### 3.1 Layout — application shell
CSS grid: fixed **topbar** (full width) + **sidebar** (left) + scrollable **content**. Content uses a centred `.erp-page` (max 1440px) with breadcrumb, page title/subtitle, and a right-aligned primary-action cluster. Sidebar collapses to icons via `.erp-shell--collapsed`.
*Do:* keep one primary action per page. *Don't:* nest scrollbars inside the content area unnecessarily.

### 3.2 Sidebar (primary navigation)
Light panel, uppercase **section labels**, 36px items with icon + label + optional count badge. Active item: subtle blue fill + 3px left accent bar + blue text. Hover: neutral fill. Single level shown; deep trees should use grouped sections, not >2 levels of nesting.

### 3.3 Topbar
Dark shell bar: burger (collapse), brand/logo, global **search** (Ctrl+/), spacer, action icons with **count badges** (approvals, notifications, help), and user avatar/menu. Stays fixed; never scrolls. Search is global and keyboard-reachable.

### 3.4 Tables (data grid)
The workhorse. **Toolbar** (title + record count + Filter/Columns) → optional **bulk-action bar** (appears on selection, blue) → **sticky header** with sortable columns (sort indicator) → rows (zebra-on-hover, selected = blue tint) → **pagination** footer. Numbers right-aligned + tabular. Status shown as **badges**. Row checkboxes for multi-select. Compact density recommended for transaction lists.
*Do:* right-align numeric columns, keep status in the last column. *Don't:* wrap IDs — use the mono class and ellipsis.

### 3.5 Forms
12-column **field grid**; fields span 3/4/6/12. Label **above** control (12px semibold), required `*` in red, optional **hint** below. Controls are 32px tall, full-width, with hover/focus/disabled/readonly states. **Inline validation**: `.erp-field--error` paints the border red + shows an error message under the field. Grouped into **sections** with a legend rule. Sticky **action footer**: Cancel (secondary) + Save (primary), right-aligned.
*Do:* validate inline on blur, summarise errors at submit. *Don't:* use placeholder text as labels.

### 3.6 Dashboards
**KPI tiles** (label, large tabular value, coloured delta up/down, optional accent top-border) in an auto-fill grid, plus **panels** (head + body) hosting charts/tables. A chart placeholder marks where a charting lib (ECharts/Recharts) plugs in. Read-only, drill-through via links. Built for the CEO dashboard + module landing pages.

### 3.7 Modals / dialogs
Backdrop (45% scrim) + centred dialog (default 520px, `--lg` 800px) with **head** (title + close), scrollable **body**, and **footer** (Cancel + primary). `role="dialog" aria-modal`. Reserve for focused tasks (quick-create, confirmation); never stack modals; long forms belong on a page, not a modal.

### 3.8 Notifications
Two channels: **inline alerts/banners** (info/success/warning/error — coloured left border + subtle bg, used for page-level context like the critical-item warning) and **toasts** (bottom-right, transient, auto-dismiss ~4s, dismissible) for action feedback. Plus **count badges** on topbar icons. Errors that block work are inline; confirmations are toasts.

### 3.9 Approval screens
Two-column: **main** (sticky **action bar** with document identity + status badge + Reject/Approve buttons, then document detail panels using a label/value definition list) + **aside** (**approval trail timeline** showing each step's actor, decision, timestamp, and note, with coloured dots for approved/rejected/current). Designed around the DOA engine: shows DOA level, budget impact, and whether the item is critical. Reject requires a reason (per the audit/RBAC rules).

## 4. Accessibility & Behaviour
- Contrast AA; visible `:focus-visible` ring on every interactive element.
- Full keyboard operation; modals trap focus and close on Esc (wire in framework).
- `prefers-reduced-motion` removes all transitions.
- Tabular numerals + right-alignment for all financial figures.

## 5. File Structure & Consumption
```
design-system/
  tokens.css       # foundations — the single source of truth; re-theme here
  components.css   # all .erp-* component classes (consumes tokens)
  index.html       # living showcase of all 9 component areas (open in any browser)
```
Link both stylesheets, use the `.erp-*` classes. To theme: edit `tokens.css`. To port to a framework: wrap each block as a component, keep the class names (or map tokens into the framework's theme provider). Preview locally via `.claude/launch.json` (static server on :4173).

## 6. Verification
Rendered in a headless browser at 1440px:
- App shell, dark topbar (search + badged action icons + avatar), light sectioned sidebar with active state ✔
- KPI tiles with deltas; inline warning banner ✔
- Data table: toolbar, bulk-action bar (2 selected), sortable sticky header, status badges, pagination ✔
- Approval screen: sticky action bar (Reject/Approve, Pending L2), definition-list details, decision timeline ✔
- Form: 12-col grid, required markers, **inline error state** (GSTIN), hints, textarea, checkbox, action footer ✔
- Modal (quick-create PO) + toast feedback ✔
