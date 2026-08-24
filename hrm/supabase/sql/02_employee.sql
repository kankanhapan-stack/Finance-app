-- =============================================================================
-- HRM :: 02_employee.sql
-- ทะเบียนประวัติบุคลากร + ประวัติการดำรงตำแหน่ง (effective-dated)
--
-- แนวคิดสำคัญ: "ข้อมูลบุคลากรครั้งเดียว ใช้ได้ทุกกระบวนงาน"
--   employees                = ข้อมูลตัวบุคคล (คงที่ตลอดชีพการทำงาน)
--   employment_assignments   = ตำแหน่ง/สังกัด ณ ช่วงเวลาหนึ่ง (มีหลายแถว = ประวัติ)
--   employment_events        = เหตุการณ์ทางบุคคล (บรรจุ/เลื่อน/ย้าย/ลาออก/เกษียณ)
-- =============================================================================

create table if not exists employees (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  emp_code          text not null,                       -- รหัสพนักงาน
  national_id       text,                                -- เลขบัตรประชาชน
  passport_no       text,

  -- ชื่อ-สกุล
  title_th          text,
  first_name_th     text not null,
  middle_name_th    text,
  last_name_th      text not null,
  title_en          text,
  first_name_en     text,
  last_name_en      text,
  nickname          text,
  former_name       text,                                -- ชื่อ-สกุลเดิม (กรณีเปลี่ยน)

  -- ข้อมูลส่วนบุคคล
  gender            text check (gender in ('M','F','OTHER')),
  birth_date        date,
  birth_province    text,
  nationality       text default 'ไทย',
  ethnicity         text default 'ไทย',
  religion          text,
  marital_status    text check (marital_status in ('SINGLE','MARRIED','DIVORCED','WIDOWED','SEPARATED')),
  blood_type        text check (blood_type in ('A','B','AB','O')),
  height_cm         numeric(5,1),
  weight_kg         numeric(5,1),
  military_status   text check (military_status in ('EXEMPTED','COMPLETED','PENDING','NA')),

  -- ติดต่อ
  phone             text,
  phone_emergency   text,
  email             text,
  email_work        text,
  line_id           text,
  address_current   jsonb not null default '{}'::jsonb,  -- {no,moo,road,tambon,amphoe,province,zipcode}
  address_register  jsonb not null default '{}'::jsonb,

  -- สถานะการจ้าง (สรุปล่าสุด - denormalize เพื่อความเร็วในการค้นหา)
  employment_status text not null default 'ACTIVE'
                      check (employment_status in ('PROBATION','ACTIVE','ON_LEAVE','SUSPENDED',
                                                   'TRANSFERRED_OUT','RESIGNED','RETIRED','TERMINATED','DECEASED')),
  hire_date         date,                                -- วันเริ่มงาน/บรรจุ
  probation_end_date date,
  gov_service_date  date,                                -- วันเริ่มรับราชการ (ใช้คำนวณบำเหน็จบำนาญ)
  separation_date   date,
  -- เกษียณ = 30 ก.ย. ของปีงบประมาณที่อายุครบ 60 ปี
  -- (คนเกิด ต.ค.-ธ.ค. อายุครบ 60 ในปีงบประมาณถัดไป จึงบวกอีก 1 ปี)
  retirement_date   date generated always as (
                      case when birth_date is null then null else
                        make_date(
                          extract(year from (birth_date + interval '60 years'))::int
                            + case when extract(month from birth_date) >= 10 then 1 else 0 end,
                          9, 30)
                      end
                    ) stored,

  -- อื่น ๆ
  photo_url         text,
  signature_url     text,
  bank_account      jsonb not null default '{}'::jsonb,  -- {bank_code,bank_name,account_no,account_name}
  tax_id            text,
  sso_no            text,                                -- เลขประกันสังคม
  pvd_member_no     text,                                -- กองทุนสำรองเลี้ยงชีพ/กบข.
  note              text,
  extra             jsonb not null default '{}'::jsonb,  -- ฟิลด์เพิ่มเฉพาะองค์กร

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid, updated_by uuid,

  unique (org_id, emp_code),
  constraint ck_emp_national_id check (fn_valid_thai_id(national_id))
);
comment on table employees is 'ทะเบียนประวัติบุคลากร - แหล่งข้อมูลกลางของทุกโมดูล';

create unique index if not exists uq_employees_nid on employees(org_id, national_id) where national_id is not null;
create index if not exists idx_employees_status on employees(org_id, employment_status);
create index if not exists idx_employees_name on employees(org_id, last_name_th, first_name_th);
create index if not exists idx_employees_search on employees
  using gin (to_tsvector('simple', coalesce(emp_code,'') || ' ' || first_name_th || ' ' || last_name_th));

