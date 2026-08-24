-- =============================================================================
-- HRM :: 14_seed.sql
-- ข้อมูลตั้งต้น: สิทธิ, บทบาทมาตรฐาน, ประเภทการลาตามระเบียบราชการ,
-- กะทำงาน, รายการเงินได้-หัก, อัตราประกันสังคม, ขั้นภาษี, แบบประเมิน
-- และองค์กรตัวอย่าง 1 แห่ง + สถานบริการ 2 แห่ง
-- รันซ้ำได้ (idempotent)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into permissions (code, module, action, name_th) values
  ('*',                        'system',      'all',    'สิทธิทั้งหมด (ผู้ดูแลระบบ)'),
  ('dashboard.read',           'dashboard',   'read',   'ดูแดชบอร์ด'),
  ('org.read',                 'org',         'read',   'ดูโครงสร้างองค์กร'),
  ('org.manage',               'org',         'manage', 'จัดการโครงสร้างองค์กร/ตำแหน่ง'),
  ('employee.read',            'employee',    'read',   'ดูข้อมูลบุคลากร (ในขอบเขตตน)'),
  ('employee.read_all',        'employee',    'read',   'ดูข้อมูลบุคลากรทั้งองค์กร'),
  ('employee.read_facility',   'employee',    'read',   'ดูข้อมูลบุคลากรในสถานบริการที่ดูแล'),
  ('employee.read_confidential','employee',   'read',   'ดูเอกสาร/ข้อมูลลับของบุคลากร'),
  ('employee.write',           'employee',    'write',  'เพิ่ม/แก้ไขข้อมูลบุคลากร'),
  ('employee.delete',          'employee',    'delete', 'ลบข้อมูลบุคลากร'),
  ('recruitment.read',         'recruitment', 'read',   'ดูข้อมูลการรับสมัคร'),
  ('recruitment.write',        'recruitment', 'write',  'จัดการประกาศ/ใบสมัคร'),
  ('recruitment.hire',         'recruitment', 'approve','บรรจุผู้สมัครเป็นบุคลากร'),
  ('time.read',                'time',        'read',   'ดูข้อมูลเวลาปฏิบัติงาน'),
  ('time.write',               'time',        'write',  'บันทึก/แก้ไขเวลา'),
  ('time.approve',             'time',        'approve','อนุมัติแก้ไขเวลา/ล่วงเวลา'),
  ('leave.read',               'leave',       'read',   'ดูข้อมูลการลา'),
  ('leave.write',              'leave',       'write',  'บันทึกใบลา'),
  ('leave.approve',            'leave',       'approve','อนุมัติใบลา'),
  ('leave.manage',             'leave',       'manage', 'ตั้งค่าประเภทลา/สิทธิวันลา'),
  ('payroll.read',             'payroll',     'read',   'ดูข้อมูลเงินเดือน'),
  ('payroll.write',            'payroll',     'write',  'จัดการเงินเดือน'),
  ('payroll.calculate',        'payroll',     'write',  'ประมวลผลเงินเดือน'),
  ('payroll.approve',          'payroll',     'approve','อนุมัติจ่ายเงินเดือน'),
  ('benefit.read',             'benefit',     'read',   'ดูสิทธิประโยชน์'),
  ('benefit.write',            'benefit',     'write',  'จัดการสวัสดิการ/เบิกจ่าย'),
  ('benefit.approve',          'benefit',     'approve','อนุมัติการเบิกสวัสดิการ'),
  ('health.read',              'health',      'read',   'ดูผลตรวจสุขภาพ'),
  ('performance.read',         'performance', 'read',   'ดูผลประเมิน'),
  ('performance.write',        'performance', 'write',  'บันทึกผลประเมิน'),
  ('performance.approve',      'performance', 'approve','อนุมัติผลประเมิน'),
  ('training.read',            'training',    'read',   'ดูข้อมูลฝึกอบรม'),
  ('training.write',           'training',    'write',  'จัดการหลักสูตร/การอบรม'),
  ('career.read',              'career',      'read',   'ดูความก้าวหน้า/คำสั่ง'),
  ('career.write',             'career',      'write',  'จัดทำคำสั่งเลื่อน/ย้าย'),
  ('career.approve',           'career',      'approve','อนุมัติคำสั่งเลื่อน/ย้าย'),
  ('document.read',            'document',    'read',   'ดูเอกสาร'),
  ('document.write',           'document',    'write',  'ออกเอกสาร/หนังสือรับรอง'),
  ('discipline.read',          'discipline',  'read',   'ดูข้อมูลวินัย'),
  ('discipline.write',         'discipline',  'write',  'บันทึกเรื่องวินัย'),
  ('offboarding.read',         'offboarding', 'read',   'ดูข้อมูลการพ้นสภาพ'),
  ('offboarding.write',        'offboarding', 'write',  'จัดการการลาออก/เกษียณ'),
  ('offboarding.approve',      'offboarding', 'approve','อนุมัติการพ้นสภาพ'),
  ('report.read',              'report',      'read',   'ดูรายงาน'),
  ('report.export',            'report',      'export', 'ส่งออกรายงาน'),
  ('audit.read',               'audit',       'read',   'ดู Audit Log'),
  ('user.read',                'user',        'read',   'ดูผู้ใช้ระบบ'),
  ('user.manage',              'user',        'manage', 'จัดการผู้ใช้และสิทธิ')
