-- =============================================================================
-- HRM :: 10_document_discipline_offboarding.sql
-- โมดูล 12 Document (เอกสาร/หนังสือรับรอง) + 13 Discipline (วินัย/คำสั่ง)
--          + 14 Offboarding (ลาออก/เกษียณ/พ้นสภาพ)
-- =============================================================================

-- ---------------------------------------------------------------- Document
create table if not exists document_templates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  doc_type        text not null default 'CERTIFICATE'
                    check (doc_type in ('CERTIFICATE','SALARY_CERT','EMPLOYMENT_CERT','ORDER',
                                        'CONTRACT','MEMO','LETTER','FORM','ID_CARD','OTHER')),
  engine          text not null default 'GDOC' check (engine in ('GDOC','HTML','SHEET')),
  template_ref    text,                -- Google Docs fileId หรือชื่อไฟล์ HTML ใน Apps Script
  body_html       text,                -- กรณี engine = HTML
  merge_fields    jsonb not null default '[]'::jsonb,  -- [{key,label,source}]
  number_seq_key  text default 'CERT',
  number_prefix   text default '',
  requires_approval boolean not null default true,
  signer_position text,
  is_self_service boolean not null default false,      -- บุคลากรขอเองได้
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- คำขอเอกสาร (self-service)
create table if not exists document_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  template_id     uuid not null references document_templates(id) on delete restrict,
  request_no      text,
  purpose         text not null,
  language        text not null default 'TH' check (language in ('TH','EN')),
  copies          int not null default 1,
  parameters      jsonb not null default '{}'::jsonb,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','APPROVED','ISSUED','REJECTED','CANCELLED')),
  approval_request_id uuid references approval_requests(id) on delete set null,
  approved_by     uuid references app_users(id) on delete set null,
  approved_at     timestamptz,
  reject_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_docreq_emp on document_requests(employee_id, created_at desc);

-- เอกสารที่ออกแล้ว (ทะเบียนหนังสือ)
create table if not exists issued_documents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  employee_id     uuid references employees(id) on delete set null,
  template_id     uuid references document_templates(id) on delete set null,
  request_id      uuid references document_requests(id) on delete set null,
  document_no     text not null,
  doc_type        text not null,
  title           text not null,
  issue_date      date not null default current_date,
  effective_date  date,
  expire_date     date,
  content_snapshot jsonb not null default '{}'::jsonb,   -- ค่าที่ merge ลงเอกสาร ณ เวลาออก
  file_url        text,
  file_provider   text default 'DRIVE' check (file_provider in ('DRIVE','SUPABASE','URL')),
  signed_by       uuid references employees(id) on delete set null,
  signed_at       timestamptz,
  verify_code     text unique,                            -- ใช้ตรวจสอบเอกสารออนไลน์ (QR)
  status          text not null default 'ISSUED'
                    check (status in ('ISSUED','SIGNED','DELIVERED','REVOKED','EXPIRED')),
  revoke_reason   text,
  download_count  int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, document_no)
);
create index if not exists idx_issued_emp on issued_documents(employee_id, issue_date desc);

