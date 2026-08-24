-- =============================================================================
-- HRM :: 05_leave.sql
-- ประเภทการลา / สิทธิวันลา / ใบลา / การอนุมัติ / ยอดคงเหลือ
-- รองรับระเบียบราชการไทย: ลาป่วย ลากิจ ลาพักผ่อน (สะสมได้) ลาคลอด ลาอุปสมบท ฯลฯ
-- =============================================================================

create table if not exists leave_types (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  code              text not null,             -- SICK, PERSONAL, VACATION, MATERNITY, ORDINATION...
  name_th           text not null,
  name_en           text,
  category          text not null default 'GENERAL'
                      check (category in ('GENERAL','SICK','VACATION','MATERNITY','PATERNITY',
                                          'ORDINATION','MILITARY','STUDY','UNPAID','SPECIAL')),
  unit              text not null default 'DAY' check (unit in ('DAY','HOUR','HALF_DAY')),
  is_paid           boolean not null default true,
  default_quota     numeric(6,2),              -- สิทธิต่อปี (null = ไม่จำกัด/ตามระเบียบ)
  max_per_request   numeric(6,2),
  max_consecutive   numeric(6,2),
  allow_carry_over  boolean not null default false,
  carry_over_max    numeric(6,2),              -- ลาพักผ่อนสะสมไม่เกิน 20/30 วัน
  min_service_months int not null default 0,   -- ต้องทำงานครบกี่เดือนจึงมีสิทธิ
  require_attachment boolean not null default false,
  attachment_after_days numeric(4,1),          -- ลาป่วยเกิน 3 วันต้องมีใบรับรองแพทย์
  advance_notice_days int not null default 0,
  allow_backdate    boolean not null default true,
  deduct_salary_rate numeric(5,4) not null default 0,  -- 0 = ไม่หัก, 1 = หักเต็ม
  color             text default '#2a5f8f',
  sort_order        int not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- สิทธิวันลารายบุคคล ต่อปี (สร้างต้นปีงบประมาณ / ต้นปีปฏิทิน ตามนโยบาย)
create table if not exists leave_entitlements (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  employee_id       uuid not null references employees(id) on delete cascade,
  leave_type_id     uuid not null references leave_types(id) on delete cascade,
  period_year       int  not null,                  -- ปีงบประมาณ พ.ศ. เช่น 2569
  entitled_days     numeric(6,2) not null default 0,
  carried_over_days numeric(6,2) not null default 0,
  adjusted_days     numeric(6,2) not null default 0,  -- ปรับเพิ่ม/ลดโดย HR
  total_days        numeric(6,2) generated always as
                      (entitled_days + carried_over_days + adjusted_days) stored,
  expire_date       date,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, leave_type_id, period_year)
);
create index if not exists idx_entitle_emp on leave_entitlements(employee_id, period_year);

-- ใบลา
create table if not exists leave_requests (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  facility_id       uuid references facilities(id) on delete set null,
  employee_id       uuid not null references employees(id) on delete cascade,
  leave_type_id     uuid not null references leave_types(id) on delete restrict,
  request_no        text,
  period_year       int not null,
  start_date        date not null,
  end_date          date not null,
  half_day          text check (half_day in ('AM','PM')),   -- null = เต็มวัน
  start_time        time,                                   -- กรณีลาเป็นชั่วโมง
  end_time          time,
  total_days        numeric(6,2) not null default 0,        -- คำนวณตัดวันหยุด
  total_hours       numeric(6,2),
  reason            text not null,
  contact_address   text,
  contact_phone     text,
  delegate_to       uuid references employees(id) on delete set null,  -- ผู้ปฏิบัติงานแทน
  attachment_url    text,
  status            text not null default 'DRAFT'
                      check (status in ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','RETURNED')),
  submitted_at      timestamptz,
  approval_request_id uuid references approval_requests(id) on delete set null,
  approved_by       uuid references employees(id) on delete set null,
  approved_at       timestamptz,
  reject_reason     text,
  cancelled_at      timestamptz,
  cancel_reason     text,
  days_before_this_year numeric(6,2),   -- วันลาสะสมก่อนหน้า (พิมพ์บนแบบใบลา)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_leave_period check (end_date >= start_date),
  constraint ck_leave_half check (half_day is null or start_date = end_date)
);
create index if not exists idx_leave_emp on leave_requests(employee_id, start_date desc);
create index if not exists idx_leave_status on leave_requests(org_id, status) where status = 'PENDING';
create index if not exists idx_leave_range on leave_requests(org_id, start_date, end_date);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='fk_attendance_leave') then
    alter table attendance_daily add constraint fk_attendance_leave
      foreign key (leave_request_id) references leave_requests(id) on delete set null;
  end if;