on conflict (code) do update set name_th = excluded.name_th;

-- -----------------------------------------------------------------------------
-- 2. บทบาทมาตรฐานของระบบ (org_id = null)
-- -----------------------------------------------------------------------------
insert into roles (id, org_id, code, name_th, description, is_system) values
  ('11111111-0000-0000-0000-000000000001', null, 'SUPERADMIN',   'ผู้ดูแลระบบสูงสุด', 'เข้าถึงได้ทุกส่วน', true),
  ('11111111-0000-0000-0000-000000000002', null, 'HR_MANAGER',   'หัวหน้างานบุคคล',   'จัดการงานบุคคลทั้งหมด', true),
  ('11111111-0000-0000-0000-000000000003', null, 'HR_OFFICER',   'เจ้าหน้าที่บุคคล',  'ปฏิบัติงานบุคคลประจำวัน', true),
  ('11111111-0000-0000-0000-000000000004', null, 'PAYROLL',      'เจ้าหน้าที่การเงิน', 'ประมวลผลเงินเดือน', true),
  ('11111111-0000-0000-0000-000000000005', null, 'FACILITY_HEAD','ผู้อำนวยการสถานบริการ', 'ดูแล/อนุมัติในสถานบริการ', true),
  ('11111111-0000-0000-0000-000000000006', null, 'SUPERVISOR',   'หัวหน้างาน',        'อนุมัติลาและประเมินลูกน้อง', true),
  ('11111111-0000-0000-0000-000000000007', null, 'EMPLOYEE',     'บุคลากร',           'ใช้งาน self-service', true),
  ('11111111-0000-0000-0000-000000000008', null, 'AUDITOR',      'ผู้ตรวจสอบ',        'อ่านอย่างเดียว + audit log', true)
on conflict (id) do update set name_th = excluded.name_th;

-- สิทธิของแต่ละบทบาท
delete from role_permissions where role_id in (
  select id from roles where is_system and org_id is null);

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000001'::uuid, '*';

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000002'::uuid, code from permissions
 where code <> '*' and module not in ('system');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000003'::uuid, code from permissions
 where code in ('dashboard.read','org.read',
                'employee.read_all','employee.write','employee.read_facility',
                'recruitment.read','recruitment.write',
                'time.read','time.write','leave.read','leave.write','leave.manage',
                'benefit.read','benefit.write','performance.read',
                'training.read','training.write','career.read',
                'document.read','document.write','offboarding.read','offboarding.write',
                'report.read','report.export','user.read');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000004'::uuid, code from permissions
 where code in ('dashboard.read','employee.read_all','payroll.read','payroll.write',
                'payroll.calculate','benefit.read','benefit.write','time.read',
                'leave.read','report.read','report.export');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000005'::uuid, code from permissions
 where code in ('dashboard.read','org.read','employee.read_facility',
                'time.read','time.approve','leave.read','leave.approve',
                'performance.read','performance.write','performance.approve',
                'training.read','career.read','recruitment.read',
                'offboarding.read','offboarding.approve','report.read','report.export');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000006'::uuid, code from permissions
 where code in ('dashboard.read','employee.read','time.read','time.approve',
                'leave.read','leave.approve','performance.read','performance.write',
                'training.read','report.read');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000007'::uuid, code from permissions
 where code in ('dashboard.read','employee.read','time.read','leave.read','leave.write',
                'payroll.read','benefit.read','benefit.write','performance.read',
                'training.read','document.read','document.write');

