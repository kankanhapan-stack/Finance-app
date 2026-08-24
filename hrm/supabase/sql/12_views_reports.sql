-- =============================================================================
-- HRM :: 12_views_reports.sql
-- โมดูล 01 Dashboard + โมดูล 15 Reports
-- View/RPC สำหรับ KPI กำลังคน และรายงานมาตรฐาน
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. อัตรากำลัง: กรอบ vs คนจริง vs อัตราว่าง
-- -----------------------------------------------------------------------------
create or replace view v_headcount_by_unit as
with actual as (
  select v.org_id, v.facility_id, v.department_id, v.position_id, count(*)::int as actual_count
  from v_employee_current v
  where v.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
  group by 1,2,3,4
)
select
  coalesce(ps.org_id, a.org_id)               as org_id,
  coalesce(ps.facility_id, a.facility_id)     as facility_id,
  f.name_th                                   as facility_name,
  coalesce(ps.department_id, a.department_id) as department_id,
  d.name_th                                   as department_name,
  coalesce(ps.position_id, a.position_id)     as position_id,
  p.name_th                                   as position_name,
  p.job_family,
  ps.fiscal_year,
  coalesce(ps.planned_count, 0)               as planned_count,
  coalesce(a.actual_count, 0)                 as actual_count,
  coalesce(ps.planned_count, 0) - coalesce(a.actual_count, 0) as vacant_count
from position_slots ps
full outer join actual a
  on a.org_id = ps.org_id
 and a.facility_id is not distinct from ps.facility_id
 and a.department_id is not distinct from ps.department_id
 and a.position_id = ps.position_id
left join facilities  f on f.id = coalesce(ps.facility_id, a.facility_id)
left join departments d on d.id = coalesce(ps.department_id, a.department_id)
left join positions   p on p.id = coalesce(ps.position_id, a.position_id);

-- -----------------------------------------------------------------------------
-- 2. โครงสร้างประชากรบุคลากร (อายุ/เพศ/ประเภทการจ้าง/อายุงาน)
-- -----------------------------------------------------------------------------
create or replace view v_workforce_demographics as
select
  v.org_id,
  v.facility_id,
  v.facility_name,
  v.department_id,
  v.department_name,
  v.employment_type,
  v.gender,
  case
    when v.age_years < 30 then '< 30'
    when v.age_years between 30 and 39 then '30-39'
    when v.age_years between 40 and 49 then '40-49'
    when v.age_years between 50 and 59 then '50-59'
    else '60+' end                            as age_band,
  case
    when v.hire_date is null then 'ไม่ระบุ'
    when age(current_date, v.hire_date) < interval '1 year'  then '< 1 ปี'
    when age(current_date, v.hire_date) < interval '5 years' then '1-4 ปี'
    when age(current_date, v.hire_date) < interval '10 years' then '5-9 ปี'
    when age(current_date, v.hire_date) < interval '20 years' then '10-19 ปี'
    else '20 ปีขึ้นไป' end                     as service_band,
  count(*)::int as headcount,
  avg(v.base_salary)::numeric(14,2) as avg_salary
from v_employee_current v
where v.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
group by 1,2,3,4,5,6,7,8,9;

-- -----------------------------------------------------------------------------
-- 3. อัตราการเข้า-ออก (turnover) รายปีงบประมาณ
-- -----------------------------------------------------------------------------
create or replace view v_turnover_by_year as
with hires as (
  select org_id, fn_fiscal_year(hire_date) as fy, count(*)::int as hire_count
  from employees where hire_date is not null group by 1,2
),
seps as (
  select org_id, fn_fiscal_year(separation_date) as fy, count(*)::int as separation_count
  from employees where separation_date is not null group by 1,2
),
actives as (
  select org_id, fy, count(*)::int as headcount_end
  from (
    select e.org_id, g.fy
    from employees e
    cross join lateral (
      select generate_series(
        fn_fiscal_year(coalesce(e.hire_date, current_date)),
        fn_fiscal_year(coalesce(e.separation_date, current_date))) as fy
    ) g
  ) x
  group by 1,2
)
select
  coalesce(h.org_id, s.org_id, a.org_id) as org_id,
  coalesce(h.fy, s.fy, a.fy)             as fiscal_year,
  coalesce(h.hire_count, 0)              as hire_count,
  coalesce(s.separation_count, 0)        as separation_count,
  coalesce(a.headcount_end, 0)           as headcount,
  case when coalesce(a.headcount_end,0) > 0
       then round(coalesce(s.separation_count,0)::numeric / a.headcount_end * 100, 2)
       else 0 end                        as turnover_percent