end$$;

-- ดัชนีช่วงวันที่ (ใช้ตรวจการลาซ้อนวันอย่างรวดเร็ว) - ต้องมี btree_gist
create index if not exists idx_leave_overlap on leave_requests
  using gist (employee_id, daterange(start_date, end_date, '[]'))
  where status in ('PENDING','APPROVED');

-- ผู้ปฏิบัติราชการแทน / มอบอำนาจอนุมัติ
create table if not exists approval_delegations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  from_employee_id  uuid not null references employees(id) on delete cascade,
  to_employee_id    uuid not null references employees(id) on delete cascade,
  entity_types      text[] not null default array['LEAVE_REQUEST'],
  start_date        date not null,
  end_date          date not null,
  reason            text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by uuid,
  constraint ck_deleg_period check (end_date >= start_date),
  constraint ck_deleg_diff check (from_employee_id <> to_employee_id)
);

-- -----------------------------------------------------------------------------
-- ฟังก์ชันคำนวณจำนวนวันลา (ตัดวันหยุด/วันหยุดประจำสัปดาห์ตามนโยบายประเภทลา)
-- -----------------------------------------------------------------------------
create or replace function fn_count_leave_days(
  p_org_id uuid, p_employee_id uuid, p_from date, p_to date,
  p_half_day text default null, p_skip_holiday boolean default true)
returns numeric
language plpgsql stable
as $$
declare
  v_days numeric := 0;
  d date := p_from;
  v_facility uuid;
  v_is_off boolean;
begin
  if p_from is null or p_to is null or p_to < p_from then return 0; end if;

  if p_half_day in ('AM','PM') and p_from = p_to then return 0.5; end if;

  select a.facility_id into v_facility
  from employment_assignments a
  where a.employee_id = p_employee_id and a.assignment_type = 'PRIMARY'
    and a.effective_from <= p_from and (a.effective_to is null or a.effective_to >= p_from)
  limit 1;

  while d <= p_to loop
    v_is_off := false;
    if p_skip_holiday then
      -- วันหยุดตามปฏิทิน
      if exists (select 1 from holidays h
                 where h.org_id = p_org_id and h.holiday_date = d
                   and (h.facility_id is null or h.facility_id = v_facility)) then
        v_is_off := true;
      end if;
      -- วันหยุดตามตารางเวร (ถ้ามี roster) มิฉะนั้นใช้ เสาร์-อาทิตย์
      if not v_is_off then
        if exists (select 1 from work_schedules ws
                   where ws.employee_id = p_employee_id and ws.work_date = d) then
          select ws.is_day_off into v_is_off from work_schedules ws
           where ws.employee_id = p_employee_id and ws.work_date = d;
        elsif extract(isodow from d) in (6, 7) then
          v_is_off := true;
        end if;
      end if;
    end if;

    if not coalesce(v_is_off,false) then v_days := v_days + 1; end if;
    d := d + 1;
  end loop;

  return v_days;
end;
$$;

