-- Test users for the integration suite. Apply after db/00_run_all.sql + app/migrations/*.
-- Roles come from the RBAC seed (db/08): SALES (QUOTATION VCEDX), FINANCE (QUOTATION VAX),
-- STORES (no QUOTATION perms). dual_user holds SALES+FINANCE to exercise the code-level
-- Segregation-of-Duties check (create + approve in one identity).
INSERT INTO sec.app_user(username,email,full_name,password_hash) VALUES
 ('sales_user','sales@be.test','Sales User','x'),
 ('stores_user','stores@be.test','Stores User','x'),
 ('finance_user','finance@be.test','Finance User','x'),
 ('dual_user','dual@be.test','Dual Role User','x')
ON CONFLICT (username) DO NOTHING;

INSERT INTO sec.user_role(user_id,role_id)
 SELECT u.user_id, r.role_id FROM sec.app_user u, sec.role r
 WHERE (u.username,r.role_code) IN (
   ('sales_user','SALES'),
   ('stores_user','STORES'),
   ('finance_user','FINANCE'),
   ('dual_user','SALES'),
   ('dual_user','FINANCE'))
ON CONFLICT DO NOTHING;
