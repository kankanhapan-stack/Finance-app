-- =============================================================================
-- HRM :: 01_core.sql
-- Extensions, helper functions, tenancy (องค์กร/สถานบริการ/หน่วยงาน/ตำแหน่ง),
-- security (ผู้ใช้/บทบาท/สิทธิ), เลขที่เอกสาร, และเครื่องมือกลาง (approval engine)
--
-- หลักการ:
--   * ทุกตารางธุรกรรมมี org_id  -> รองรับหลายหน่วยงาน (multi-tenant)
--   * ตารางที่ผูกกับสถานบริการมี facility_id -> รองรับหลายสถานบริการ
--   * สถานะใช้ text + CHECK แทน enum เพื่อให้แก้ไข/เพิ่มค่าได้โดยไม่ต้อง migrate type
--   * ทุกตารางมี created_at/updated_at/created_by/updated_by สำหรับ audit
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists unaccent;
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- 1. Helper functions
-- -----------------------------------------------------------------------------

-- ผู้ใช้ปัจจุบัน: Apps Script จะ set ผ่าน header  Prefer: params=single-object
-- หรือผ่าน RPC fn_set_context() ก่อนทุก transaction
create or replace function fn_current_user_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;

create or replace function fn_current_org_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.current_org_id', true), '')::uuid;
$$;

create or replace function fn_set_context(p_user_id uuid, p_org_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('app.current_user_id', coalesce(p_user_id::text, ''), true);
  perform set_config('app.current_org_id',  coalesce(p_org_id::text, ''),  true);
end;
$$;

-- ปรับ updated_at / updated_by อัตโนมัติ
create or replace function fn_touch_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  begin
    new.updated_by := fn_current_user_id();
  exception when others then
    null; -- ตารางที่ไม่มีคอลัมน์ updated_by
  end;
  return new;
end;
$$;

-- แปลง พ.ศ. <-> ค.ศ. (ใช้บ่อยในรายงานราชการ)
create or replace function fn_to_be_year(p_date date)
returns int language sql immutable as $$ select extract(year from p_date)::int + 543 $$;

-- ปีงบประมาณไทย (1 ต.ค. - 30 ก.ย.)
create or replace function fn_fiscal_year(p_date date)
returns int language sql immutable as $$
  select case when extract(month from p_date) >= 10
              then extract(year from p_date)::int + 544
              else extract(year from p_date)::int + 543 end;
$$;

-- อายุงาน / อายุตัว แบบ ปี-เดือน-วัน
create or replace function fn_duration_ymd(p_from date, p_to date default current_date)
returns jsonb language sql immutable as $$
  select case when p_from is null or p_to is null or p_to < p_from then null
    else jsonb_build_object(
      'years',  extract(year  from age(p_to, p_from))::int,
      'months', extract(month from age(p_to, p_from))::int,
      'days',   extract(day   from age(p_to, p_from))::int,
      'text',   extract(year from age(p_to, p_from))::int || ' ปี '
             || extract(month from age(p_to, p_from))::int || ' เดือน '
             || extract(day  from age(p_to, p_from))::int || ' วัน')
  end;
$$;

-- ตรวจเลขประจำตัวประชาชน 13 หลัก
create or replace function fn_valid_thai_id(p_id text)
returns boolean language plpgsql immutable as $$
declare s int := 0; i int;
begin
  if p_id is null then return true; end if;
  if p_id !~ '^[0-9]{13}$' then return false; end if;
  for i in 1..12 loop
    s := s + (substr(p_id, i, 1))::int * (14 - i);
  end loop;
  return ((11 - (s % 11)) % 10) = (substr(p_id, 13, 1))::int;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tenancy : องค์กร -> สถานบริการ -> หน่วยงาน(ฝ่าย/กลุ่มงาน) -> ตำแหน่ง
-- -----------------------------------------------------------------------------

create table if not exists organizations (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name_th         text not null,
  name_en         text,
  org_type        text not null default 'PROVIDER'
                    check (org_type in ('MINISTRY','PROVINCE','DISTRICT','NETWORK','PROVIDER','COMPANY')),
  parent_id       uuid references organizations(id) on delete set null,
  tax_id          text,
  address         jsonb  not null default '{}'::jsonb,
  contact         jsonb  not null default '{}'::jsonb,
  settings        jsonb  not null default '{}'::jsonb,  -- นโยบายลา/เงินเดือน/รูปแบบเลขเอกสาร
  logo_url        text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid
);
comment on table organizations is 'หน่วยงานต้นสังกัด (รองรับโครงสร้างหลายชั้นผ่าน parent_id)';

create table if not exists facilities (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,                      -- รหัสสถานบริการ 5 หลัก (HOSPCODE)
  name_th         text not null,
  name_en         text,
  facility_type   text not null default 'HEALTH_CENTER'
                    check (facility_type in ('HOSPITAL','HEALTH_CENTER','CLINIC','OFFICE','BRANCH','OTHER')),
  bed_size        int,
  address         jsonb not null default '{}'::jsonb,
  geo             jsonb not null default '{}'::jsonb,  -- {lat, lng, radius_m} ใช้กับลงเวลา GPS
  contact         jsonb not null default '{}'::jsonb,
  head_employee_id uuid,                               -- FK เพิ่มภายหลัง (employees)
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  unique (org_id, code)
);
comment on table facilities is 'สถานบริการ/สาขา ภายใต้องค์กร';

create table if not exists departments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  parent_id       uuid references departments(id) on delete set null,
  code            text not null,
  name_th         text not null,
  name_en         text,
  dept_level      text not null default 'DEPARTMENT'
                    check (dept_level in ('GROUP','DIVISION','DEPARTMENT','SECTION','TEAM')),
  cost_center     text,
  head_employee_id uuid,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  unique (org_id, code)
);
comment on table departments is 'โครงสร้างหน่วยงานภายใน แบบ tree (parent_id)';

