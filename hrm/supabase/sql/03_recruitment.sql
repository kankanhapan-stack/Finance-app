-- =============================================================================
-- HRM :: 03_recruitment.sql
-- การรับสมัคร -> คัดเลือก -> บรรจุ
-- ปลายทางของโมดูลนี้คือการ "แปลงผู้สมัครเป็นบุคลากร" โดยไม่ต้องคีย์ข้อมูลซ้ำ
-- =============================================================================

-- คำขออัตรากำลัง (Manpower Request) - ต้นทางของการเปิดรับสมัคร
create table if not exists manpower_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  department_id   uuid references departments(id) on delete set null,
  position_id     uuid not null references positions(id) on delete restrict,
  request_no      text,
  fiscal_year     int not null,
  headcount       int not null default 1 check (headcount > 0),
  reason          text not null default 'REPLACEMENT'
                    check (reason in ('NEW','REPLACEMENT','EXPANSION','TEMPORARY')),
  justification   text,
  needed_by       date,
  budget_source   text,
  budget_amount   numeric(14,2),
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','CLOSED')),
  requested_by    uuid references employees(id) on delete set null,
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_mpr_org on manpower_requests(org_id, status);

-- ประกาศรับสมัคร
create table if not exists job_postings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  department_id   uuid references departments(id) on delete set null,
  position_id     uuid not null references positions(id) on delete restrict,
  manpower_request_id uuid references manpower_requests(id) on delete set null,
  posting_no      text,
  title           text not null,
  employment_type text not null default 'CONTRACT'
                    check (employment_type in ('CIVIL_SERVANT','GOV_EMPLOYEE','PERMANENT_EMP',
                                               'TEMPORARY','CONTRACT','DAILY','OUTSOURCE','VOLUNTEER')),
  openings        int not null default 1,
  salary_min      numeric(12,2),
  salary_max      numeric(12,2),
  qualification   text,           -- คุณสมบัติเฉพาะตำแหน่ง
  description     text,           -- ลักษณะงานที่ปฏิบัติ
  benefits        text,
  work_location   text,
  open_date       date not null,
  close_date      date not null,
  exam_date       date,
  announce_date   date,
  contact_info    jsonb not null default '{}'::jsonb,
  attachment_url  text,           -- ไฟล์ประกาศ (PDF)
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','OPEN','CLOSED','SCREENING','INTERVIEWING',
                                      'ANNOUNCED','FILLED','CANCELLED')),
  is_public       boolean not null default true,   -- แสดงบนหน้าเว็บสมัครออนไลน์
  public_slug     text unique,                     -- ลิงก์สมัครออนไลน์
  view_count      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_posting_period check (close_date >= open_date)
);
create index if not exists idx_posting_open on job_postings(org_id, status, close_date);

-- ผู้สมัคร (ตัวบุคคล - ใช้ซ้ำได้หากสมัครหลายตำแหน่ง)
create table if not exists applicants (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  national_id     text,
  title_th        text,
  first_name_th   text not null,
  last_name_th    text not null,
  gender          text check (gender in ('M','F','OTHER')),
  birth_date      date,
  phone           text,
  email           text,
  address         jsonb not null default '{}'::jsonb,
  education       jsonb not null default '[]'::jsonb,   -- [{level,degree,major,institute,year,gpa}]
  experience      jsonb not null default '[]'::jsonb,
  licenses        jsonb not null default '[]'::jsonb,
  skills          jsonb not null default '[]'::jsonb,
  resume_url      text,
  photo_url       text,
  source          text default 'WEBSITE'
                    check (source in ('WEBSITE','WALK_IN','REFERRAL','JOB_BOARD','SOCIAL','INTERNAL','OTHER')),
  referred_by     uuid references employees(id) on delete set null,
  is_blacklisted  boolean not null default false,
  blacklist_reason text,
  employee_id     uuid references employees(id) on delete set null,  -- เมื่อบรรจุแล้ว
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_applicant_nid check (fn_valid_thai_id(national_id))
);
create unique index if not exists uq_applicant_nid on applicants(org_id, national_id) where national_id is not null;
create index if not exists idx_applicant_name on applicants(org_id, last_name_th);