-- ชื่อเต็มสำหรับแสดงผล
create or replace function fn_employee_fullname(p employees)
returns text language sql immutable as $$
  select case when p.id is null then null
         else trim(coalesce(p.title_th,'') || coalesce(p.first_name_th,'')
                   || ' ' || coalesce(p.last_name_th,'')) end;
$$;

-- -----------------------------------------------------------------------------
-- ประวัติการดำรงตำแหน่ง (หัวใจของการรองรับหลายหน่วยงาน/หลายสถานบริการ)
-- -----------------------------------------------------------------------------

create table if not exists employment_assignments (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  employee_id       uuid not null references employees(id) on delete cascade,
  facility_id       uuid references facilities(id) on delete set null,
  department_id     uuid references departments(id) on delete set null,
  position_id       uuid references positions(id) on delete set null,
  job_grade_id      uuid references job_grades(id) on delete set null,
  supervisor_id     uuid references employees(id) on delete set null,

  employment_type   text not null default 'CIVIL_SERVANT'
                      check (employment_type in ('CIVIL_SERVANT','GOV_EMPLOYEE','PERMANENT_EMP',
                                                 'TEMPORARY','CONTRACT','DAILY','OUTSOURCE','VOLUNTEER')),
  assignment_type   text not null default 'PRIMARY'
                      check (assignment_type in ('PRIMARY','SECONDARY','ACTING','SECONDMENT')),
  position_no       text,                               -- เลขที่ตำแหน่ง
  effective_from    date not null,
  effective_to      date,
  reason            text,                               -- บรรจุ/เลื่อน/ย้าย/รักษาการ
  order_no          text,                               -- เลขที่คำสั่ง
  order_date        date,
  base_salary       numeric(12,2),
  work_shift_id     uuid,                               -- FK เพิ่มใน 04_time
  is_current        boolean generated always as (effective_to is null) stored,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid, updated_by uuid,

  constraint ck_assign_period check (effective_to is null or effective_to >= effective_from)
);
comment on table employment_assignments is 'ตำแหน่ง/สังกัด/ผู้บังคับบัญชา ตามช่วงเวลา - ค้นย้อนหลังได้';

-- ห้ามซ้อนทับช่วงเวลาสำหรับ assignment ประเภท PRIMARY
create unique index if not exists uq_assign_current_primary
  on employment_assignments(employee_id)
  where effective_to is null and assignment_type = 'PRIMARY';
create index if not exists idx_assign_emp on employment_assignments(employee_id, effective_from desc);
create index if not exists idx_assign_facility on employment_assignments(facility_id) where effective_to is null;
create index if not exists idx_assign_dept on employment_assignments(department_id) where effective_to is null;

-- เหตุการณ์ทางบุคคล (timeline) - ใช้สร้าง ก.พ.7 / ประวัติรับราชการ
create table if not exists employment_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  employee_id       uuid not null references employees(id) on delete cascade,
  event_type        text not null
                      check (event_type in ('HIRE','PROBATION_PASS','PROMOTION','TRANSFER','SALARY_ADJUST',
                                            'GRADE_CHANGE','ACTING','SECONDMENT','SUSPEND','RETURN',
                                            'DISCIPLINE','AWARD','TRAINING','NAME_CHANGE',
                                            'RESIGN','RETIRE','TERMINATE','DECEASE')),
  event_date        date not null,
  title             text not null,
  detail            text,
  order_no          text,
  order_date        date,
  from_value        jsonb not null default '{}'::jsonb,
  to_value          jsonb not null default '{}'::jsonb,
  attachment_url    text,
  source_table      text,          -- ตารางต้นทางที่ทำให้เกิด event
  source_id         uuid,
  created_at        timestamptz not null default now(),
  created_by        uuid
);
create index if not exists idx_emp_events on employment_events(employee_id, event_date desc);

-- -----------------------------------------------------------------------------
-- ข้อมูลประกอบประวัติ
-- -----------------------------------------------------------------------------

