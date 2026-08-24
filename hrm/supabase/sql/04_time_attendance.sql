-- =============================================================================
-- HRM :: 04_time_attendance.sql
-- ปฏิทินทำงาน / กะ / ตารางเวร / บันทึกเวลา / สรุปการมาปฏิบัติงานรายวัน
-- =============================================================================

-- วันหยุดราชการ/วันหยุดเฉพาะสถานบริการ
create table if not exists holidays (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete cascade,  -- null = ทั้งองค์กร
  holiday_date    date not null,
  name_th         text not null,
  holiday_type    text not null default 'PUBLIC'
                    check (holiday_type in ('PUBLIC','SUBSTITUTE','SPECIAL','ORG','FACILITY')),
  is_paid         boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by uuid,
  unique (org_id, facility_id, holiday_date)
);
create index if not exists idx_holiday_date on holidays(org_id, holiday_date);

-- กะการทำงาน
create table if not exists work_shifts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  shift_type      text not null default 'FIXED' check (shift_type in ('FIXED','FLEXIBLE','ROTATING','OFF')),
  start_time      time,
  end_time        time,
  cross_midnight  boolean not null default false,   -- เวรดึก
  break_minutes   int not null default 60,
  work_minutes    int,                              -- ชั่วโมงงานมาตรฐาน (นาที)
  late_grace_min  int not null default 15,          -- ผ่อนผันสาย
  early_grace_min int not null default 0,
  color           text default '#2b8a5c',
  is_ot_eligible  boolean not null default true,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='fk_assign_shift') then
    alter table employment_assignments add constraint fk_assign_shift
      foreign key (work_shift_id) references work_shifts(id) on delete set null;
  end if;
end$$;

-- ตารางเวร/ตารางปฏิบัติงานรายวัน (roster)
create table if not exists work_schedules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  employee_id     uuid not null references employees(id) on delete cascade,
  work_date       date not null,
  shift_id        uuid references work_shifts(id) on delete set null,
  is_day_off      boolean not null default false,
  planned_start   timestamptz,
  planned_end     timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, work_date)
);
create index if not exists idx_sched_date on work_schedules(org_id, work_date);
create index if not exists idx_sched_fac_date on work_schedules(facility_id, work_date);

-- บันทึกเวลาดิบ (raw punch) - รองรับหลายช่องทาง
create table if not exists time_logs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  log_time        timestamptz not null,
  log_date        date generated always as ((log_time at time zone 'Asia/Bangkok')::date) stored,
  direction       text not null default 'IN' check (direction in ('IN','OUT','BREAK_OUT','BREAK_IN')),
  method          text not null default 'WEB'
                    check (method in ('WEB','MOBILE','QR','FINGERPRINT','FACE','CARD','LINE','MANUAL','IMPORT')),
  device_id       text,
  gps_lat         numeric(10,7),
  gps_lng         numeric(10,7),
  gps_accuracy_m  numeric(8,2),
  distance_m      numeric(10,2),          -- ระยะห่างจากพิกัดสถานบริการ
  is_outside_geo  boolean not null default false,
  photo_url       text,
  ip              text,
  user_agent      text,
  source_ref      text,                   -- อ้างอิงเครื่องสแกน/ไฟล์นำเข้า
  is_manual       boolean not null default false,
  manual_reason   text,
  approved_by     uuid references app_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists idx_timelog_emp_date on time_logs(employee_id, log_date);
create index if not exists idx_timelog_org_date on time_logs(org_id, log_date);
create unique index if not exists uq_timelog_dedup on time_logs(employee_id, log_time, direction);

-- สรุปการมาปฏิบัติงานรายวัน (คำนวณจาก time_logs + work_schedules + leave)
create table if not exists attendance_daily (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  work_date       date not null,
  shift_id        uuid references work_shifts(id) on delete set null,
  first_in        timestamptz,
  last_out        timestamptz,
  work_minutes    int not null default 0,
  late_minutes    int not null default 0,
  early_leave_minutes int not null default 0,
  ot_minutes      int not null default 0,
  break_minutes   int not null default 0,
  status          text not null default 'PRESENT'
                    check (status in ('PRESENT','LATE','ABSENT','LEAVE','HOLIDAY','DAY_OFF',
                                      'HALF_DAY','MISSING_OUT','MISSING_IN','TRIP','TRAINING')),
  leave_request_id uuid,                  -- FK เพิ่มใน 05_leave
  remark          text,
  is_locked       boolean not null default false,   -- ปิดงวดแล้ว แก้ไขไม่ได้
  calculated_at   timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, work_date)
);
create index if not exists idx_att_org_date on attendance_daily(org_id, work_date);
create index if not exists idx_att_status on attendance_daily(org_id, work_date, status);

