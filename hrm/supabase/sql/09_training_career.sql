-- =============================================================================
-- HRM :: 09_training_career.sql
-- โมดูล 10 Training (ฝึกอบรม/พัฒนา) + โมดูล 11 Career (ความก้าวหน้า)
-- เชื่อมกับผลประเมิน (gap สมรรถนะ) -> แผนพัฒนารายบุคคล (IDP) -> เส้นทางความก้าวหน้า
-- =============================================================================

-- ---------------------------------------------------------------- Competency
create table if not exists competencies (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  competency_type text not null default 'CORE'
                    check (competency_type in ('CORE','MANAGERIAL','FUNCTIONAL','TECHNICAL')),
  description     text,
  level_definitions jsonb not null default '[]'::jsonb,  -- [{level:1,label:'',behavior:''}]
  max_level       int not null default 5,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- ระดับสมรรถนะที่ตำแหน่งต้องการ
create table if not exists position_competencies (
  id              uuid primary key default gen_random_uuid(),
  position_id     uuid not null references positions(id) on delete cascade,
  competency_id   uuid not null references competencies(id) on delete cascade,
  required_level  int not null default 3,
  weight_percent  numeric(6,2) not null default 0,
  unique (position_id, competency_id)
);

-- ระดับสมรรถนะจริงของบุคลากร (ประเมินรายรอบ)
create table if not exists employee_competencies (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  competency_id   uuid not null references competencies(id) on delete cascade,
  cycle_id        uuid references appraisal_cycles(id) on delete set null,
  assessed_level  int not null default 0,
  assessed_date   date not null default current_date,
  assessed_by     uuid references employees(id) on delete set null,
  evidence        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, competency_id, cycle_id)
);

-- ---------------------------------------------------------------- Training
create table if not exists training_courses (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  name_en         text,
  category        text not null default 'FUNCTIONAL'
                    check (category in ('ORIENTATION','CORE','MANAGERIAL','FUNCTIONAL','TECHNICAL',
                                        'SAFETY','COMPLIANCE','PROFESSIONAL','SOFT_SKILL','OTHER')),
  delivery_mode   text not null default 'CLASSROOM'
                    check (delivery_mode in ('CLASSROOM','ONLINE','HYBRID','OJT','SELF_STUDY','CONFERENCE')),
  provider_type   text not null default 'INTERNAL' check (provider_type in ('INTERNAL','EXTERNAL')),
  provider_name   text,
  duration_hours  numeric(6,2),
  cpe_credits     numeric(6,2),          -- หน่วยคะแนนวิชาชีพ (CNEU/CPE)
  cost_per_person numeric(14,2),
  objective       text,
  content_outline text,
  target_group    text,
  competency_ids  uuid[] not null default '{}',
  is_mandatory    boolean not null default false,
  validity_months int,                    -- ต้องอบรมซ้ำทุกกี่เดือน
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- แผนพัฒนาบุคลากรประจำปี (ระดับองค์กร)
create table if not exists training_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  fiscal_year     int not null,
  name_th         text not null,
  total_budget    numeric(16,2),
  used_budget     numeric(16,2) not null default 0,
  target_headcount int,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);

-- รุ่นการอบรม (session/class)
create table if not exists training_sessions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  course_id       uuid not null references training_courses(id) on delete cascade,
  plan_id         uuid references training_plans(id) on delete set null,
  session_code    text,
  title           text,
  start_date      date not null,
  end_date        date not null,
  start_time      time,
  end_time        time,
  venue           text,
  meeting_url     text,
  trainer         text,
  trainer_employee_id uuid references employees(id) on delete set null,
  max_seats       int,
  registered_count int not null default 0,
  budget_amount   numeric(14,2),
  actual_cost     numeric(14,2),
  status          text not null default 'PLANNED'
                    check (status in ('PLANNED','OPEN','FULL','ONGOING','COMPLETED','CANCELLED')),
  register_open   date,
  register_close  date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_session_period check (end_date >= start_date)
);
create index if not exists idx_tsession_date on training_sessions(org_id, start_date);

create table if not exists training_registrations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  session_id      uuid not null references training_sessions(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  registered_at   timestamptz not null default now(),
  registered_by   uuid references app_users(id) on delete set null,
  status          text not null default 'REGISTERED'
                    check (status in ('REGISTERED','WAITLIST','APPROVED','REJECTED','ATTENDED',
                                      'ABSENT','COMPLETED','FAILED','CANCELLED')),
  approval_note   text,
  attendance_percent numeric(5,2),
  pre_test_score  numeric(6,2),
  post_test_score numeric(6,2),
  evaluation_score numeric(6,2),
  feedback        text,
  certificate_no  text,
  certificate_url text,
  completed_date  date,
  expire_date     date,
  cost            numeric(14,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (session_id, employee_id)
);
create index if not exists idx_treg_emp on training_registrations(employee_id, status);

-- ประวัติการอบรมภายนอกที่บันทึกย้อนหลัง (ไม่ผ่านระบบลงทะเบียน)
create table if not exists training_records (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  registration_id uuid references training_registrations(id) on delete set null,
  course_name     text not null,
  provider        text,
  start_date      date,
  end_date        date,
  hours           numeric(6,2),
  cpe_credits     numeric(6,2),
  location        text,
  budget_source   text,
  cost            numeric(14,2),
  certificate_no  text,
  certificate_url text,
  expire_date     date,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_trec_emp on training_records(employee_id, start_date desc);

-- ---------------------------------------------------------------- IDP
create table if not exists development_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  cycle_id        uuid references appraisal_cycles(id) on delete set null,
  fiscal_year     int not null,
  career_goal     text,
  target_position_id uuid references positions(id) on delete set null,
  summary         text,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','AGREED','IN_PROGRESS','COMPLETED','CANCELLED')),
  agreed_by       uuid references employees(id) on delete set null,
  agreed_at       timestamptz,
  progress_percent numeric(5,2) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, fiscal_year)
);