-- ระดับ/ชั้นงาน เช่น ปฏิบัติงาน/ชำนาญงาน/ชำนาญการ/ชำนาญการพิเศษ
create table if not exists job_grades (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  grade_level     int  not null default 0,      -- ใช้เรียงลำดับความก้าวหน้า
  min_salary      numeric(12,2),
  max_salary      numeric(12,2),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid,
  unique (org_id, code)
);

-- ตำแหน่ง (Job/Position master) - "กรอบอัตรากำลัง"
create table if not exists positions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  name_en         text,
  job_family      text,                          -- สายงาน เช่น พยาบาล/สาธารณสุข/บริหาร
  job_grade_id    uuid references job_grades(id) on delete set null,
  employment_type text not null default 'CIVIL_SERVANT'
                    check (employment_type in ('CIVIL_SERVANT','GOV_EMPLOYEE','PERMANENT_EMP',
                                               'TEMPORARY','CONTRACT','DAILY','OUTSOURCE','VOLUNTEER')),
  is_managerial   boolean not null default false,
  job_description text,
  required_competencies jsonb not null default '[]'::jsonb,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid,
  unique (org_id, code)
);
comment on table positions is 'ตำแหน่งงานมาตรฐานขององค์กร (แม่แบบของการบรรจุ/แต่งตั้ง)';

-- กรอบอัตรากำลังรายหน่วยงาน (headcount plan) : ใช้คำนวณอัตราว่าง
create table if not exists position_slots (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete cascade,
  department_id   uuid references departments(id) on delete set null,
  position_id     uuid not null references positions(id) on delete cascade,
  fiscal_year     int  not null,
  planned_count   int  not null default 1 check (planned_count >= 0),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid,
  unique (org_id, facility_id, department_id, position_id, fiscal_year)
);
comment on table position_slots is 'กรอบอัตรากำลังตามปีงบประมาณ (planned) เทียบกับผู้ครองตำแหน่งจริง (actual)';