from hires h
full outer join seps    s on s.org_id = h.org_id and s.fy = h.fy
full outer join actives a on a.org_id = coalesce(h.org_id, s.org_id) and a.fy = coalesce(h.fy, s.fy);

-- -----------------------------------------------------------------------------
-- 4. สรุปการมาปฏิบัติงานรายเดือน
-- -----------------------------------------------------------------------------
create or replace view v_attendance_monthly as
select
  a.org_id,
  a.facility_id,
  a.employee_id,
  v.emp_code,
  v.full_name_th,
  v.department_name,
  date_trunc('month', a.work_date)::date as month_start,
  count(*) filter (where a.status in ('PRESENT','LATE','HALF_DAY','TRIP','TRAINING'))::int as present_days,
  count(*) filter (where a.status = 'LATE')::int    as late_days,
  count(*) filter (where a.status = 'ABSENT')::int  as absent_days,
  count(*) filter (where a.status = 'LEAVE')::int   as leave_days,
  count(*) filter (where a.status in ('MISSING_IN','MISSING_OUT'))::int as incomplete_days,
  coalesce(sum(a.late_minutes),0)::int              as late_minutes,
  coalesce(sum(a.early_leave_minutes),0)::int       as early_leave_minutes,
  coalesce(sum(a.ot_minutes),0)::int                as ot_minutes,
  round(coalesce(sum(a.work_minutes),0) / 60.0, 2)  as work_hours
from attendance_daily a
join v_employee_current v on v.employee_id = a.employee_id
group by 1,2,3,4,5,6,7;

-- -----------------------------------------------------------------------------
-- 5. สรุปการลารายปีงบประมาณ (ต่อคน ต่อประเภท)
-- -----------------------------------------------------------------------------
create or replace view v_leave_summary as
select
  lr.org_id,
  lr.employee_id,
  v.emp_code,
  v.full_name_th,
  v.facility_name,
  v.department_name,
  lr.period_year,
  lt.code    as leave_type_code,
  lt.name_th as leave_type_name,
  count(*) filter (where lr.status = 'APPROVED')::int      as approved_count,
  coalesce(sum(lr.total_days) filter (where lr.status = 'APPROVED'), 0)::numeric(6,2) as approved_days,
  count(*) filter (where lr.status = 'PENDING')::int       as pending_count,
  count(*) filter (where lr.status = 'REJECTED')::int      as rejected_count
from leave_requests lr
join leave_types lt on lt.id = lr.leave_type_id
join v_employee_current v on v.employee_id = lr.employee_id
group by 1,2,3,4,5,6,7,8,9;

-- -----------------------------------------------------------------------------
-- 6. สรุปค่าใช้จ่ายบุคลากรรายงวด
-- -----------------------------------------------------------------------------
create or replace view v_payroll_cost as
select
  r.org_id,
  r.facility_id,
  pp.period_year,
  pp.period_month,
  pp.code            as period_code,
  r.id               as run_id,
  r.run_type,
  r.status,
  r.headcount,
  r.total_earning,
  r.total_deduction,
  r.total_net,
  r.total_employer_cost,
  (r.total_earning + r.total_employer_cost) as total_cost,
  pp.pay_date
from payroll_runs r
join payroll_periods pp on pp.id = r.period_id;

-- -----------------------------------------------------------------------------
-- 7. สรุปการฝึกอบรมรายปี
-- -----------------------------------------------------------------------------
create or replace view v_training_summary as
select
  tr.org_id,
  tr.employee_id,
  v.emp_code,
  v.full_name_th,
  v.facility_name,
  v.department_name,
  fn_fiscal_year(coalesce(ts.start_date, current_date)) as fiscal_year,
  count(*) filter (where tr.status in ('ATTENDED','COMPLETED'))::int as course_count,
  coalesce(sum(tc.duration_hours) filter (where tr.status in ('ATTENDED','COMPLETED')), 0)::numeric(8,2) as total_hours,
  coalesce(sum(tc.cpe_credits)   filter (where tr.status in ('ATTENDED','COMPLETED')), 0)::numeric(8,2) as total_credits,
  coalesce(sum(tr.cost), 0)::numeric(14,2) as total_cost