create table if not exists development_activities (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references development_plans(id) on delete cascade,
  competency_id   uuid references competencies(id) on delete set null,
  activity_no     int not null default 1,
  method          text not null default 'TRAINING'
                    check (method in ('TRAINING','COACHING','MENTORING','JOB_ROTATION','ASSIGNMENT',
                                      'SELF_STUDY','CONFERENCE','CERTIFICATION','OTHER')),
  title           text not null,
  description     text,
  current_level   int,
  target_level    int,
  target_date     date,
  budget          numeric(14,2),
  course_id       uuid references training_courses(id) on delete set null,
  status          text not null default 'PLANNED'
                    check (status in ('PLANNED','IN_PROGRESS','COMPLETED','DEFERRED','CANCELLED')),
  completed_date  date,
  result_note     text,
  evidence_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_devact_plan on development_activities(plan_id);

-- ---------------------------------------------------------------- Career
create table if not exists career_paths (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  from_position_id uuid not null references positions(id) on delete cascade,
  to_position_id   uuid not null references positions(id) on delete cascade,
  path_type       text not null default 'PROMOTION'
                    check (path_type in ('PROMOTION','LATERAL','SPECIALIST','MANAGERIAL')),
  min_years_in_position numeric(4,1),
  min_total_years numeric(4,1),
  required_education text,
  required_training  uuid[] not null default '{}',
  required_rating    text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (from_position_id, to_position_id)
);

-- คำสั่งเลื่อน/ย้าย/แต่งตั้ง (สร้าง employment_assignment ใหม่เมื่ออนุมัติ)
create table if not exists career_movements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  movement_type   text not null
                    check (movement_type in ('PROMOTION','TRANSFER','ROTATION','ACTING','SECONDMENT',
                                             'DEMOTION','GRADE_CHANGE','REASSIGN')),
  effective_date  date not null,
  -- ค่าเดิม (snapshot)
  from_facility_id   uuid references facilities(id) on delete set null,
  from_department_id uuid references departments(id) on delete set null,
  from_position_id   uuid references positions(id) on delete set null,
  from_grade_id      uuid references job_grades(id) on delete set null,
  from_salary        numeric(14,2),
  -- ค่าใหม่
  to_facility_id     uuid references facilities(id) on delete set null,
  to_department_id   uuid references departments(id) on delete set null,
  to_position_id     uuid references positions(id) on delete set null,
  to_grade_id        uuid references job_grades(id) on delete set null,
  to_salary          numeric(14,2),
  to_supervisor_id   uuid references employees(id) on delete set null,
  reason          text,
  order_no        text,
  order_date      date,
  order_url       text,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','PROPOSED','APPROVED','APPLIED','REJECTED','CANCELLED')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  applied_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_move_emp on career_movements(employee_id, effective_date desc);
create index if not exists idx_move_status on career_movements(org_id, status);

-- แผนสืบทอดตำแหน่ง (succession)
create table if not exists succession_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  position_id     uuid not null references positions(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  incumbent_id    uuid references employees(id) on delete set null,
  candidate_id    uuid not null references employees(id) on delete cascade,
  readiness       text not null default 'DEVELOPING'
                    check (readiness in ('READY_NOW','READY_1_2Y','READY_3_5Y','DEVELOPING')),
  priority        int not null default 1,
  gap_note        text,
  review_date     date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (position_id, candidate_id)
);

-- -----------------------------------------------------------------------------
-- RPC : อนุมัติคำสั่งเลื่อน/ย้าย -> ปิด assignment เดิม + เปิด assignment ใหม่
-- -----------------------------------------------------------------------------
create or replace function fn_apply_career_movement(p_movement_id uuid)
returns employment_assignments
language plpgsql
as $$
declare
  v_mv   career_movements%rowtype;
  v_cur  employment_assignments%rowtype;
  v_new  employment_assignments%rowtype;
begin
  select * into v_mv from career_movements where id = p_movement_id for update;
  if not found then raise exception 'ไม่พบคำสั่ง %', p_movement_id; end if;
  if v_mv.status not in ('APPROVED') then
    raise exception 'คำสั่งสถานะ % ยังไม่ผ่านอนุมัติ', v_mv.status;
  end if;

  select * into v_cur from employment_assignments
   where employee_id = v_mv.employee_id and assignment_type = 'PRIMARY' and effective_to is null
   for update;

  if found then
    update employment_assignments
       set effective_to = v_mv.effective_date - 1, updated_at = now(), updated_by = fn_current_user_id()
     where id = v_cur.id;
  end if;

  insert into employment_assignments (
    org_id, employee_id, facility_id, department_id, position_id, job_grade_id, supervisor_id,
    employment_type, assignment_type, position_no, effective_from, reason,
    order_no, order_date, base_salary, work_shift_id, created_by
  ) values (
    v_mv.org_id, v_mv.employee_id,
    coalesce(v_mv.to_facility_id,   v_cur.facility_id),
    coalesce(v_mv.to_department_id, v_cur.department_id),
    coalesce(v_mv.to_position_id,   v_cur.position_id),
    coalesce(v_mv.to_grade_id,      v_cur.job_grade_id),
    coalesce(v_mv.to_supervisor_id, v_cur.supervisor_id),
    coalesce(v_cur.employment_type, 'CIVIL_SERVANT'),
    case when v_mv.movement_type = 'ACTING' then 'ACTING'
         when v_mv.movement_type = 'SECONDMENT' then 'SECONDMENT'
         else 'PRIMARY' end,
    v_cur.position_no, v_mv.effective_date,
    coalesce(v_mv.reason, v_mv.movement_type),
    v_mv.order_no, v_mv.order_date,
    coalesce(v_mv.to_salary, v_cur.base_salary),
    v_cur.work_shift_id, fn_current_user_id()
  ) returning * into v_new;

  -- บันทึก timeline
  insert into employment_events (org_id, employee_id, event_type, event_date, title, detail,
                                 order_no, order_date, from_value, to_value,
                                 source_table, source_id, created_by)
  values (
    v_mv.org_id, v_mv.employee_id,
    case v_mv.movement_type
      when 'PROMOTION' then 'PROMOTION'
      when 'TRANSFER'  then 'TRANSFER'
      when 'ROTATION'  then 'TRANSFER'
      when 'ACTING'    then 'ACTING'
      when 'SECONDMENT' then 'SECONDMENT'
      when 'GRADE_CHANGE' then 'GRADE_CHANGE'
      else 'TRANSFER' end,
    v_mv.effective_date,
    coalesce(v_mv.reason, v_mv.movement_type),
    'ตามคำสั่งเลขที่ ' || coalesce(v_mv.order_no, '-'),
    v_mv.order_no, v_mv.order_date,
    jsonb_build_object('facility_id', v_mv.from_facility_id, 'department_id', v_mv.from_department_id,
                       'position_id', v_mv.from_position_id, 'grade_id', v_mv.from_grade_id,
                       'salary', v_mv.from_salary),
    jsonb_build_object('facility_id', v_mv.to_facility_id, 'department_id', v_mv.to_department_id,
                       'position_id', v_mv.to_position_id, 'grade_id', v_mv.to_grade_id,
                       'salary', v_mv.to_salary),
    'career_movements', p_movement_id, fn_current_user_id());

  -- บันทึกประวัติเงินเดือนหากมีการเปลี่ยน
  if v_mv.to_salary is not null and v_mv.to_salary is distinct from v_mv.from_salary then
    insert into salary_histories (org_id, employee_id, effective_date, old_salary, new_salary,
                                  change_type, reason, order_no, order_date, created_by)
    values (v_mv.org_id, v_mv.employee_id, v_mv.effective_date, v_mv.from_salary, v_mv.to_salary,
            case when v_mv.movement_type = 'PROMOTION' then 'PROMOTION' else 'ADJUSTMENT' end,
            v_mv.reason, v_mv.order_no, v_mv.order_date, fn_current_user_id());
  end if;

  update career_movements set status = 'APPLIED', applied_at = now(), updated_at = now()
   where id = p_movement_id;

  return v_new;
end;
$$;

-- -----------------------------------------------------------------------------
-- View : ช่องว่างสมรรถนะ (competency gap) ใช้ตั้งต้น IDP
-- -----------------------------------------------------------------------------
create or replace view v_competency_gap as
select
  v.employee_id,
  v.org_id,
  v.emp_code,
  v.full_name_th,
  v.position_id,
  v.position_name,
  c.id            as competency_id,
  c.code          as competency_code,
  c.name_th       as competency_name,
  c.competency_type,
  pc.required_level,
  coalesce(ec.assessed_level, 0) as current_level,
  greatest(pc.required_level - coalesce(ec.assessed_level, 0), 0) as gap_level
from v_employee_current v
join position_competencies pc on pc.position_id = v.position_id
join competencies c on c.id = pc.competency_id and c.is_active
left join lateral (
  select e2.assessed_level
  from employee_competencies e2
  where e2.employee_id = v.employee_id and e2.competency_id = c.id
  order by e2.assessed_date desc
  limit 1
) ec on true
where v.employment_status in ('ACTIVE','PROBATION');