-- -----------------------------------------------------------------------------
-- View : ยอดวันลาคงเหลือรายคน/ประเภท/ปี
-- -----------------------------------------------------------------------------
create or replace view v_leave_balance as
with used as (
  select lr.employee_id, lr.leave_type_id, lr.period_year,
         sum(lr.total_days) filter (where lr.status = 'APPROVED') as used_days,
         sum(lr.total_days) filter (where lr.status = 'PENDING')  as pending_days
  from leave_requests lr
  group by 1,2,3
)
select
  e.id                                    as employee_id,
  e.org_id,
  e.emp_code,
  fn_employee_fullname(e.*)               as full_name_th,
  lt.id                                   as leave_type_id,
  lt.code                                 as leave_type_code,
  lt.name_th                              as leave_type_name,
  coalesce(le.period_year, fn_fiscal_year(current_date)) as period_year,
  coalesce(le.total_days, lt.default_quota, 0)::numeric(6,2) as total_days,
  coalesce(u.used_days, 0)::numeric(6,2)     as used_days,
  coalesce(u.pending_days, 0)::numeric(6,2)  as pending_days,
  (coalesce(le.total_days, lt.default_quota, 0)
     - coalesce(u.used_days,0) - coalesce(u.pending_days,0))::numeric(6,2) as remaining_days
from employees e
join leave_types lt on lt.org_id = e.org_id and lt.is_active
left join leave_entitlements le
       on le.employee_id = e.id and le.leave_type_id = lt.id
      and le.period_year = fn_fiscal_year(current_date)
left join used u
       on u.employee_id = e.id and u.leave_type_id = lt.id
      and u.period_year = fn_fiscal_year(current_date)
where e.employment_status in ('ACTIVE','PROBATION','ON_LEAVE');

comment on view v_leave_balance is 'ยอดวันลาคงเหลือปีงบประมาณปัจจุบัน (หักทั้งที่อนุมัติแล้วและรออนุมัติ)';

-- -----------------------------------------------------------------------------
-- RPC : ส่งใบลา (ตรวจสิทธิ + คำนวณวัน + สร้าง approval request)
-- -----------------------------------------------------------------------------
create or replace function fn_submit_leave_request(p_request_id uuid)
returns leave_requests
language plpgsql
as $$
declare
  v_lr       leave_requests%rowtype;
  v_lt       leave_types%rowtype;
  v_days     numeric;
  v_balance  numeric;
  v_flow     approval_flows%rowtype;
  v_appr_id  uuid;
  v_emp      employees%rowtype;
