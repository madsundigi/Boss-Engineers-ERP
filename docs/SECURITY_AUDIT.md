# Security Audit — Vulnerabilities Report — Boss Engineers ERP

| Field | Detail |
|---|---|
| Document ID | BE-ERP-SEC-001 |
| Version | 1.0 |
| Date | 2026-06-06 |
| Auditor | ERP Security Auditor |
| Scope | Built application (M01/M02, platform), API, UI, dependencies, DB access layer |
| Method | Source review + `npm audit` + manual analysis; areas: AuthN, AuthZ, Session, Passwords, API, SQLi, XSS, CSRF, Rate-limiting |

## Posture: **HIGH RISK — Not production-secure**
**Findings: 19** — 🔴 Critical 1 · 🟠 High 10 · 🟡 Medium 5 · ⚪ Low/Info 3.

> **Remediation status (2026-06-06):** A first hardening pass landed (verified, 65 tests green).
> **Fixed:** XSS1/XSS2 (output escaping + textContent — proven inert), API1/RL1 (rate limiting), API2 (helmet), API3 (CORS allowlist), API4 (nodemailer ≥8.0.10 — `npm audit` 0), API6 (array bound), Z3 (SoD self-approval — code check + test).
> **Mitigated/partial:** A1 (JWT verification added; dev-header fallback remains for non-prod), Z1 (RLS policies added, enforced under the `erp_app` role), P1/A2 (password hashing + policy util added; full login flow pending), Z2 (DOA `doa_rule` table added; runtime enforcement pending).
> **Still open:** A3 (MFA), S1 (token refresh/revocation), and all operational items (backup/DR/monitoring) per PRODUCTION_READINESS.md. Re-test + pen-test still required before launch.

> Strong foundations at the data layer (parameterized SQL, RBAC deny-by-default, tamper-evident audit). The **application security perimeter is largely unbuilt**: identity is trusted from headers, there is no rate limiting or security headers, the UI has a stored-XSS hole, authorization is table-level only (no row-scope / SoD / DOA), and a High-severity dependency CVE is open. **Do not expose this to untrusted networks until the Critical/High items are fixed.**

Severity legend: 🔴 Critical (immediate, exploitable, high impact) · 🟠 High · 🟡 Medium · ⚪ Low/Info. CVSS values are indicative base scores.

---

## 1. Authentication
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-A1** | 🔴 Critical (CVSS ~9.8) | **Identity trusted from request headers** — `x-user-id/-company-id/-bu-id` accepted with no token verification. `src/common/auth.ts`. | Full **auth bypass + tenant impersonation** if deployed without an enforcing gateway; any caller becomes any user/company. | Verify a signed **JWT/OIDC** in the app (or enforce mTLS gateway→service); derive identity/tenant from the verified token, never raw headers. | 287, 290 |
| **VULN-A2** | 🟠 High | **No credential authentication in app** — `sec.app_user.password_hash` exists but the app never hashes/verifies; no login flow. | Missing authentication for a critical function. | Implement login (argon2id/bcrypt verify), token issuance. | 306 |
| **VULN-A3** | 🟠 High | **MFA not enforced** — `mfa_enabled` column unused. | Account takeover risk for privileged roles. | Enforce MFA for CEO/Admin/Finance. | 308 |

## 2. Authorization
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-Z1** | 🟠 High (CVSS ~8.1) | **Broken object-level authorization (IDOR)** — no row-level data scope; repositories filter by `company_id` only, so any authenticated user can `GET/PATCH/DELETE` any record by id. (QA PI-01) | Horizontal privilege escalation; cross-territory data exposure & tampering. | PostgreSQL **RLS** + per-role scope predicates (owner/territory/branch). | 639, 284 |
| **VULN-Z2** | 🟠 High | **DOA value-band not enforced** — any `QUOTATION.APPROVE` holder approves any value. (QA PI-02) | Financial control bypass; large/loss-making quotes approved by junior staff. | Enforce approver tier vs value band in the approval engine. | 285 |
| **VULN-Z3** | 🟠 High | **Segregation-of-Duties bypass (self-approval)** — `decided_by` not checked `≠ creator/submitter`. (QA PI-03) | Fraud risk; one user creates & approves. | Block self-approval; consult `sec.sod_conflict` at runtime. | 285 |

*Strength:* RBAC guard is present on every route and **deny-by-default** at the action level.

## 3. Session Management
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-S1** | 🟡 Medium | **No token lifecycle** — stateless API today; once JWT is introduced there is no expiry/refresh/revocation defined. `x-session-id` is unauthenticated audit metadata (spoofable). | Stolen tokens valid indefinitely; no logout/revoke. | Short-lived access tokens + refresh + server-side revocation list; optional device/IP binding. | 613, 384 |

## 4. Password Policies
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-P1** | 🟠 High | **No password policy** — no complexity/length/rotation/history, **no account lockout/backoff**, no hashing in app. | Weak/brute-forceable credentials once auth is built. | NIST 800-63B policy, **argon2id**, lockout + exponential backoff, breached-password (HIBP) check. | 521, 307 |