-- ใบสมัคร (1 ผู้สมัคร : N ประกาศ)
create table if not exists applications (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  posting_id      uuid not null references job_postings(id) on delete cascade,
  applicant_id    uuid not null references applicants(id) on delete cascade,
  application_no  text,                       -- เลขประจำตัวสอบ
  applied_at      timestamptz not null default now(),
  stage           text not null default 'RECEIVED'
                    check (stage in ('RECEIVED','SCREENING','EXAM','INTERVIEW','SELECTED',
                                     'RESERVED','OFFERED','HIRED','REJECTED','WITHDRAWN')),
  screening_result text check (screening_result in ('PASS','FAIL','PENDING')),
  screening_note  text,
  total_score     numeric(6,2),
  rank_no         int,                        -- ลำดับที่สอบได้
  is_reserve      boolean not null default false,
  reject_reason   text,
  documents       jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (posting_id, applicant_id)
);
create index if not exists idx_application_posting on applications(posting_id, stage);

-- คะแนน/ผลการคัดเลือกรายด้าน (สอบข้อเขียน/ปฏิบัติ/สัมภาษณ์)
create table if not exists application_assessments (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications(id) on delete cascade,
  assessment_type text not null check (assessment_type in ('WRITTEN','PRACTICAL','INTERVIEW','PSYCHO','REFERENCE','OTHER')),
  criteria        text,
  max_score       numeric(6,2) not null default 100,
  score           numeric(6,2),
  weight_percent  numeric(5,2) not null default 100,
  assessor_id     uuid references employees(id) on delete set null,
  assessed_at     timestamptz,
  comment         text,
  created_at      timestamptz not null default now(),
  created_by uuid
);
create index if not exists idx_assess_app on application_assessments(application_id);