begin
  select * into v_lr from leave_requests where id = p_request_id for update;
  if not found then raise exception 'ไม่พบใบลา %', p_request_id; end if;
  if v_lr.status not in ('DRAFT','RETURNED') then
    raise exception 'ใบลาสถานะ % ไม่สามารถส่งอนุมัติได้', v_lr.status;
  end if;

  select * into v_lt  from leave_types where id = v_lr.leave_type_id;
  select * into v_emp from employees   where id = v_lr.employee_id;

  -- ตรวจอายุงานขั้นต่ำ
  if v_lt.min_service_months > 0 and v_emp.hire_date is not null then
    if v_emp.hire_date + (v_lt.min_service_months || ' months')::interval > v_lr.start_date then
      raise exception 'อายุงานไม่ถึงเกณฑ์ใช้สิทธิ % (ต้องครบ % เดือน)', v_lt.name_th, v_lt.min_service_months;
    end if;
  end if;

  -- ตรวจเอกสารแนบ
  if v_lt.require_attachment and coalesce(v_lr.attachment_url,'') = '' then
    raise exception 'ประเภทการลา % ต้องแนบเอกสารประกอบ', v_lt.name_th;
  end if;

  -- ห้ามลาซ้อนกับใบที่ยังมีผล
  if exists (
    select 1 from leave_requests x
    where x.employee_id = v_lr.employee_id
      and x.id <> v_lr.id
      and x.status in ('PENDING','APPROVED')
      and daterange(x.start_date, x.end_date, '[]')
          && daterange(v_lr.start_date, v_lr.end_date, '[]')
      -- อนุญาตครึ่งวันเช้า/บ่ายในวันเดียวกัน
      and not (x.half_day is not null and v_lr.half_day is not null
               and x.half_day <> v_lr.half_day
               and x.start_date = v_lr.start_date)
  ) then
    raise exception 'มีใบลาที่ยังมีผลซ้อนทับช่วงวันที่นี้อยู่แล้ว';
  end if;

  v_days := fn_count_leave_days(v_lr.org_id, v_lr.employee_id, v_lr.start_date, v_lr.end_date, v_lr.half_day);
  if v_days <= 0 then raise exception 'ช่วงวันที่ลาไม่มีวันทำการ'; end if;

  if v_lt.max_consecutive is not null and v_days > v_lt.max_consecutive then
    raise exception 'ลา % ติดต่อกันได้ไม่เกิน % วัน', v_lt.name_th, v_lt.max_consecutive;
  end if;

  -- ตรวจสิทธิคงเหลือ (เฉพาะประเภทที่กำหนดโควตา)
  if v_lt.default_quota is not null then
    select b.remaining_days into v_balance
    from v_leave_balance b
    where b.employee_id = v_lr.employee_id and b.leave_type_id = v_lr.leave_type_id;

    if coalesce(v_balance, 0) < v_days then
      raise exception 'วันลาคงเหลือไม่พอ (คงเหลือ % วัน ขอลา % วัน)', coalesce(v_balance,0), v_days;
    end if;
  end if;

  -- เลือก flow อนุมัติที่เงื่อนไขตรงที่สุด (days_gte สูงสุดที่ยังไม่เกินจำนวนวันที่ลา)
  select * into v_flow from approval_flows
   where org_id = v_lr.org_id and entity_type = 'LEAVE_REQUEST' and is_active
     and coalesce((condition->>'days_gte')::numeric, 0) <= v_days
   order by coalesce((condition->>'days_gte')::numeric, 0) desc
   limit 1;

  if v_flow.id is null then
    raise exception 'ยังไม่ได้ตั้งค่าสายอนุมัติใบลาขององค์กรนี้';
  end if;

  insert into approval_requests (org_id, flow_id, entity_type, entity_id, requested_by, summary, created_by)
  values (v_lr.org_id, v_flow.id, 'LEAVE_REQUEST', v_lr.id,
          (select id from app_users where employee_id = v_lr.employee_id limit 1),
          jsonb_build_object('leave_type', v_lt.name_th, 'days', v_days,
                             'from', v_lr.start_date, 'to', v_lr.end_date,
                             'employee', fn_employee_fullname(v_emp.*)),
          fn_current_user_id())
  returning id into v_appr_id;

  update leave_requests set
    total_days = v_days,
    request_no = coalesce(request_no, fn_next_document_no(v_lr.org_id, 'LEAVE', 'LV',
                          fn_fiscal_year(v_lr.start_date)::text, 4)),
    period_year = fn_fiscal_year(v_lr.start_date),
    status = 'PENDING',
    submitted_at = now(),
    approval_request_id = v_appr_id,
    updated_at = now()
  where id = p_request_id
  returning * into v_lr;

  return v_lr;
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : อนุมัติ/ไม่อนุมัติใบลา  (เดินตาม approval flow ทีละขั้น)
-- -----------------------------------------------------------------------------
create or replace function fn_act_leave_request(
  p_request_id uuid, p_action text, p_actor_user_id uuid, p_comment text default null)
returns leave_requests
language plpgsql
as $$
declare
  v_lr      leave_requests%rowtype;
  v_appr    approval_requests%rowtype;
  v_steps   int;
  v_final   boolean := false;