## 5. API Security
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-API1** | 🟠 High | **No rate limiting** on any endpoint (auth, API, export, numbering). | Brute force, credential stuffing, scraping, DoS. | Per-IP + per-user throttling; stricter on auth/export; WAF. | 770, 799 |
| **VULN-API4** | 🟠 High | **Vulnerable dependency: nodemailer ≤ 8.0.4** — SMTP command injection (GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g), email-to-unintended-domain, addressparser DoS. `npm audit` → 1 high. | Mail server compromise / data exfil via crafted input. | Upgrade **nodemailer ≥ 8.0.10**; add `npm audit --audit-level=high` to CI. | 77, 1395 |
| **VULN-API2** | 🟡 Medium | **No security headers** — helmet absent (no HSTS, X-Content-Type-Options, frame-ancestors, Referrer-Policy, **CSP**). | Clickjacking, MIME sniffing, weaker XSS defense. | Add `helmet` + a strict CSP. | 693 |
| **VULN-API3** | 🟡 Medium | **No CORS policy** configured. | Uncontrolled cross-origin access if browser-exposed. | Explicit origin allowlist; credentials off by default. | 942 |
| **VULN-API6** | 🟡 Medium | **Unbounded arrays** — JSON capped at 256kb but no line/array-count limit. (QA MV-06) | Resource-exhaustion DoS. | Cap array sizes in DTOs. | 400 |
| **VULN-API5** | ⚪ Low | No API versioning; ensure 500s never leak stack traces. *Mass-assignment is mitigated by DTO whitelists (good).* | Minor. | Add versioning; verify error redaction. | 209 |

## 6. SQL Injection
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-SQL1** | ⚪ Low/Info | **Well-mitigated** — all queries use bound parameters (`$1…`); dynamic `ORDER BY`/direction come from **zod enums** (whitelisted), `LIMIT/OFFSET` are coerced integers. No user input is string-interpolated into SQL. | Residual risk low. | Keep the enum-whitelist discipline; add a lint rule against template-literal SQL containing variables. | 89 |

## 7. Cross-Site Scripting (XSS)
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-XSS1** | 🟠 High (CVSS ~7.4) | **Stored/DOM XSS in UI list rendering** — `innerHTML = list.map(...)` injects server data unescaped. `app/ui/enquiry-list.html:77`, `app/ui/quotation-list.html:55` (renders `customerName`, `contact`…). A record named `<img src=x onerror=…>` executes in every viewer's session. | Session/token theft, actions-as-victim, data exfiltration. | Render with `textContent`/escaping or an auto-escaping framework; add **CSP** as defense-in-depth. | 79 |
| **VULN-XSS2** | ⚪ Low | Toast helpers use `innerHTML` with developer-supplied text. | Low. | Use `textContent`. | 79 |

*Server side:* the API returns `application/json` only → no reflected server XSS; never serve responses as `text/html`.

## 8. CSRF
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-CSRF1** | ⚪ Info (🟡 if cookies adopted) | **Not currently exploitable** — API auth is header/token-based (no cookie session), so cross-site requests carry no ambient credentials. However there are **no CSRF tokens / SameSite controls**; introducing cookie auth later exposes every state-changing endpoint. | None today; High latent risk. | Keep `Authorization`-header auth; if cookies are ever used, add CSRF tokens + `SameSite=Strict` and reject cookie creds for the API. | 352 |

## 9. Rate Limiting
| ID | Sev | Finding · Evidence | Impact | Remediation | CWE |
|---|---|---|---|---|---|
| **VULN-RL1** | 🟠 High | **Absent everywhere** — no throttling on auth, API, export, or document-number allocation. | Brute force, scraping, DoS, number-exhaustion. | Token-bucket limits per IP+user; strict on auth/export; edge WAF. | 770 |

---

## Strengths (verified — keep these)
- **Parameterized SQL** throughout — no injection surface.
- **RBAC** guard on every route, **deny-by-default**.
- **Append-only, tamper-evident audit** (hash-chain seals; tamper-detection tested; UPDATE/DELETE revoked).
- **Optimistic locking** protects integrity on most mutations.
- **DTO whitelists** prevent mass-assignment; **DB CHECK constraints** as defense-in-depth.
- **Secrets** via env; `.env` gitignored.

## Remediation Priority
1. **VULN-A1** — gateway/JWT verification (kills the Critical auth bypass).
2. **VULN-XSS1** — escape UI output + CSP.
3. **VULN-RL1** — rate limiting (+ WAF).
4. **VULN-API4** — upgrade nodemailer; `npm audit` in CI.
5. **VULN-Z1** — RLS data scope.
6. **VULN-Z2 / Z3** — DOA value-band + SoD enforcement.
7. **VULN-P1 / A2 / A3** — password policy, login, MFA.
8. **VULN-API2/API3 / S1** — helmet + CSP + CORS; token lifecycle.

**Re-test:** after fixes, repeat this audit + a third-party penetration test before any production exposure. No Critical/High may remain open at launch.