create table if not exists employee_educations (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  level           text not null check (level in ('PRIMARY','SECONDARY','VOCATIONAL','DIPLOMA',
                                                 'BACHELOR','MASTER','DOCTORATE','CERTIFICATE','OTHER')),
  degree_name     text,
  major           text,
  institute       text,
  country         text default 'ไทย',
  start_year      int,
  graduate_year   int,
  gpa             numeric(4,2),
  is_highest      boolean not null default false,
  attachment_url  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_edu_emp on employee_educations(employee_id);

create table if not exists employee_licenses (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  license_type    text not null,        -- ใบประกอบวิชาชีพพยาบาล/เวชกรรม/เภสัช ฯลฯ
  license_no      text not null,
  issuer          text,
  issue_date      date,
  expire_date     date,
  status          text not null default 'VALID' check (status in ('VALID','EXPIRED','SUSPENDED','REVOKED')),
  attachment_url  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_lic_expire on employee_licenses(expire_date) where status = 'VALID';

create table if not exists employee_families (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  relation        text not null check (relation in ('FATHER','MOTHER','SPOUSE','CHILD','SIBLING','GUARDIAN','OTHER')),
  full_name       text not null,
  national_id     text,
  birth_date      date,
  occupation      text,
  phone           text,
  is_alive        boolean not null default true,
  is_dependent    boolean not null default false,   -- ใช้สิทธิเบิกจ่ายตรง/ลดหย่อนภาษี
  is_beneficiary  boolean not null default false,   -- ผู้รับผลประโยชน์
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_fam_emp on employee_families(employee_id);

create table if not exists employee_experiences (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  organization    text not null,
  position_name   text,
  start_date      date,
  end_date        date,
  salary          numeric(12,2),
  duty            text,
  leave_reason    text,
  is_internal     boolean not null default false,   -- ประสบการณ์ภายในองค์กรเดียวกัน
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);

create table if not exists employee_contacts (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  contact_type    text not null default 'EMERGENCY' check (contact_type in ('EMERGENCY','REFERENCE','GUARANTOR')),
  full_name       text not null,
  relation        text,
  phone           text,
  address         text,
  created_at      timestamptz not null default now(),
  created_by uuid
);

-- แฟ้มเอกสารบุคลากร (ไฟล์เก็บใน Supabase Storage หรือ Google Drive)
create table if not exists employee_files (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  category        text not null default 'OTHER'
                    check (category in ('ID_CARD','HOUSE_REG','EDUCATION','LICENSE','CONTRACT','ORDER',
                                        'MEDICAL','PHOTO','RESUME','EVALUATION','DISCIPLINE','OTHER')),
  file_name       text not null,
  storage_provider text not null default 'SUPABASE' check (storage_provider in ('SUPABASE','DRIVE','URL')),
  storage_path    text not null,     -- bucket/path หรือ Drive fileId
  mime_type       text,
  size_bytes      bigint,
  is_confidential boolean not null default false,
  expire_date     date,
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid,
  created_at      timestamptz not null default now()
);
create index if not exists idx_files_emp on employee_files(employee_id, category);

-- -----------------------------------------------------------------------------
-- FK ที่ต้องรอให้ employees ถูกสร้างก่อน
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_facilities_head') then
    alter table facilities add constraint fk_facilities_head
      foreign key (head_employee_id) references employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_departments_head') then
    alter table departments add constraint fk_departments_head
      foreign key (head_employee_id) references employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_app_users_employee') then
    alter table app_users add constraint fk_app_users_employee
      foreign key (employee_id) references employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_notifications_employee') then
    alter table notifications add constraint fk_notifications_employee
      foreign key (employee_id) references employees(id) on delete cascade;
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- View : ข้อมูลบุคลากรปัจจุบัน (ใช้เกือบทุกหน้าจอ/รายงาน)
-- -----------------------------------------------------------------------------
create or replace view v_employee_current as
select
  e.id                                as employee_id,
  e.org_id,
  e.emp_code,
  fn_employee_fullname(e.*)           as full_name_th,
  e.first_name_th, e.last_name_th, e.title_th,
  e.national_id, e.gender, e.birth_date,
  e.phone, e.email, e.email_work, e.photo_url,
  e.employment_status,
  e.hire_date, e.gov_service_date, e.separation_date, e.retirement_date,
  (fn_duration_ymd(e.hire_date))->>'text'      as service_length_text,
  extract(year from age(current_date, e.birth_date))::int as age_years,
  a.id                                as assignment_id,
  a.facility_id, f.code as facility_code, f.name_th as facility_name,
  a.department_id, d.code as department_code, d.name_th as department_name,
  a.position_id,  p.code as position_code,  p.name_th as position_name,
  p.job_family,
  a.job_grade_id, g.code as grade_code, g.name_th as grade_name, g.grade_level,
  a.employment_type,
  a.position_no,
  a.base_salary,
  a.supervisor_id,
  sup.emp_code                        as supervisor_code,
  fn_employee_fullname(sup.*)         as supervisor_name,
  a.effective_from                    as assignment_from,
  a.work_shift_id
from employees e
left join employment_assignments a
       on a.employee_id = e.id and a.effective_to is null and a.assignment_type = 'PRIMARY'
left join facilities   f on f.id = a.facility_id
left join departments  d on d.id = a.department_id
left join positions    p on p.id = a.position_id
left join job_grades   g on g.id = a.job_grade_id
left join employees  sup on sup.id = a.supervisor_id;

comment on view v_employee_current is 'มุมมองบุคลากรพร้อมสังกัด/ตำแหน่งปัจจุบัน - ใช้เป็น base ของทุกรายงาน';
