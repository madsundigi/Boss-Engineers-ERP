-- Test fixtures for the integration suite. Apply after db/00_run_all.sql + app/migrations/*.
-- One user per role (username convention: <role>_user) so each module's integration
-- tests can act as the correct role. Plus a customer / vendor / item so the document
-- modules have the master data they reference. dual_user holds SALES+FINANCE to exercise
-- the code-level Segregation-of-Duties check.

INSERT INTO sec.app_user(username,email,full_name,password_hash) VALUES
 ('sales_user','sales@be.test','Sales User','x'),
 ('stores_user','stores@be.test','Stores User','x'),
 ('finance_user','finance@be.test','Finance User','x'),
 ('dual_user','dual@be.test','Dual Role User','x'),
 ('ceo_user','ceo@be.test','CEO User','x'),
 ('admin_user','adminu@be.test','Admin User','x'),
 ('planning_user','planning@be.test','Planning User','x'),
 ('purchase_user','purchase@be.test','Purchase User','x'),
 ('production_user','production@be.test','Production User','x'),
 ('qc_user','qc@be.test','QC User','x'),
 ('install_user','install@be.test','Install User','x'),
 ('service_user','service@be.test','Service User','x'),
 ('hr_user','hr@be.test','HR User','x')
ON CONFLICT (username) DO NOTHING;

INSERT INTO sec.user_role(user_id,role_id)
 SELECT u.user_id, r.role_id FROM sec.app_user u, sec.role r
 WHERE (u.username,r.role_code) IN (
   ('sales_user','SALES'), ('stores_user','STORES'), ('finance_user','FINANCE'),
   ('dual_user','SALES'), ('dual_user','FINANCE'),
   ('ceo_user','CEO'), ('admin_user','ADMIN'), ('planning_user','PLANNING'),
   ('purchase_user','PURCHASE'), ('production_user','PRODUCTION'), ('qc_user','QC'),
   ('install_user','INSTALL'), ('service_user','SERVICE'), ('hr_user','HR'))
ON CONFLICT DO NOTHING;

-- Master-data fixtures (company BE, currency INR, uom NOS, category RAW already seeded by db/06).
INSERT INTO mdm.customer(company_id, customer_code, customer_name, customer_type, default_currency_id)
 SELECT c.company_id, 'CUST-TEST', 'Test Customer Ltd', 'EPC', cur.currency_id
 FROM mdm.company c, mdm.currency cur WHERE c.company_code='BE' AND cur.iso_code='INR'
ON CONFLICT (customer_code) DO NOTHING;

INSERT INTO mdm.vendor(company_id, vendor_code, vendor_name, is_approved)
 SELECT c.company_id, 'VEND-TEST', 'Test Vendor Pvt Ltd', true
 FROM mdm.company c WHERE c.company_code='BE'
ON CONFLICT (vendor_code) DO NOTHING;

INSERT INTO mdm.item(company_id, item_code, item_name, item_category_id, item_type, base_uom_id, std_cost)
 SELECT c.company_id, 'ITEM-TEST', 'Test Item', cat.category_id, 'RAW', u.uom_id, 100
 FROM mdm.company c, mdm.item_category cat, mdm.uom u
 WHERE c.company_code='BE' AND cat.cat_code='RAW' AND u.uom_code='NOS'
ON CONFLICT (item_code) DO NOTHING;