from training_registrations tr
join training_sessions ts on ts.id = tr.session_id
join training_courses  tc on tc.id = ts.course_id
join v_employee_current v on v.employee_id = tr.employee_id
group by 1,2,3,4,5,6,7;

-- -----------------------------------------------------------------------------
-- 8. รายการที่ต้องติดตาม (compliance / expiring)
-- -----------------------------------------------------------------------------
create or replace view v_compliance_alerts as
-- ใบประกอบวิชาชีพใกล้หมดอายุ
select
  e.org_id, e.id as employee_id, e.emp_code, fn_employee_fullname(e.*) as full_name_th,
  'LICENSE_EXPIRING'::text as alert_type,
  l.license_type || ' เลขที่ ' || l.license_no as detail,
  l.expire_date as due_date,
  (l.expire_date - current_date) as days_remaining,
  case when l.expire_date < current_date then 'CRITICAL'
       when l.expire_date < current_date + 30 then 'HIGH'
       else 'MEDIUM' end as severity
from employee_licenses l
join employees e on e.id = l.employee_id
where l.status = 'VALID' and l.expire_date is not null
  and l.expire_date <= current_date + interval '90 days'
  and e.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')

union all
-- ทดลองงานครบกำหนด
select
  e.org_id, e.id, e.emp_code, fn_employee_fullname(e.*),
  'PROBATION_DUE', 'ครบกำหนดทดลองปฏิบัติงาน',
  e.probation_end_date, (e.probation_end_date - current_date),
  case when e.probation_end_date < current_date then 'HIGH' else 'MEDIUM' end
from employees e
where e.employment_status = 'PROBATION' and e.probation_end_date is not null
  and e.probation_end_date <= current_date + interval '30 days'

union all
-- เกษียณอายุ
select
  e.org_id, e.id, e.emp_code, fn_employee_fullname(e.*),
  'RETIREMENT_DUE', 'ครบเกษียณอายุราชการ',
  e.retirement_date, (e.retirement_date - current_date),
  case when e.retirement_date <= current_date + 90 then 'HIGH' else 'MEDIUM' end
from employees e
where e.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
  and e.retirement_date is not null
  and e.retirement_date <= current_date + interval '180 days'

union all
-- อบรมภาคบังคับที่หมดอายุ
select
  e.org_id, e.id, e.emp_code, fn_employee_fullname(e.*),
  'TRAINING_EXPIRING', tr.course_name,
  tr.expire_date, (tr.expire_date - current_date),
  case when tr.expire_date < current_date then 'HIGH' else 'LOW' end
from training_records tr
join employees e on e.id = tr.employee_id
where tr.expire_date is not null
  and tr.expire_date <= current_date + interval '60 days'
  and e.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')

union all
-- ตรวจสุขภาพประจำปียังไม่ได้ทำ
select
  e.org_id, e.id, e.emp_code, fn_employee_fullname(e.*),
  'HEALTH_CHECKUP_DUE', 'ยังไม่ได้ตรวจสุขภาพประจำปี ' || (extract(year from current_date)::int + 543),
  make_date(extract(year from current_date)::int, 12, 31),
  (make_date(extract(year from current_date)::int, 12, 31) - current_date),
  'LOW'
from employees e
where e.employment_status in ('ACTIVE','PROBATION')
  and not exists (select 1 from health_checkups h
                  where h.employee_id = e.id
                    and h.checkup_year = extract(year from current_date)::int);

-- -----------------------------------------------------------------------------
-- 9. RPC : ตัวเลข KPI สำหรับหน้า Dashboard
-- -----------------------------------------------------------------------------
create or replace function fn_dashboard_summary(
  p_org_id uuid, p_facility_id uuid default null)