create index if not exists idx_facilities_org      on facilities(org_id) where is_active;
create index if not exists idx_departments_org     on departments(org_id) where is_active;
create index if not exists idx_departments_parent  on departments(parent_id);
create index if not exists idx_positions_org       on positions(org_id) where is_active;
create index if not exists idx_slots_org_fy        on position_slots(org_id, fiscal_year);

-- -----------------------------------------------------------------------------
-- 3. Security : ผู้ใช้ / บทบาท / สิทธิ (RBAC + scope)
-- -----------------------------------------------------------------------------

create table if not exists app_users (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organizations(id) on delete cascade,
  auth_uid        uuid,                     -- map กับ auth.users ของ Supabase (เมื่อเปิดใช้ online)
  email           text not null,
  google_email    text,                     -- ใช้กับ Apps Script (Session.getActiveUser)
  display_name    text not null,
  employee_id     uuid,                     -- FK เพิ่มภายหลัง
  status          text not null default 'ACTIVE'
                    check (status in ('ACTIVE','SUSPENDED','LOCKED','DISABLED')),
  is_superadmin   boolean not null default false,
  last_login_at   timestamptz,
  login_fail_count int not null default 0,
  preferences     jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid
);
create unique index if not exists uq_app_users_email on app_users (lower(email));
create index if not exists idx_app_users_google on app_users (lower(google_email));