-- นัดหมายสัมภาษณ์
create table if not exists interview_schedules (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications(id) on delete cascade,
  round_no        int not null default 1,
  scheduled_at    timestamptz not null,
  duration_min    int not null default 30,
  location        text,
  meeting_url     text,
  panel           jsonb not null default '[]'::jsonb,   -- [{employee_id, name, role}]
  status          text not null default 'SCHEDULED'
                    check (status in ('SCHEDULED','CONFIRMED','COMPLETED','NO_SHOW','CANCELLED','RESCHEDULED')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_interview_time on interview_schedules(scheduled_at) where status = 'SCHEDULED';

-- หนังสือแจ้งผล/เสนอจ้าง
create table if not exists job_offers (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  offer_no        text,
  position_id     uuid references positions(id) on delete set null,
  facility_id     uuid references facilities(id) on delete set null,
  department_id   uuid references departments(id) on delete set null,
  offered_salary  numeric(12,2),
  employment_type text,
  start_date      date,
  contract_months int,
  probation_months int not null default 4,
  offer_date      date not null default current_date,
  expire_date     date,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','EXPIRED','CANCELLED')),
  responded_at    timestamptz,
  decline_reason  text,
  document_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);

-- Onboarding checklist หลังตอบรับ
create table if not exists onboarding_tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid references employees(id) on delete cascade,
  application_id  uuid references applications(id) on delete set null,
  task_name       text not null,
  category        text default 'DOCUMENT'
                    check (category in ('DOCUMENT','IT','FACILITY','TRAINING','ORIENTATION','HEALTH','OTHER')),
  responsible_dept_id uuid references departments(id) on delete set null,
  due_date        date,
  completed_at    timestamptz,
  completed_by    uuid references app_users(id) on delete set null,
  status          text not null default 'PENDING' check (status in ('PENDING','DONE','SKIPPED','BLOCKED')),
  note            text,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_onboard_emp on onboarding_tasks(employee_id, status);

-- -----------------------------------------------------------------------------
-- RPC : บรรจุผู้สมัครเป็นบุคลากร (ใช้ข้อมูลเดิม ไม่คีย์ซ้ำ)
-- -----------------------------------------------------------------------------
create or replace function fn_hire_applicant(
  p_application_id uuid,
  p_emp_code       text,
  p_hire_date      date,
  p_facility_id    uuid default null,
  p_department_id  uuid default null,
  p_position_id    uuid default null,
  p_job_grade_id   uuid default null,
  p_base_salary    numeric default null,
  p_supervisor_id  uuid default null,
  p_employment_type text default null,
  p_probation_months int default 4
) returns uuid
language plpgsql
as $$
declare
  v_app       applications%rowtype;
  v_applicant applicants%rowtype;
  v_posting   job_postings%rowtype;
  v_emp_id    uuid;
  v_type      text;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then raise exception 'ไม่พบใบสมัคร %', p_application_id; end if;

  select * into v_applicant from applicants where id = v_app.applicant_id;
  select * into v_posting   from job_postings where id = v_app.posting_id;

  if v_applicant.employee_id is not null then
    raise exception 'ผู้สมัครรายนี้ถูกบรรจุแล้ว (employee_id=%)', v_applicant.employee_id;
  end if;

  v_type := coalesce(p_employment_type, v_posting.employment_type, 'CONTRACT');

  insert into employees (
    org_id, emp_code, national_id, title_th, first_name_th, last_name_th,
    gender, birth_date, phone, email, address_current,
    employment_status, hire_date, probation_end_date, photo_url, created_by
  ) values (
    v_app.org_id, p_emp_code, v_applicant.national_id, v_applicant.title_th,
    v_applicant.first_name_th, v_applicant.last_name_th,
    v_applicant.gender, v_applicant.birth_date, v_applicant.phone, v_applicant.email,
    v_applicant.address,
    case when coalesce(p_probation_months,0) > 0 then 'PROBATION' else 'ACTIVE' end,
    p_hire_date,
    case when coalesce(p_probation_months,0) > 0
         then (p_hire_date + (p_probation_months || ' months')::interval)::date end,
    v_applicant.photo_url, fn_current_user_id()
  ) returning id into v_emp_id;

  -- โอนประวัติการศึกษาจาก JSON ของผู้สมัคร
  insert into employee_educations (employee_id, level, degree_name, major, institute, graduate_year, gpa, created_by)
  select v_emp_id,
         coalesce(x->>'level','OTHER'),
         x->>'degree', x->>'major', x->>'institute',
         nullif(x->>'year','')::int, nullif(x->>'gpa','')::numeric,
         fn_current_user_id()
  from jsonb_array_elements(coalesce(v_applicant.education,'[]'::jsonb)) x
  where coalesce(x->>'level','OTHER') in ('PRIMARY','SECONDARY','VOCATIONAL','DIPLOMA',
                                          'BACHELOR','MASTER','DOCTORATE','CERTIFICATE','OTHER');

  -- โอนประสบการณ์ทำงาน
  insert into employee_experiences (employee_id, organization, position_name, start_date, end_date, duty, created_by)
  select v_emp_id, coalesce(x->>'organization','-'), x->>'position',
         nullif(x->>'start_date','')::date, nullif(x->>'end_date','')::date,
         x->>'duty', fn_current_user_id()
  from jsonb_array_elements(coalesce(v_applicant.experience,'[]'::jsonb)) x;

  -- สร้างการดำรงตำแหน่งแรก
  insert into employment_assignments (
    org_id, employee_id, facility_id, department_id, position_id, job_grade_id,
    supervisor_id, employment_type, assignment_type, effective_from, reason,
    base_salary, created_by
  ) values (
    v_app.org_id, v_emp_id,
    coalesce(p_facility_id,   v_posting.facility_id),
    coalesce(p_department_id, v_posting.department_id),
    coalesce(p_position_id,   v_posting.position_id),
    p_job_grade_id, p_supervisor_id, v_type, 'PRIMARY', p_hire_date,
    'บรรจุจากการคัดเลือกตามประกาศ ' || coalesce(v_posting.posting_no, v_posting.title),
    p_base_salary, fn_current_user_id()
  );

  insert into employment_events (org_id, employee_id, event_type, event_date, title, detail,
                                 to_value, source_table, source_id, created_by)
  values (v_app.org_id, v_emp_id, 'HIRE', p_hire_date, 'บรรจุเข้าปฏิบัติงาน',
          'จากใบสมัครเลขที่ ' || coalesce(v_app.application_no,'-'),
          jsonb_build_object('position_id', coalesce(p_position_id, v_posting.position_id),
                             'salary', p_base_salary),
          'applications', p_application_id, fn_current_user_id());

  update applicants   set employee_id = v_emp_id, updated_at = now() where id = v_applicant.id;
  update applications set stage = 'HIRED', updated_at = now() where id = p_application_id;

  return v_emp_id;
end;
$$;

comment on function fn_hire_applicant is 'บรรจุผู้สมัคร -> สร้าง employee + assignment + event + โอนประวัติการศึกษา/ประสบการณ์';