returns jsonb
language plpgsql stable
as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'as_of', current_date,
    'fiscal_year', fn_fiscal_year(current_date),

    'headcount', (
      select jsonb_build_object(
        'total',      count(*),
        'active',     count(*) filter (where employment_status = 'ACTIVE'),
        'probation',  count(*) filter (where employment_status = 'PROBATION'),
        'on_leave',   count(*) filter (where employment_status = 'ON_LEAVE'),
        'male',       count(*) filter (where gender = 'M'),
        'female',     count(*) filter (where gender = 'F'),
        'avg_age',    round(avg(age_years), 1))
      from v_employee_current
      where org_id = p_org_id
        and (p_facility_id is null or facility_id = p_facility_id)
        and employment_status in ('ACTIVE','PROBATION','ON_LEAVE')),

    'establishment', (
      select jsonb_build_object(
        'planned', coalesce(sum(planned_count), 0),
        'actual',  coalesce(sum(actual_count), 0),
        'vacant',  coalesce(sum(greatest(vacant_count, 0)), 0))
      from v_headcount_by_unit
      where org_id = p_org_id
        and (p_facility_id is null or facility_id = p_facility_id)
        and (fiscal_year is null or fiscal_year = fn_fiscal_year(current_date))),

    'movement_this_fy', (
      select jsonb_build_object(
        'hired',    count(*) filter (where fn_fiscal_year(hire_date) = fn_fiscal_year(current_date)),
        'separated',count(*) filter (where fn_fiscal_year(separation_date) = fn_fiscal_year(current_date)))
      from employees where org_id = p_org_id),

    'attendance_today', (
      select jsonb_build_object(
        'present', count(*) filter (where status in ('PRESENT','LATE','HALF_DAY')),
        'late',    count(*) filter (where status = 'LATE'),
        'absent',  count(*) filter (where status = 'ABSENT'),
        'leave',   count(*) filter (where status = 'LEAVE'))
      from attendance_daily
      where org_id = p_org_id and work_date = current_date
        and (p_facility_id is null or facility_id = p_facility_id)),

    'pending', jsonb_build_object(
      'leave_requests',  (select count(*) from leave_requests
                          where org_id = p_org_id and status = 'PENDING'),
      'time_adjustments',(select count(*) from time_adjustments
                          where org_id = p_org_id and status = 'PENDING'),
      'benefit_claims',  (select count(*) from benefit_claims
                          where org_id = p_org_id and status in ('SUBMITTED','REVIEWING')),
      'doc_requests',    (select count(*) from document_requests
                          where org_id = p_org_id and status = 'PENDING'),
      'separations',     (select count(*) from separation_requests
                          where org_id = p_org_id and status = 'PENDING'),
      'approvals',       (select count(*) from approval_requests
                          where org_id = p_org_id and status = 'PENDING')),

    'recruitment', (
      select jsonb_build_object(
        'open_postings', count(*) filter (where status = 'OPEN'),
        'applications',  (select count(*) from applications a
                          where a.org_id = p_org_id
                            and a.stage not in ('HIRED','REJECTED','WITHDRAWN')))
      from job_postings where org_id = p_org_id),

    'alerts', (
      select jsonb_build_object(
        'critical', count(*) filter (where severity = 'CRITICAL'),
        'high',     count(*) filter (where severity = 'HIGH'),
        'total',    count(*))
      from v_compliance_alerts where org_id = p_org_id),

    'payroll_last', (
      select jsonb_build_object(
        'period', period_code, 'headcount', headcount,
        'total_net', total_net, 'status', status)
      from v_payroll_cost
      where org_id = p_org_id
      order by period_year desc, period_month desc
      limit 1)
  ) into v;

  return v;
end;
$$;

comment on function fn_dashboard_summary is 'ตัวเลขสรุปสำหรับหน้า Dashboard (โมดูล 01)';

-- -----------------------------------------------------------------------------
-- 10. RPC : กราฟกำลังคนรายเดือน 12 เดือนย้อนหลัง
-- -----------------------------------------------------------------------------
create or replace function fn_headcount_trend(p_org_id uuid, p_months int default 12)
returns table (month_start date, headcount int, hired int, separated int)
language sql stable
as $$
  with months as (
    select (date_trunc('month', current_date) - (n || ' months')::interval)::date as m
    from generate_series(0, greatest(p_months,1) - 1) n
  )
  select
    m.m,
    (select count(*)::int from employees e
      where e.org_id = p_org_id
        and e.hire_date <= (m.m + interval '1 month' - interval '1 day')::date
        and (e.separation_date is null
             or e.separation_date > (m.m + interval '1 month' - interval '1 day')::date)),
    (select count(*)::int from employees e
      where e.org_id = p_org_id and date_trunc('month', e.hire_date) = m.m),
    (select count(*)::int from employees e
      where e.org_id = p_org_id and date_trunc('month', e.separation_date) = m.m)
  from months m
  order by m.m;
$$;
