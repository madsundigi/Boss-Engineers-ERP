# Deploying Boss Engineers ERP (API)

The API is a stateless Node/Express service backed by PostgreSQL 16. It is
production-safe **only** when (a) it connects as the non-superuser `erp_app_login`
role so Row-Level Security is enforced, and (b) `AUTH_JWT_SECRET` is set so auth
fails closed and clients must obtain a token from `POST /auth/login`.

## 1. One-time database bootstrap

Run these once against a fresh database, connected as the **owner/superuser**
(`$ADMIN_DATABASE_URL`). Do them from a machine that has `psql` + Node 20.

```bash
# a) Build the schema (creates all tables + the erp_app group role). Run from repo root.
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/00_run_all.sql

# b) Apply incremental app migrations (001..NNN).
cd app && DATABASE_URL="$ADMIN_DATABASE_URL" npm ci && npm run migrate && cd ..

# c) Create the RLS login role the app connects as (pick a strong password).
export ERP_APP_PW='change-this-strong-password'
psql "$ADMIN_DATABASE_URL" -v erp_app_pw="$ERP_APP_PW" -f db/10_prod_login_role.sql

# d) Set a real password for the seeded admin user (>=12 chars, mixed).
cd app && DATABASE_URL="$ADMIN_DATABASE_URL" npm run set-password admin_user 'Admin#Str0ngPass!' && cd ..
```

The app's runtime `DATABASE_URL` must then use the login role, **not** the owner:

```
postgres://erp_app_login:<ERP_APP_PW>@<host>:5432/boss_engineers_erp
```

## 2. Required runtime env (see app/.env.example)

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | the `erp_app_login` connection string (RLS enforced) |
| `AUTH_JWT_SECRET` | yes (prod) | long random; without it prod rejects every request |
| `AUTH_JWT_TTL` | no | token lifetime, default `8h` |
| `CORS_ORIGINS` | yes (browser) | comma-separated allowlist incl. the desktop app origin |
| `NODE_ENV` | yes | `production` |
| `SMTP_URL`, `MAIL_FROM` | no | outbound mail; omit to use the in-memory outbox |

## 3. Deploy on Render (blueprint)

`render.yaml` provisions a managed Postgres + a Docker web service.

1. Push this repo; in Render: **New → Blueprint**, select the repo.
2. Let it create `be-erp-db` and `be-erp-api`. `AUTH_JWT_SECRET` is auto-generated.
3. **Before the first deploy succeeds**, run the §1 bootstrap once against the new
   managed DB (use its *owner* connection string from the Render dashboard).
4. Override the service's `DATABASE_URL` to the **erp_app_login** string from §1c.
5. Set `CORS_ORIGINS` to your frontend / desktop origin.
6. Redeploy. `preDeployCommand` runs migrations; health check is `GET /health`.

## 4. Run locally with Docker

```bash
docker build -t be-erp-api app
docker run --rm -p 3001:3001 \
  -e DATABASE_URL='postgres://erp_app_login:...@host.docker.internal:5432/boss_engineers_erp' \
  -e AUTH_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  -e NODE_ENV=production be-erp-api
```

The container runs migrations (idempotent) then starts the API on `:3001`.

## 5. Get a token & call the API

```bash
TOKEN=$(curl -s localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin_user","password":"Admin#Str0ngPass!","companyId":1}' | jq -r .token)
curl -s localhost:3001/api/me -H "Authorization: Bearer $TOKEN"
```

## 6. Backup / DR

Schedule `pg_dump` (e.g. daily) and verify restores; Render managed Postgres also
offers point-in-time recovery on paid plans. Document your RPO/RTO targets.
