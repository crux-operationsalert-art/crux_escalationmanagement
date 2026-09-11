-- =====================================================================
-- CRUX — schema patch v12, part two: the upload column catalogue.
--
-- What each loader reads, and the rule for every column. The hosted shell
-- serves its templates from here, so adding a kind is a row, not a deploy.
-- Run after schema-patch-v12.sql.
-- =====================================================================

delete from upload_column;
insert into upload_column (kind, ord, name, example, rule) values
('Chairs',1,'chair_code','BM_PUNE','Required, unique. The chair''s own key; people are seated by it.'),
('Chairs',2,'title','Branch Manager — Pune','Required. What the chair is called on screen.'),
('Chairs',3,'level','branch','board, function, region, branch, executive or admin.'),
('Chairs',4,'reports_to_chair_code','RM_WEST','Required except for the top chair. May name a chair created by this same file.'),
('Chairs',5,'reports_daily','yes','yes or no. Whether the holder files a daily count.'),

('People',1,'employee_no','EMP-0114','Required, unique. Your own numbering; it becomes the person key.'),
('People',2,'full_name','Amit Kulkarni','Required.'),
('People',3,'work_email','amit.kulkarni@cruxindia.co.in','Required, unique. Checked for near-duplicates — a misspelt domain is rejected, not accepted as a second person.'),
('People',4,'mobile','9021469966','Required, 10 to 13 digits. Used for sign-in by OTP where there is no Google account.'),
('People',5,'chair','Branch Manager — Pune','Required. The chair title or code. Must already exist — load Chairs first.'),
('People',6,'reports_to_employee_no','EMP-0088','Required except for the top chair. May name someone created by this same file.'),
('People',7,'date_of_joining','2023-01-12','YYYY-MM-DD. Roll-ups count from this date, never before it.'),
('People',8,'employment_type','Employee','Employee, Partner, Intern or Contract.'),

('Geography',1,'group','Zone A','Optional.'),
('Geography',2,'region','West','Optional. East, West, North, South, Central or North-East.'),
('Geography',3,'zone','Pune','Required, unique after trimming.'),
('Geography',4,'state','Maharashtra','Optional. The zone is filed under it.'),
('Geography',5,'city','Pune','Optional. Recorded under the zone when it differs from it.'),

('Clients and branches',1,'client_code','SBI','Required. One code must mean one client — two names under one code is rejected.'),
('Clients and branches',2,'client_name','State Bank of India','Required.'),
('Clients and branches',3,'branch_code','SBIN0030421','Required and unique within the client.'),
('Clients and branches',4,'branch_name','Kothrud','Required.'),
('Clients and branches',5,'zone','Pune','Required. Must exist in the Geography file.'),
('Clients and branches',6,'address','Kothrud, Pune 411038','Optional.'),
('Clients and branches',7,'status','ACTIVE','ACTIVE or INACTIVE.'),

('Assignments',1,'client_code','SBI','Required. Must exist.'),
('Assignments',2,'zone','Pune','Required. Must exist.'),
('Assignments',3,'product','Home loan','Optional. Blank means every product for that client at that location.'),
('Assignments',4,'handler_employee_no','EMP-0114','Required. Must exist in People.'),
('Assignments',5,'location_head_employee_no','EMP-0088','Optional. Gets the same scope but is not the assigned handler.'),
('Assignments',6,'effective_from','2026-04-01','Required, YYYY-MM-DD.'),
('Assignments',7,'effective_to','','Blank for open-ended. Overlapping dates on the same client, zone and product is an error — against this file and against what is already covered.'),

('Rates',1,'client_code','SBI','Required. Must already exist.'),
('Rates',2,'zone','Pune','Blank means every location for this client.'),
('Rates',3,'rate','196.00','Required. Non-negative, up to two decimals.'),
('Rates',4,'currency','INR','Optional, defaults to INR.'),
('Rates',5,'effective_from','2026-07-01','Required. Records before this date keep the rate that applied then.'),
('Rates',6,'effective_to','','Blank for open-ended. Must be after effective_from.'),
('Rates',7,'reason','Revised on renewal','Recommended. Stored against the rate version.'),