insert into role_permissions (role_id, permission_code)
select '11111111-0000-0000-0000-000000000008'::uuid, code from permissions
 where action = 'read';

-- -----------------------------------------------------------------------------
-- 3. องค์กรตัวอย่าง
-- -----------------------------------------------------------------------------
insert into organizations (id, code, name_th, org_type, settings) values
  ('22222222-0000-0000-0000-000000000001',
   'CUP001', 'เครือข่ายบริการสุขภาพอำเภอตัวอย่าง', 'NETWORK',
   jsonb_build_object(
     'fiscal_year_start_month', 10,
     'timezone', 'Asia/Bangkok',
     'leave_period', 'FISCAL',
     'retirement_age', 60,
     'work_days_per_week', 5,
     'doc_prefix', jsonb_build_object('LEAVE','ลป.','ORDER','คส.','CERT','นร.')))
on conflict (id) do nothing;

insert into facilities (id, org_id, code, name_th, facility_type, geo) values
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',
   '10999','โรงพยาบาลชุมชนตัวอย่าง','HOSPITAL',
   jsonb_build_object('lat',13.7563,'lng',100.5018,'radius_m',300)),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001',
   '01234','รพ.สต. บ้านตัวอย่าง','HEALTH_CENTER',
   jsonb_build_object('lat',13.7600,'lng',100.5100,'radius_m',200))
on conflict (id) do nothing;

insert into departments (id, org_id, facility_id, code, name_th, dept_level, sort_order) values
  ('44444444-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001','ADM','กลุ่มงานบริหารทั่วไป','GROUP',1),
  ('44444444-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001','NUR','กลุ่มการพยาบาล','GROUP',2),
  ('44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001','MED','กลุ่มงานการแพทย์','GROUP',3),
  ('44444444-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000002','PCU','งานบริการปฐมภูมิ','DEPARTMENT',4),
  ('44444444-0000-0000-0000-000000000005','22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001','HRM','งานทรัพยากรบุคคล','DEPARTMENT',5)
on conflict (id) do nothing;

insert into job_grades (org_id, code, name_th, grade_level, min_salary, max_salary) values
  ('22222222-0000-0000-0000-000000000001','K1','ปฏิบัติงาน',        1,  8300,  24500),
  ('22222222-0000-0000-0000-000000000001','K2','ชำนาญงาน',          2, 13280,  38750),
  ('22222222-0000-0000-0000-000000000001','K3','อาวุโส',            3, 15410,  54820),
  ('22222222-0000-0000-0000-000000000001','P1','ปฏิบัติการ',        4, 15000,  34820),
  ('22222222-0000-0000-0000-000000000001','P2','ชำนาญการ',          5, 19860,  58390),
  ('22222222-0000-0000-0000-000000000001','P3','ชำนาญการพิเศษ',     6, 24400,  69040),
  ('22222222-0000-0000-0000-000000000001','P4','เชี่ยวชาญ',         7, 31400,  76800)
on conflict (org_id, code) do nothing;

insert into positions (org_id, code, name_th, job_family, employment_type, is_managerial) values
  ('22222222-0000-0000-0000-000000000001','DR','นายแพทย์','แพทย์','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','RN','พยาบาลวิชาชีพ','พยาบาล','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','PH','เภสัชกร','เภสัชกรรม','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','PHO','นักวิชาการสาธารณสุข','สาธารณสุข','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','DTO','เจ้าพนักงานทันตสาธารณสุข','ทันตกรรม','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','ADMO','เจ้าพนักงานธุรการ','บริหาร','GOV_EMPLOYEE',false),
  ('22222222-0000-0000-0000-000000000001','HRO','นักทรัพยากรบุคคล','บริหาร','CIVIL_SERVANT',false),
  ('22222222-0000-0000-0000-000000000001','DIR','ผู้อำนวยการ','บริหาร','CIVIL_SERVANT',true),
  ('22222222-0000-0000-0000-000000000001','HEAD','หัวหน้ากลุ่มงาน','บริหาร','CIVIL_SERVANT',true),
  ('22222222-0000-0000-0000-000000000001','GEN','พนักงานทั่วไป','สนับสนุน','TEMPORARY',false)