begin
  if p_action not in ('APPROVE','REJECT','RETURN','CANCEL') then
    raise exception 'action ไม่ถูกต้อง: %', p_action;
  end if;

  select * into v_lr from leave_requests where id = p_request_id for update;
  if not found then raise exception 'ไม่พบใบลา %', p_request_id; end if;
  if v_lr.status <> 'PENDING' then
    raise exception 'ใบลาสถานะ % ไม่อยู่ระหว่างพิจารณา', v_lr.status;
  end if;

  select * into v_appr from approval_requests where id = v_lr.approval_request_id for update;

  insert into approval_actions (request_id, step_no, actor_user_id, action, comment)
  values (v_appr.id, coalesce(v_appr.current_step,1), p_actor_user_id, p_action, p_comment);

  if p_action = 'APPROVE' then
    select count(*) into v_steps from approval_flow_steps where flow_id = v_appr.flow_id;
    v_final := (coalesce(v_appr.current_step,1) >= greatest(v_steps,1));

    if v_final then
      update approval_requests set status='APPROVED', completed_at=now(), updated_at=now()
       where id = v_appr.id;
      update leave_requests set status='APPROVED', approved_at=now(),
             approved_by=(select employee_id from app_users where id = p_actor_user_id),
             updated_at=now()
       where id = p_request_id;
    else
      update approval_requests set current_step = current_step + 1, updated_at=now()
       where id = v_appr.id;
    end if;

  elsif p_action = 'REJECT' then
    update approval_requests set status='REJECTED', completed_at=now(), updated_at=now() where id = v_appr.id;
    update leave_requests set status='REJECTED', reject_reason=p_comment, updated_at=now() where id = p_request_id;

  elsif p_action = 'RETURN' then
    update approval_requests set status='RETURNED', current_step=1, updated_at=now() where id = v_appr.id;
    update leave_requests set status='RETURNED', reject_reason=p_comment, updated_at=now() where id = p_request_id;

  elsif p_action = 'CANCEL' then
    update approval_requests set status='CANCELLED', completed_at=now(), updated_at=now() where id = v_appr.id;
    update leave_requests set status='CANCELLED', cancel_reason=p_comment, cancelled_at=now(), updated_at=now()
     where id = p_request_id;
  end if;

  select * into v_lr from leave_requests where id = p_request_id;

  -- อนุมัติแล้วให้ปรับสรุปเวลารายวันในช่วงที่ลา
  if v_lr.status = 'APPROVED' then
    perform fn_recalc_attendance(v_lr.employee_id, g.d::date)
    from generate_series(v_lr.start_date::timestamp, v_lr.end_date::timestamp, interval '1 day') g(d);
  end if;

  return v_lr;
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : ตั้งสิทธิวันลาประจำปีให้ทั้งองค์กร (ยกยอดลาพักผ่อนตามระเบียบ)
-- -----------------------------------------------------------------------------
create or replace function fn_generate_leave_entitlements(p_org_id uuid, p_period_year int)
returns int
language plpgsql
as $$
declare v_count int := 0; r record; v_carry numeric;
begin
  for r in
    select e.id as employee_id, lt.id as leave_type_id, lt.default_quota,
           lt.allow_carry_over, lt.carry_over_max
    from employees e
    join leave_types lt on lt.org_id = e.org_id and lt.is_active
    where e.org_id = p_org_id
      and e.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
  loop
    v_carry := 0;
    if r.allow_carry_over then
      -- ยอดคงเหลือของปีก่อน = สิทธิรวม - วันที่ใช้จริง (อนุมัติแล้ว)
      select least(
               greatest(le.total_days - coalesce((
                 select sum(lr.total_days) from leave_requests lr
                 where lr.employee_id  = le.employee_id
                   and lr.leave_type_id = le.leave_type_id
                   and lr.period_year   = le.period_year
                   and lr.status = 'APPROVED'), 0), 0),
               coalesce(r.carry_over_max, 999999))
        into v_carry
      from leave_entitlements le
      where le.employee_id  = r.employee_id
        and le.leave_type_id = r.leave_type_id
        and le.period_year   = p_period_year - 1;
    end if;

    insert into leave_entitlements (org_id, employee_id, leave_type_id, period_year,
                                    entitled_days, carried_over_days, created_by)
    values (p_org_id, r.employee_id, r.leave_type_id, p_period_year,
            coalesce(r.default_quota, 0), coalesce(v_carry,0), fn_current_user_id())
    on conflict (employee_id, leave_type_id, period_year)
    do update set entitled_days = excluded.entitled_days,
                  carried_over_days = excluded.carried_over_days,
                  updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