create table if not exists roles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organizations(id) on delete cascade, -- null = role ระบบ
  code            text not null,
  name_th         text not null,
  description     text,
  is_system       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid
);
create unique index if not exists uq_roles_scope on roles (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- สิทธิย่อยแบบ  <module>.<action>  เช่น employee.read, payroll.approve
create table if not exists permissions (
  code            text primary key,
  module          text not null,
  action          text not null,
  name_th         text not null,
  description     text
);

create table if not exists role_permissions (
  role_id         uuid not null references roles(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

-- การให้สิทธิผู้ใช้ พร้อม scope (ทั้งองค์กร / เฉพาะสถานบริการ / เฉพาะฝ่าย)
create table if not exists user_roles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_users(id) on delete cascade,
  role_id         uuid not null references roles(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete cascade,
  department_id   uuid references departments(id) on delete cascade,
  effective_from  date not null default current_date,
  effective_to    date,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  unique (user_id, role_id, org_id, facility_id, department_id)
);
create index if not exists idx_user_roles_user on user_roles(user_id);

-- session สำหรับ Apps Script Web App (stateless token เก็บฝั่ง DB)
create table if not exists user_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_users(id) on delete cascade,
  token_hash      text not null unique,
  org_id          uuid references organizations(id) on delete set null,
  facility_id     uuid references facilities(id) on delete set null,
  ip              text,
  user_agent      text,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz
);
create index if not exists idx_sessions_user on user_sessions(user_id, expires_at desc);

-- รวมสิทธิทั้งหมดของผู้ใช้ (ใช้โดย Apps Script ตอน login)
create or replace view v_user_permissions as
select ur.user_id,
       ur.org_id,
       ur.facility_id,
       ur.department_id,
       rp.permission_code,
       r.code as role_code
from user_roles ur
join roles r            on r.id = ur.role_id
join role_permissions rp on rp.role_id = r.id
where ur.effective_from <= current_date
  and (ur.effective_to is null or ur.effective_to >= current_date);

-- -----------------------------------------------------------------------------
-- 4. เลขที่เอกสารอัตโนมัติ
-- -----------------------------------------------------------------------------

create table if not exists number_sequences (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  seq_key         text not null,            -- 'LEAVE','ORDER','CERT','PAYROLL','APPLICANT'
  period_key      text not null default '', -- '' | '2568' | '256810'
  prefix          text not null default '',
  pad_length      int  not null default 4,
  current_no      bigint not null default 0,
  unique (org_id, seq_key, period_key)
);

create or replace function fn_next_document_no(
  p_org_id uuid, p_seq_key text, p_prefix text default '',
  p_period_key text default '', p_pad int default 4)
returns text
language plpgsql
as $$
declare v_no bigint;
begin
  insert into number_sequences(org_id, seq_key, period_key, prefix, pad_length, current_no)
  values (p_org_id, p_seq_key, coalesce(p_period_key,''), p_prefix, p_pad, 1)
  on conflict (org_id, seq_key, period_key)
  do update set current_no = number_sequences.current_no + 1
  returning current_no into v_no;

  return coalesce(nullif(p_prefix,''), '') ||
         case when coalesce(p_period_key,'') <> '' then p_period_key || '-' else '' end ||
         lpad(v_no::text, p_pad, '0');
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Approval engine (ใช้ร่วมกันทุกโมดูล: ลา, สมัครงาน, เอกสาร, ลาออก ฯลฯ)
-- -----------------------------------------------------------------------------

create table if not exists approval_flows (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  entity_type     text not null,   -- 'LEAVE_REQUEST','SEPARATION','DOC_REQUEST','PAYROLL_RUN'...
  condition       jsonb not null default '{}'::jsonb, -- เงื่อนไขเลือก flow เช่น {"days_gte":5}
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid,
  unique (org_id, code)
);

create table if not exists approval_flow_steps (
  id              uuid primary key default gen_random_uuid(),
  flow_id         uuid not null references approval_flows(id) on delete cascade,
  step_no         int  not null,
  name_th         text not null,
  approver_type   text not null
                    check (approver_type in ('SUPERVISOR','DEPT_HEAD','FACILITY_HEAD','ROLE','USER','HR')),
  approver_role_id uuid references roles(id) on delete set null,
  approver_user_id uuid references app_users(id) on delete set null,
  is_final        boolean not null default false,
  allow_delegate  boolean not null default true,
  sla_hours       int,
  unique (flow_id, step_no)
);

create table if not exists approval_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  flow_id         uuid references approval_flows(id) on delete set null,
  entity_type     text not null,
  entity_id       uuid not null,
  current_step    int  not null default 1,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','APPROVED','REJECTED','CANCELLED','RETURNED')),
  requested_by    uuid references app_users(id) on delete set null,
  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,
  summary         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid, updated_by uuid
);
create index if not exists idx_appr_entity on approval_requests(entity_type, entity_id);
create index if not exists idx_appr_pending on approval_requests(org_id, status) where status = 'PENDING';

create table if not exists approval_actions (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references approval_requests(id) on delete cascade,
  step_no         int  not null,
  actor_user_id   uuid references app_users(id) on delete set null,
  action          text not null check (action in ('APPROVE','REJECT','RETURN','DELEGATE','CANCEL','COMMENT')),
  comment         text,
  acted_at        timestamptz not null default now(),
  attachment_url  text
);
create index if not exists idx_appr_actions_req on approval_actions(request_id, step_no);

-- -----------------------------------------------------------------------------
-- 6. แจ้งเตือน (ใช้ร่วมกับ Apps Script MailApp / LINE Notify)
-- -----------------------------------------------------------------------------

create table if not exists notifications (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  user_id         uuid references app_users(id) on delete cascade,
  employee_id     uuid,
  channel         text not null default 'INAPP' check (channel in ('INAPP','EMAIL','LINE','SMS')),
  title           text not null,
  body            text,
  link_url        text,
  entity_type     text,
  entity_id       uuid,
  status          text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED','READ')),
  scheduled_at    timestamptz not null default now(),
  sent_at         timestamptz,
  error_message   text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_notify_queue on notifications(status, scheduled_at) where status = 'PENDING';
create index if not exists idx_notify_user on notifications(user_id, created_at desc);