('Collections',1,'period','2026-09','Required, YYYY-MM.'),
('Collections',2,'client_code','SBI','Required.'),
('Collections',3,'zone','Pune','Required.'),
('Collections',4,'billed','540960.00','Required. What was invoiced.'),
('Collections',5,'collected','412300.00','Required. What was received.'),

('KPI targets',1,'period','2026-09','Required, YYYY-MM.'),
('KPI targets',2,'employee_no','EMP-0114','Required.'),
('KPI targets',3,'kpi_name','Field verifications completed','Required.'),
('KPI targets',4,'target','1200','Required.'),
('KPI targets',5,'unit','count','count, %, score or a lakh unit.'),
('KPI targets',6,'sub_category','SBI · Pune','Optional. Where a KPI row and sub-category rows both appear, the sub-categories must add up to the KPI target.'),

('Past performance',1,'file_part','mtd','Required. One of mtd, revenue or collections. Load mtd first.'),
('Past performance',2,'period','2026-08','Required, YYYY-MM. Load oldest month first.'),
('Past performance',3,'employee_no','EMP-0114','Required for file_part = mtd.'),
('Past performance',4,'kpi_name','Field verifications completed','Required for mtd.'),
('Past performance',5,'sub_category','SBI · Pune','Optional.'),
('Past performance',6,'client_code','SBI','Required for revenue and collections.'),
('Past performance',7,'location_code','Pune','Required for revenue and collections. Must exist in Geography.'),
('Past performance',8,'branch_code','SBIN0030421','Optional.'),
('Past performance',9,'unit','count','Optional, on mtd.'),
('Past performance',10,'target','1050','Optional on mtd.'),
('Past performance',11,'achieved','1092','Required for mtd.'),
('Past performance',12,'mtd_achieved','1092','Optional. Defaults to blank.'),
('Past performance',13,'invoiced_inr','1842000','Required for revenue. Whole rupees, no commas.'),
('Past performance',14,'realised_inr','1610000','Required for revenue.'),
('Past performance',15,'opening_outstanding_inr','940000','Required for collections.'),
('Past performance',16,'collected_inr','612000','Required for collections.'),
('Past performance',17,'closing_outstanding_inr','328000','Required for collections. Opening minus collected must equal closing.'),
('Past performance',18,'owner_employee_no','EMP-0114','Recommended on revenue and collections.'),
('Past performance',19,'source','Force1 export','Recommended. Where the number came from.'),

('Opening balances',1,'record_type','escalation','escalation or claim. ogl_assignment has no table in this schema yet and is refused.'),
('Opening balances',2,'reference','ESC-00193','Required, unique.'),
('Opening balances',3,'created_at','2026-08-27T15:26','Required. The real creation time — clocks are computed from this.'),
('Opening balances',4,'current_state','OPEN','An escalation: OPEN, IN_PROGRESS, RESOLVED, CLOSED or BLOCKED. A claim: DRAFT, OPS_APPROVAL, HR_APPROVAL, ACCOUNTS, DISPUTED, PAID or REJECTED.'),
('Opening balances',5,'owner_employee_no','EMP-0114','Required.'),
('Opening balances',6,'client_code','SBI','Required for an escalation.'),
('Opening balances',7,'zone','Pune','Optional.'),
('Opening balances',8,'amount','2400.00','For a claim. Non-negative, up to two decimals.'),

('Holidays',1,'date','2026-11-08','Required, YYYY-MM-DD, and a real date.'),
('Holidays',2,'name','Diwali','Required.'),
('Holidays',3,'scope','Festival','National, Festival, or a state name.'),
('Holidays',4,'confirmed','no','yes or no. A moon-sighting date stays no until it is fixed: an unconfirmed day is shown but never shortens a deadline.');
