# Go-Live Checklist — handing Boss Engineers ERP to the client

The system is feature-complete and deployed (API on Render, web on Vercel). This
is the short, ordered runbook to turn the current **demo** instance into a clean,
secured instance the client can start using. Do the steps in order; ⚠️ marks the
ones that change the live system.

Throughout:
- **Owner DB URL** = the Render **External Database URL** for `be-erp-db` (the
  superuser/owner string). Used for admin tasks (password reset, schema, cleanup).
- **App DB URL** = the `erp_app_login` connection string the API runs as (RLS).
- API base: `https://be-erp-api.onrender.com` · seeded login: `admin` (company id 1).

---

## 1. Security — do this first ⚠️

The live `admin` account still uses the password chosen during the build
(`BossErp#2026!`). **Rotate it before the client logs in.**

```bash
cd app
DATABASE_URL='<OWNER DB URL>' npm run set-password admin '<new-strong-password>'
# policy: >=12 chars, upper+lower+digit+symbol. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(12).toString('base64')+'#9a')"
```

Also confirm (Render → `be-erp-api` → Environment):
- [ ] `AUTH_JWT_SECRET` is set to a long random value (Render auto-generates it; if
      blank, set `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
- [ ] `DATABASE_URL` is the **erp_app_login** role, **not** the owner — this is what
      enforces Row-Level Security. (The owner URL is only for the admin tasks here.)
- [ ] `ERP_APP_PW` (the erp_app_login role password) is strong and not shared.

## 2. Lock down CORS ⚠️

`CORS_ORIGINS` is currently `*` (any origin). Set it to just your real front-end
origin(s) so only your app can call the API:

```
CORS_ORIGINS = https://<your-vercel-app>.vercel.app
```

Render → `be-erp-api` → Environment → edit `CORS_ORIGINS` → Save (triggers a redeploy).
Keep `*` only if you also ship the Electron desktop app (it has no fixed origin).

## 3. Start the client on a clean slate ⚠️

Company 1 currently contains only **demo data** — one worked lifecycle
(enquiries `sunny`/`xyz` → quote `QTN/MUM/2026-27/000001` → project
*High-Frequency Induction Heater* → 2 POs, 1 work order, 2 GRNs, 1 invoice) plus a
test approver user `ceo_boss`. Two ways to clear it:

### Option A (recommended) — fresh database
Because the DB has *only* test data, the cleanest, financially-consistent reset is
to rebuild it. On a fresh/empty `be-erp-db`:

```bash
ADMIN_DATABASE_URL='<OWNER DB URL>' \
ERP_APP_PW='<strong>' \
ADMIN_PW='<strong admin password>' \
./app/scripts/bootstrap-prod.sh
```

This rebuilds the schema, runs all migrations, recreates `erp_app_login`, and sets
`admin`'s password. (To empty an existing DB first, drop & recreate it from the
Render dashboard, or `DROP SCHEMA ... CASCADE` per `db/00_run_all.sql` — destructive.)

### Option B (quick) — hide the demo documents
If you'd rather keep the DB, soft-delete the demo records so they disappear from
all lists (reversible — only sets `is_deleted`). Note: this does **not** reverse
the demo invoice's ledger entries or GRN stock balances, so dashboards/reports may
still show demo figures. Use Option A for a truly clean financial slate.

```sql
-- run as OWNER:  psql "<OWNER DB URL>" -v ON_ERROR_STOP=1 -f cleanup.sql
BEGIN;
UPDATE fin.invoice        SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE scm.goods_receipt  SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE mfg.work_order     SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE scm.purchase_order SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE proj.project       SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE sales.quotation    SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE sales.enquiry      SET is_deleted=true WHERE company_id=1 AND NOT is_deleted;
UPDATE sec.app_user       SET is_active=false WHERE username='ceo_boss';
COMMIT;
```
> ⚠️ Run **once, before the client enters real data** — the `company_id=1` filter
> would also hit real records if re-run later.

## 4. Load the client's real master data

Before first use, load Boss Engineers' actual masters via the UI (**Master Data**
section) or SQL: customers, vendors, items (machines + components), work centres,
warehouses, and at least one released BOM + routing per machine model so the
one-click Work-Order auto-fill works. Then create the real users and assign roles
(Administration → Users / Roles).

## 5. Reliability (recommended)

- [ ] **Auto-apply migrations on deploy** — set `MIGRATE_DATABASE_URL` on the
      `be-erp-api` service to the **Internal Database URL (owner user)**. The
      container then runs pending migrations on every boot, so new-table features
      stop 500-ing after a deploy. Without it, run each new migration manually:
      `psql "<owner external URL>?sslmode=require" -v ON_ERROR_STOP=1 -f app/migrations/<NNN>_*.sql`.
- [ ] **Backups** — schedule `DATABASE_URL='<OWNER DB URL>' app/scripts/backup.sh`
      (custom-format `pg_dump`) on a cron and ship dumps off-box, **or** move
      `be-erp-db` to a Render paid plan for point-in-time recovery.
- [ ] **Cold start** — the Render free tier sleeps after inactivity (~50 s first
      request). Upgrade `be-erp-api` to a paid instance for an always-warm service
      before the client's first impression.
- [ ] **Domain** (optional) — put the API + web on a custom domain instead of the
      `onrender.com` / `vercel.app` URLs.

## 6. Desktop app (if distributing)

Rebuild the macOS `.dmg` so it points at the production API and includes the latest
features:

```bash
cd web && VITE_API_BASE='https://be-erp-api.onrender.com' npm run build && cd ..
cd desktop && npm run dist     # outputs the signed .dmg
```

---

### Quick status (as of this checklist)
| Area | State |
|---|---|
| Features (16 modules + one-click flows + Gantt) | ✅ complete |
| Tests | ✅ 96 suites / 1247 passing |
| API (Render) | ✅ live |
| Web (Vercel) | ✅ auto-deployed |
| Admin password rotated | ⬜ **do (step 1)** |
| CORS locked down | ⬜ **do (step 2)** |
| Demo data cleared | ⬜ **do (step 3)** |
| Real masters loaded | ⬜ do (step 4) |
| Backups / paid tier | ⬜ recommended (step 5) |