-- ---------------------------------------------------------------- Discipline
create table if not exists discipline_cases (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  employee_id     uuid not null references employees(id) on delete cascade,
  case_no         text,
  case_type       text not null default 'MINOR'
                    check (case_type in ('MINOR','SERIOUS','CRIMINAL','ETHICS','ATTENDANCE','PERFORMANCE')),
  offense_category text,                -- ประเภทความผิด เช่น ขาดงาน, ทุจริต
  incident_date   date,
  reported_date   date not null default current_date,
  reported_by     uuid references employees(id) on delete set null,
  description     text not null,
  evidence        jsonb not null default '[]'::jsonb,
  investigator_ids uuid[] not null default '{}',
  investigation_start date,
  investigation_end   date,
  finding         text,
  status          text not null default 'REPORTED'
                    check (status in ('REPORTED','INVESTIGATING','HEARING','DECIDED',
                                      'APPEALED','CLOSED','DISMISSED')),
  is_confidential boolean not null default true,
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_disc_emp on discipline_cases(employee_id, reported_date desc);

create table if not exists discipline_actions (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references discipline_cases(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  action_type     text not null
                    check (action_type in ('VERBAL_WARNING','WRITTEN_WARNING','PROBATION','SALARY_CUT',
                                           'SUSPENSION','DEMOTION','TRANSFER','DISMISSAL','EXPULSION','NONE')),
  action_date     date not null default current_date,
  effective_from  date,
  effective_to    date,
  penalty_amount  numeric(14,2),
  penalty_percent numeric(6,3),
  suspend_days    int,
  order_no        text,
  order_date      date,
  order_url       text,
  decided_by      uuid references employees(id) on delete set null,
  acknowledged_at timestamptz,
  appeal_deadline date,
  is_expunged     boolean not null default false,   -- ล้างประวัติแล้ว
  expunged_date   date,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_discact_emp on discipline_actions(employee_id, action_date desc);

-- ทะเบียนคำสั่งกลาง (คำสั่งบุคคลทุกประเภท)
create table if not exists personnel_orders (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  order_no        text not null,
  order_date      date not null default current_date,
  order_type      text not null
                    check (order_type in ('APPOINT','PROMOTE','TRANSFER','ASSIGN','ACTING','SALARY',
                                          'DISCIPLINE','LEAVE','TRAINING','RESIGN','RETIRE','OTHER')),
  subject         text not null,
  detail          text,
  effective_date  date,
  employee_ids    uuid[] not null default '{}',
  reference_table text,
  reference_id    uuid,
  signed_by       uuid references employees(id) on delete set null,
  file_url        text,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','SIGNED','ANNOUNCED','CANCELLED')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, order_no)
);
create index if not exists idx_order_date on personnel_orders(org_id, order_date desc);

-- ---------------------------------------------------------------- Offboarding
create table if not exists separation_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  request_no      text,
  separation_type text not null
                    check (separation_type in ('RESIGN','RETIRE','EARLY_RETIRE','CONTRACT_END',
                                               'TRANSFER_OUT','TERMINATE','DISMISS','DECEASE','OTHER')),
  requested_date  date not null default current_date,
  last_working_date date not null,
  effective_date  date not null,           -- วันพ้นสภาพ
  reason_category text,
  reason_detail   text,
  new_employer    text,
  is_rehirable    boolean not null default true,
  notice_days     int,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','PENDING','APPROVED','REJECTED','COMPLETED','CANCELLED','WITHDRAWN')),
  approval_request_id uuid references approval_requests(id) on delete set null,
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  reject_reason   text,
  document_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_sep_dates check (effective_date >= last_working_date)
);
create index if not exists idx_sep_emp on separation_requests(employee_id, effective_date desc);
create index if not exists idx_sep_status on separation_requests(org_id, status);

-- รายการส่งคืน/เคลียร์ก่อนพ้นสภาพ
create table if not exists clearance_items (
  id              uuid primary key default gen_random_uuid(),
  separation_id   uuid not null references separation_requests(id) on delete cascade,
  category        text not null default 'ASSET'
                    check (category in ('ASSET','IT','FINANCE','DOCUMENT','KEY','UNIFORM','ACCESS','OTHER')),
  item_name       text not null,
  responsible_dept_id uuid references departments(id) on delete set null,
  responsible_user_id uuid references app_users(id) on delete set null,
  amount          numeric(14,2),
  status          text not null default 'PENDING'
                    check (status in ('PENDING','CLEARED','OUTSTANDING','WAIVED')),
  cleared_at      timestamptz,
  cleared_by      uuid references app_users(id) on delete set null,
  note            text,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_clear_sep on clearance_items(separation_id, status);

create table if not exists exit_interviews (
  id              uuid primary key default gen_random_uuid(),
  separation_id   uuid not null references separation_requests(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  interview_date  date,
  interviewer_id  uuid references employees(id) on delete set null,
  primary_reason  text,
  satisfaction_scores jsonb not null default '{}'::jsonb,  -- {work:4,supervisor:3,welfare:5}
  would_recommend boolean,
  would_return    boolean,
  feedback        text,
  suggestions     text,
  is_confidential boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (separation_id)
);

-- -----------------------------------------------------------------------------
-- RPC : ดำเนินการพ้นสภาพ (ปิด assignment, ปรับสถานะ, บันทึก timeline)
-- -----------------------------------------------------------------------------
create or replace function fn_complete_separation(p_separation_id uuid)
returns employees
language plpgsql
as $$
declare
  v_sep  separation_requests%rowtype;
  v_emp  employees%rowtype;
  v_status text;
  v_outstanding int;
begin
  select * into v_sep from separation_requests where id = p_separation_id for update;
  if not found then raise exception 'ไม่พบคำขอพ้นสภาพ %', p_separation_id; end if;
  if v_sep.status <> 'APPROVED' then
    raise exception 'คำขอสถานะ % ยังไม่ได้รับอนุมัติ', v_sep.status;
  end if;

  select count(*) into v_outstanding
    from clearance_items where separation_id = p_separation_id and status in ('PENDING','OUTSTANDING');
  if v_outstanding > 0 then
    raise exception 'ยังมีรายการค้างเคลียร์ % รายการ', v_outstanding;
  end if;

  v_status := case v_sep.separation_type
                when 'RESIGN'       then 'RESIGNED'
                when 'RETIRE'       then 'RETIRED'
                when 'EARLY_RETIRE' then 'RETIRED'
                when 'TRANSFER_OUT' then 'TRANSFERRED_OUT'
                when 'DECEASE'      then 'DECEASED'
                when 'TERMINATE'    then 'TERMINATED'
                when 'DISMISS'      then 'TERMINATED'
                else 'RESIGNED' end;

  update employment_assignments
     set effective_to = v_sep.effective_date, updated_at = now(), updated_by = fn_current_user_id()
   where employee_id = v_sep.employee_id and effective_to is null;

  update employees
     set employment_status = v_status,
         separation_date   = v_sep.effective_date,
         updated_at        = now(),
         updated_by        = fn_current_user_id()
   where id = v_sep.employee_id
  returning * into v_emp;

  insert into employment_events (org_id, employee_id, event_type, event_date, title, detail,
                                 source_table, source_id, created_by)
  values (v_sep.org_id, v_sep.employee_id,
          case v_sep.separation_type
            when 'RETIRE' then 'RETIRE' when 'EARLY_RETIRE' then 'RETIRE'
            when 'DECEASE' then 'DECEASE'
            when 'TERMINATE' then 'TERMINATE' when 'DISMISS' then 'TERMINATE'
            else 'RESIGN' end,
          v_sep.effective_date,
          'พ้นสภาพการเป็นบุคลากร (' || v_sep.separation_type || ')',
          v_sep.reason_detail, 'separation_requests', p_separation_id, fn_current_user_id());

  -- ปิดสิทธิใช้งานระบบ
  update app_users set status = 'DISABLED', updated_at = now()
   where employee_id = v_sep.employee_id;
  update user_sessions set revoked_at = now()
   where user_id in (select id from app_users where employee_id = v_sep.employee_id)
     and revoked_at is null;

  -- ปิดสิทธิสวัสดิการ
  update benefit_enrollments set status = 'TERMINATED', end_date = v_sep.effective_date, updated_at = now()
   where employee_id = v_sep.employee_id and status = 'ACTIVE';

  update separation_requests set status = 'COMPLETED', updated_at = now() where id = p_separation_id;

  return v_emp;
end;
$$;

-- -----------------------------------------------------------------------------
-- View : รายชื่อผู้จะเกษียณอายุราชการใน 12 เดือนข้างหน้า
-- -----------------------------------------------------------------------------
create or replace view v_upcoming_retirements as
select
  v.org_id, v.employee_id, v.emp_code, v.full_name_th, v.birth_date,
  v.facility_id, v.facility_name, v.department_name, v.position_name,
  v.retirement_date,
  fn_fiscal_year(v.retirement_date) as retire_fiscal_year,
  (v.retirement_date - current_date) as days_remaining,
  v.service_length_text
from v_employee_current v
where v.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
  and v.retirement_date is not null
  and v.retirement_date between current_date and (current_date + interval '12 months')::date
order by v.retirement_date;