on conflict (org_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- 4. ประเภทการลาตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยการลาของข้าราชการ
-- -----------------------------------------------------------------------------
insert into leave_types (org_id, code, name_th, category, default_quota, allow_carry_over,
                         carry_over_max, require_attachment, attachment_after_days,
                         max_consecutive, min_service_months, deduct_salary_rate, color, sort_order) values
  ('22222222-0000-0000-0000-000000000001','SICK','ลาป่วย','SICK',60,false,null,true,3,null,0,0,'#b5433a',1),
  ('22222222-0000-0000-0000-000000000001','PERSONAL','ลากิจส่วนตัว','GENERAL',45,false,null,false,null,null,0,0,'#b8873a',2),
  ('22222222-0000-0000-0000-000000000001','VACATION','ลาพักผ่อน','VACATION',10,true,20,false,null,null,6,0,'#1f6b47',3),
  ('22222222-0000-0000-0000-000000000001','MATERNITY','ลาคลอดบุตร','MATERNITY',90,false,null,true,null,90,0,0,'#c2559b',4),
  ('22222222-0000-0000-0000-000000000001','PATERNITY','ลาไปช่วยเหลือภริยาที่คลอดบุตร','PATERNITY',15,false,null,true,null,15,0,0,'#2a5f8f',5),
  ('22222222-0000-0000-0000-000000000001','ORDINATION','ลาอุปสมบท/ประกอบพิธีฮัจย์','ORDINATION',120,false,null,true,null,120,144,0,'#8a6423',6),
  ('22222222-0000-0000-0000-000000000001','STUDY','ลาไปศึกษา/ฝึกอบรม','STUDY',null,false,null,true,null,null,12,0,'#0f8b8d',7),
  ('22222222-0000-0000-0000-000000000001','MILITARY','ลาเข้ารับการตรวจเลือกทหาร','MILITARY',null,false,null,true,null,null,0,0,'#4c5c51',8),
  ('22222222-0000-0000-0000-000000000001','REHAB','ลาไปฟื้นฟูสมรรถภาพด้านอาชีพ','SPECIAL',null,false,null,true,null,null,0,0,'#6b7a70',9),
  ('22222222-0000-0000-0000-000000000001','UNPAID','ลาโดยไม่ได้รับเงินเดือน','UNPAID',null,false,null,false,null,null,0,1,'#5b6b60',10)
on conflict (org_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- 5. กะการทำงาน
-- -----------------------------------------------------------------------------
insert into work_shifts (org_id, code, name_th, shift_type, start_time, end_time,
                         cross_midnight, break_minutes, work_minutes, late_grace_min, color) values
  ('22222222-0000-0000-0000-000000000001','OFFICE','เวลาราชการ (08:30-16:30)','FIXED','08:30','16:30',false,60,420,15,'#1f6b47'),
  ('22222222-0000-0000-0000-000000000001','M','เวรเช้า (08:00-16:00)','ROTATING','08:00','16:00',false,60,420,10,'#2b8a5c'),
  ('22222222-0000-0000-0000-000000000001','A','เวรบ่าย (16:00-24:00)','ROTATING','16:00','00:00',true,30,450,10,'#b8873a'),
  ('22222222-0000-0000-0000-000000000001','N','เวรดึก (00:00-08:00)','ROTATING','00:00','08:00',false,30,450,10,'#2a5f8f'),
  ('22222222-0000-0000-0000-000000000001','OFF','วันหยุด','OFF',null,null,false,0,0,0,'#dfe0d5')
on conflict (org_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- 6. รายการเงินได้ / เงินหัก
-- -----------------------------------------------------------------------------
insert into pay_components (org_id, code, name_th, component_type, category, calc_method,
                            default_amount, default_percent, is_taxable, is_sso_base, sort_order) values
  ('22222222-0000-0000-0000-000000000001','BASE','เงินเดือน','EARNING','BASE','FIXED',0,null,true,true,1),
  ('22222222-0000-0000-0000-000000000001','POS','เงินประจำตำแหน่ง','EARNING','POSITION_ALLOW','FIXED',0,null,true,false,2),
  ('22222222-0000-0000-0000-000000000001','PTS','เงิน พ.ต.ส.','EARNING','SPECIAL_ALLOW','FIXED',0,null,true,false,3),
  ('22222222-0000-0000-0000-000000000001','NOD','เงินไม่ทำเวชปฏิบัติส่วนตัว','EARNING','SPECIAL_ALLOW','FIXED',0,null,true,false,4),
  ('22222222-0000-0000-0000-000000000001','COLA','ค่าครองชีพชั่วคราว','EARNING','ALLOWANCE','FIXED',0,null,true,true,5),
  ('22222222-0000-0000-0000-000000000001','OT','ค่าล่วงเวลา','EARNING','OT','RATE_TIME',0,null,true,true,6),
  ('22222222-0000-0000-0000-000000000001','SHIFT','ค่าตอบแทนเวรนอกเวลา','EARNING','ALLOWANCE','MANUAL',0,null,true,false,7),
  ('22222222-0000-0000-0000-000000000001','TRAVEL','ค่าพาหนะ/เดินทาง','EARNING','ALLOWANCE','FIXED',0,null,false,false,8),
  ('22222222-0000-0000-0000-000000000001','BONUS','เงินรางวัลประจำปี','EARNING','BONUS','MANUAL',0,null,true,false,9),
  ('22222222-0000-0000-0000-000000000001','TAX','ภาษีเงินได้หัก ณ ที่จ่าย','DEDUCTION','TAX','FORMULA',0,null,false,false,20),
  ('22222222-0000-0000-0000-000000000001','SSO','ประกันสังคม (ลูกจ้าง)','DEDUCTION','SSO','PERCENT_BASE',0,5.0,false,false,21),
  ('22222222-0000-0000-0000-000000000001','GPF','กบข. (สมาชิกสะสม)','DEDUCTION','PVD','PERCENT_BASE',0,3.0,false,false,22),
  ('22222222-0000-0000-0000-000000000001','COOP','หักสหกรณ์ออมทรัพย์','DEDUCTION','LOAN','FIXED',0,null,false,false,23),
  ('22222222-0000-0000-0000-000000000001','LOAN','หักชำระเงินกู้สวัสดิการ','DEDUCTION','LOAN','FIXED',0,null,false,false,24),
  ('22222222-0000-0000-0000-000000000001','ABSENT','หักขาดงาน/ลาไม่รับเงินเดือน','DEDUCTION','ABSENCE','FORMULA',0,null,false,false,25),
  ('22222222-0000-0000-0000-000000000001','SSO_ER','ประกันสังคม (นายจ้าง)','EMPLOYER_COST','SSO','PERCENT_BASE',0,5.0,false,false,30),
  ('22222222-0000-0000-0000-000000000001','GPF_ER','กบข. (ส่วนราชการสมทบ)','EMPLOYER_COST','PVD','PERCENT_BASE',0,3.0,false,false,31)
on conflict (org_id, code) do nothing;

-- อัตราเงินสมทบ
insert into contribution_rates (org_id, fund_type, effective_from, employee_percent, employer_percent,
                                min_base, max_base, employee_cap, employer_cap, note) values
  ('22222222-0000-0000-0000-000000000001','SSO','2024-01-01',5.0,5.0,1650,15000,750,750,'อัตราปกติ 5% ฐานสูงสุด 15,000'),
  ('22222222-0000-0000-0000-000000000001','GPF','2024-01-01',3.0,3.0,null,null,null,null,'กบข. สะสม 3% สมทบ 3%')
on conflict do nothing;

-- ขั้นบันไดภาษีเงินได้บุคคลธรรมดา (ใช้ร่วมทุกองค์กร -> org_id = null)
insert into tax_brackets (org_id, tax_year, income_from, income_to, rate_percent, deduct_amount) values
  (null, 2025,        0,   150000,  0,      0),
  (null, 2025,   150000,   300000,  5,   7500),
  (null, 2025,   300000,   500000, 10,  22500),
  (null, 2025,   500000,   750000, 15,  47500),
  (null, 2025,   750000,  1000000, 20,  85000),
  (null, 2025,  1000000,  2000000, 25, 135000),
  (null, 2025,  2000000,  5000000, 30, 235000),
  (null, 2025,  5000000,     null, 35, 485000)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 7. แบบประเมิน + รอบประเมิน
-- -----------------------------------------------------------------------------
insert into appraisal_forms (id, org_id, code, name_th, section_weights) values
  ('55555555-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',
   'STD','แบบประเมินผลการปฏิบัติราชการ (มาตรฐาน)',
   '{"KPI":70,"COMPETENCY":30}'::jsonb)
on conflict (id) do nothing;

insert into appraisal_form_items (form_id, section, item_no, title, weight_percent, max_score) values
  ('55555555-0000-0000-0000-000000000001','KPI',1,'ผลสัมฤทธิ์ของงานตามตัวชี้วัดที่ตกลงไว้',60,5),
  ('55555555-0000-0000-0000-000000000001','KPI',2,'คุณภาพและความถูกต้องของงาน',20,5),
  ('55555555-0000-0000-0000-000000000001','KPI',3,'ความตรงต่อเวลาในการส่งมอบงาน',20,5),
  ('55555555-0000-0000-0000-000000000001','COMPETENCY',1,'การมุ่งผลสัมฤทธิ์',20,5),
  ('55555555-0000-0000-0000-000000000001','COMPETENCY',2,'บริการที่ดี',20,5),
  ('55555555-0000-0000-0000-000000000001','COMPETENCY',3,'การสั่งสมความเชี่ยวชาญในงานอาชีพ',20,5),
  ('55555555-0000-0000-0000-000000000001','COMPETENCY',4,'การยึดมั่นในความถูกต้องชอบธรรมและจริยธรรม',20,5),
  ('55555555-0000-0000-0000-000000000001','COMPETENCY',5,'การทำงานเป็นทีม',20,5)
on conflict (form_id, section, item_no) do nothing;

insert into competencies (org_id, code, name_th, competency_type, max_level) values
  ('22222222-0000-0000-0000-000000000001','C01','การมุ่งผลสัมฤทธิ์','CORE',5),
  ('22222222-0000-0000-0000-000000000001','C02','บริการที่ดี','CORE',5),
  ('22222222-0000-0000-0000-000000000001','C03','การสั่งสมความเชี่ยวชาญในงานอาชีพ','CORE',5),
  ('22222222-0000-0000-0000-000000000001','C04','การยึดมั่นในความถูกต้องชอบธรรมและจริยธรรม','CORE',5),
  ('22222222-0000-0000-0000-000000000001','C05','การทำงานเป็นทีม','CORE',5),
  ('22222222-0000-0000-0000-000000000001','M01','สภาวะผู้นำ','MANAGERIAL',5),
  ('22222222-0000-0000-0000-000000000001','M02','วิสัยทัศน์','MANAGERIAL',5),
  ('22222222-0000-0000-0000-000000000001','F01','การพยาบาลผู้ป่วยเฉพาะทาง','FUNCTIONAL',5),
  ('22222222-0000-0000-0000-000000000001','F02','การใช้ระบบสารสนเทศโรงพยาบาล','TECHNICAL',5)
on conflict (org_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- 8. Approval flow ของใบลา (2 ขั้น: หัวหน้างาน -> ผู้อำนวยการ)
-- -----------------------------------------------------------------------------
insert into approval_flows (id, org_id, code, name_th, entity_type, condition) values
  ('66666666-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',
   'LEAVE_STD','สายอนุมัติใบลา (ทั่วไป)','LEAVE_REQUEST','{"days_gte":0}'::jsonb),
  ('66666666-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001',
   'LEAVE_LONG','สายอนุมัติใบลา (เกิน 5 วัน)','LEAVE_REQUEST','{"days_gte":5}'::jsonb),
  ('66666666-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000001',
   'SEP_STD','สายอนุมัติการพ้นสภาพ','SEPARATION','{}'::jsonb),
  ('66666666-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000001',
   'DOC_STD','สายอนุมัติคำขอเอกสาร','DOC_REQUEST','{}'::jsonb)
on conflict (id) do nothing;

insert into approval_flow_steps (flow_id, step_no, name_th, approver_type, is_final, sla_hours) values
  ('66666666-0000-0000-0000-000000000001',1,'ผู้บังคับบัญชาชั้นต้น','SUPERVISOR',true,24),
  ('66666666-0000-0000-0000-000000000002',1,'ผู้บังคับบัญชาชั้นต้น','SUPERVISOR',false,24),
  ('66666666-0000-0000-0000-000000000002',2,'หัวหน้ากลุ่มงาน','DEPT_HEAD',false,24),
  ('66666666-0000-0000-0000-000000000002',3,'ผู้อำนวยการ','FACILITY_HEAD',true,48),
  ('66666666-0000-0000-0000-000000000003',1,'หัวหน้ากลุ่มงาน','DEPT_HEAD',false,48),
  ('66666666-0000-0000-0000-000000000003',2,'งานทรัพยากรบุคคล','HR',false,48),
  ('66666666-0000-0000-0000-000000000003',3,'ผู้อำนวยการ','FACILITY_HEAD',true,72),
  ('66666666-0000-0000-0000-000000000004',1,'งานทรัพยากรบุคคล','HR',true,24)
on conflict (flow_id, step_no) do nothing;

-- -----------------------------------------------------------------------------
-- 9. แม่แบบเอกสาร
-- -----------------------------------------------------------------------------
insert into document_templates (org_id, code, name_th, doc_type, engine, number_seq_key,
                                number_prefix, is_self_service, merge_fields) values
  ('22222222-0000-0000-0000-000000000001','CERT_EMP','หนังสือรับรองการทำงาน','EMPLOYMENT_CERT','HTML','CERT','นร.',true,
   '[{"key":"full_name","label":"ชื่อ-สกุล"},{"key":"position_name","label":"ตำแหน่ง"},
     {"key":"department_name","label":"สังกัด"},{"key":"hire_date","label":"วันเริ่มปฏิบัติงาน"},
     {"key":"purpose","label":"วัตถุประสงค์"}]'::jsonb),
  ('22222222-0000-0000-0000-000000000001','CERT_SAL','หนังสือรับรองเงินเดือน','SALARY_CERT','HTML','CERT','นร.',true,
   '[{"key":"full_name","label":"ชื่อ-สกุล"},{"key":"position_name","label":"ตำแหน่ง"},
     {"key":"base_salary","label":"เงินเดือน"},{"key":"purpose","label":"วัตถุประสงค์"}]'::jsonb),
  ('22222222-0000-0000-0000-000000000001','ORDER_LEAVE','คำสั่งอนุญาตให้ลา','ORDER','HTML','ORDER','คส.',false,
   '[{"key":"full_name","label":"ชื่อ-สกุล"},{"key":"leave_type","label":"ประเภทการลา"},
     {"key":"start_date","label":"ตั้งแต่วันที่"},{"key":"end_date","label":"ถึงวันที่"}]'::jsonb)
on conflict (org_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- 10. วันหยุดราชการตัวอย่าง
-- -----------------------------------------------------------------------------
insert into holidays (org_id, facility_id, holiday_date, name_th, holiday_type) values
  ('22222222-0000-0000-0000-000000000001',null,'2026-01-01','วันขึ้นปีใหม่','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-04-06','วันจักรี','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-04-13','วันสงกรานต์','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-04-14','วันสงกรานต์','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-04-15','วันสงกรานต์','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-05-01','วันแรงงานแห่งชาติ','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-07-28','วันเฉลิมพระชนมพรรษา ร.10','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-08-12','วันแม่แห่งชาติ','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-10-13','วันคล้ายวันสวรรคต ร.9','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-10-23','วันปิยมหาราช','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-12-05','วันพ่อแห่งชาติ','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-12-10','วันรัฐธรรมนูญ','PUBLIC'),
  ('22222222-0000-0000-0000-000000000001',null,'2026-12-31','วันสิ้นปี','PUBLIC')
on conflict (org_id, facility_id, holiday_date) do nothing;