-- คำขอทำงานล่วงเวลา
create table if not exists overtime_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  request_no      text,
  work_date       date not null,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  planned_minutes int generated always as
                    (greatest(0, (extract(epoch from (end_time - start_time)) / 60)::int)) stored,
  actual_minutes  int,
  ot_rate         numeric(5,2) not null default 1.5,
  reason          text not null,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','PAID')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_ot_period check (end_time > start_time)
);
create index if not exists idx_ot_emp on overtime_requests(employee_id, work_date);

-- คำขอแก้ไขเวลา (ลืมสแกน)
create table if not exists time_adjustments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  work_date       date not null,
  adjust_type     text not null check (adjust_type in ('ADD_IN','ADD_OUT','EDIT_IN','EDIT_OUT','EXCUSE_LATE')),
  requested_time  timestamptz,
  reason          text not null,
  evidence_url    text,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  approver_note   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_timeadj_pending on time_adjustments(org_id, status) where status = 'PENDING';

-- การไปราชการ/ปฏิบัติงานนอกสถานที่
create table if not exists business_trips (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  trip_no         text,
  purpose         text not null,
  destination     text,
  start_date      date not null,
  end_date        date not null,
  order_no        text,
  budget_amount   numeric(12,2),
  status          text not null default 'PENDING'
                    check (status in ('PENDING','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  report_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint ck_trip_period check (end_date >= start_date)
);

-- -----------------------------------------------------------------------------
-- RPC : คำนวณสรุปเวลารายวันของบุคลากร 1 คน 1 วัน
-- เรียกจาก Apps Script time-driven trigger (รายวัน) หรือเมื่อมีการแก้เวลา
-- -----------------------------------------------------------------------------
create or replace function fn_recalc_attendance(p_employee_id uuid, p_date date)
returns attendance_daily
language plpgsql
as $$
declare
  v_org        uuid;
  v_facility   uuid;
  v_sched      work_schedules%rowtype;
  v_shift      work_shifts%rowtype;
  v_first_in   timestamptz;
  v_last_out   timestamptz;
  v_status     text := 'ABSENT';
  v_late       int  := 0;
  v_early      int  := 0;
  v_work       int  := 0;
  v_ot         int  := 0;
  v_holiday    boolean;
  v_leave_id   uuid;
  v_leave_half text;
  v_planned_start timestamptz;
  v_planned_end   timestamptz;
  v_row        attendance_daily%rowtype;
begin
  select e.org_id into v_org from employees e where e.id = p_employee_id;
  if v_org is null then raise exception 'ไม่พบบุคลากร %', p_employee_id; end if;

  select a.facility_id into v_facility
  from employment_assignments a
  where a.employee_id = p_employee_id and a.assignment_type = 'PRIMARY'
    and a.effective_from <= p_date and (a.effective_to is null or a.effective_to >= p_date)
  limit 1;

  -- ถ้าปิดงวดแล้ว ไม่คำนวณซ้ำ
  select * into v_row from attendance_daily where employee_id = p_employee_id and work_date = p_date;
  if found and v_row.is_locked then return v_row; end if;

  select * into v_sched from work_schedules
   where employee_id = p_employee_id and work_date = p_date;

  if v_sched.shift_id is not null then
    select * into v_shift from work_shifts where id = v_sched.shift_id;
  else
    select ws.* into v_shift
    from employment_assignments a
    join work_shifts ws on ws.id = a.work_shift_id
    where a.employee_id = p_employee_id and a.assignment_type = 'PRIMARY'
      and a.effective_from <= p_date and (a.effective_to is null or a.effective_to >= p_date)
    limit 1;
  end if;

  select exists(
    select 1 from holidays h
    where h.org_id = v_org and h.holiday_date = p_date
      and (h.facility_id is null or h.facility_id = v_facility)
  ) into v_holiday;

  select min(log_time) filter (where direction = 'IN'),
         max(log_time) filter (where direction = 'OUT')
    into v_first_in, v_last_out
  from time_logs
  where employee_id = p_employee_id and log_date = p_date;

  -- การลาที่อนุมัติแล้วครอบคลุมวันนี้
  select lr.id, lr.half_day into v_leave_id, v_leave_half
  from leave_requests lr
  where lr.employee_id = p_employee_id
    and lr.status = 'APPROVED'
    and p_date between lr.start_date and lr.end_date
  limit 1;

  if v_shift.id is not null and v_shift.start_time is not null then
    v_planned_start := (p_date + v_shift.start_time) at time zone 'Asia/Bangkok';
    v_planned_end   := (p_date + v_shift.end_time
                        + case when v_shift.cross_midnight then interval '1 day' else interval '0' end)
                       at time zone 'Asia/Bangkok';
  end if;

  -- ลำดับการตัดสินสถานะ
  if v_leave_id is not null then
    v_status := case when v_leave_half in ('AM','PM') then 'HALF_DAY' else 'LEAVE' end;
  elsif v_holiday then
    v_status := 'HOLIDAY';
  elsif coalesce(v_sched.is_day_off, false) or v_shift.shift_type = 'OFF' then
    v_status := 'DAY_OFF';
  elsif v_first_in is null and v_last_out is null then
    v_status := 'ABSENT';
  elsif v_first_in is null then
    v_status := 'MISSING_IN';
  elsif v_last_out is null then
    v_status := 'MISSING_OUT';
  else
    v_status := 'PRESENT';
  end if;

  if v_first_in is not null and v_last_out is not null then
    v_work := greatest(0, (extract(epoch from (v_last_out - v_first_in)) / 60)::int
                          - coalesce(v_shift.break_minutes, 0));
  end if;

  if v_planned_start is not null and v_first_in is not null then
    v_late := greatest(0, (extract(epoch from (v_first_in - v_planned_start)) / 60)::int
                          - coalesce(v_shift.late_grace_min, 0));
    if v_late > 0 and v_status = 'PRESENT' then v_status := 'LATE'; end if;
  end if;

  if v_planned_end is not null and v_last_out is not null then
    v_early := greatest(0, (extract(epoch from (v_planned_end - v_last_out)) / 60)::int
                           - coalesce(v_shift.early_grace_min, 0));
    v_ot    := greatest(0, (extract(epoch from (v_last_out - v_planned_end)) / 60)::int);
    if not coalesce(v_shift.is_ot_eligible, true) then v_ot := 0; end if;
  end if;

  insert into attendance_daily (
    org_id, employee_id, facility_id, work_date, shift_id, first_in, last_out,
    work_minutes, late_minutes, early_leave_minutes, ot_minutes,
    break_minutes, status, leave_request_id, calculated_at, created_by
  ) values (
    v_org, p_employee_id, v_facility, p_date, v_shift.id, v_first_in, v_last_out,
    v_work, v_late, v_early, v_ot,
    coalesce(v_shift.break_minutes,0), v_status, v_leave_id, now(), fn_current_user_id()
  )
  on conflict (employee_id, work_date) do update set
    facility_id = excluded.facility_id,
    shift_id    = excluded.shift_id,
    first_in    = excluded.first_in,
    last_out    = excluded.last_out,
    work_minutes = excluded.work_minutes,
    late_minutes = excluded.late_minutes,
    early_leave_minutes = excluded.early_leave_minutes,
    ot_minutes  = excluded.ot_minutes,
    break_minutes = excluded.break_minutes,
    status      = excluded.status,
    leave_request_id = excluded.leave_request_id,
    calculated_at = now(),
    updated_at  = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- คำนวณทั้งองค์กรในช่วงวันที่ (ใช้กับ trigger รายวัน/ปิดงวด)
create or replace function fn_recalc_attendance_range(
  p_org_id uuid, p_from date, p_to date, p_facility_id uuid default null)
returns int
language plpgsql
as $$
declare v_count int := 0; r record; d date;
begin
  for r in
    select v.employee_id, v.facility_id
    from v_employee_current v
    where v.org_id = p_org_id
      and (p_facility_id is null or v.facility_id = p_facility_id)
      and v.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
  loop
    d := p_from;
    while d <= p_to loop
      perform fn_recalc_attendance(r.employee_id, d);
      v_count := v_count + 1;
      d := d + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;
