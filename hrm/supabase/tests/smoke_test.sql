-- =============================================================================
-- HRM :: smoke_test.sql
-- ทดสอบเส้นทางหลัก: รับสมัคร -> บรรจุ -> ลงเวลา -> ลา -> เลื่อนตำแหน่ง ->
--                    เงินเดือน -> ประเมิน -> พ้นสภาพ -> audit
-- รันหลังจากลง 01..14 แล้ว:  psql -d <db> -v ON_ERROR_STOP=1 -f smoke_test.sql
-- =============================================================================
\set ORG '22222222-0000-0000-0000-000000000001'
\set FAC '33333333-0000-0000-0000-000000000001'
\set DEPT '44444444-0000-0000-0000-000000000002'

begin;

select fn_set_context(null, :'ORG'::uuid);

-- 1) ผู้สมัคร + ใบสมัคร --------------------------------------------------------
insert into job_postings (id, org_id, facility_id, department_id, position_id, title,
                          employment_type, openings, open_date, close_date, status, posting_no)
select '77777777-0000-0000-0000-000000000001', :'ORG'::uuid, :'FAC'::uuid, :'DEPT'::uuid,
       p.id, 'รับสมัครพยาบาลวิชาชีพ', 'CIVIL_SERVANT', 2,
       current_date - 30, current_date + 5, 'OPEN', 'ปก.001/2569'
from positions p where p.org_id = :'ORG'::uuid and p.code = 'RN';

insert into applicants (id, org_id, national_id, title_th, first_name_th, last_name_th,
                        gender, birth_date, phone, email, education, experience)
values ('88888888-0000-0000-0000-000000000001', :'ORG'::uuid, null, 'นางสาว','สมหญิง','ใจดี',
        'F','1995-05-20','0812345678','somying@example.com',
        '[{"level":"BACHELOR","degree":"พยาบาลศาสตรบัณฑิต","major":"พยาบาลศาสตร์","institute":"ม.ตัวอย่าง","year":"2560","gpa":"3.25"}]'::jsonb,
        '[{"organization":"รพ.เอกชนแห่งหนึ่ง","position":"พยาบาลวิชาชีพ","start_date":"2017-06-01","end_date":"2025-09-30","duty":"หอผู้ป่วยใน"}]'::jsonb);

insert into applications (id, org_id, posting_id, applicant_id, application_no, stage, total_score, rank_no)
values ('99999999-0000-0000-0000-000000000001', :'ORG'::uuid,
        '77777777-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000001',
        'สอบ-0001','SELECTED', 87.5, 1);

-- 2) บรรจุ ---------------------------------------------------------------------
select fn_hire_applicant(
  p_application_id  => '99999999-0000-0000-0000-000000000001'::uuid,
  p_emp_code        => 'EMP0001',
  p_hire_date       => (current_date - 400)::date,
  p_facility_id     => :'FAC'::uuid,
  p_department_id   => :'DEPT'::uuid,
  p_position_id     => (select id from positions  where org_id = :'ORG'::uuid and code='RN'),
  p_job_grade_id    => (select id from job_grades where org_id = :'ORG'::uuid and code='P1'),
  p_base_salary     => 18000::numeric,
  p_supervisor_id   => null::uuid,
  p_employment_type => 'CIVIL_SERVANT',
  p_probation_months=> 4) as new_employee_id \gset

\echo '--- ผลการบรรจุ ---'
select emp_code, first_name_th, last_name_th, employment_status, hire_date, retirement_date
from employees where id = :'new_employee_id'::uuid;

select 'assignment' as t, position_id is not null as has_position, effective_to is null as is_current
from employment_assignments where employee_id = :'new_employee_id'::uuid;

select 'education rows' as t, count(*) from employee_educations where employee_id = :'new_employee_id'::uuid;
select 'experience rows' as t, count(*) from employee_experiences where employee_id = :'new_employee_id'::uuid;

-- ผ่านทดลองงาน
update employees set employment_status = 'ACTIVE' where id = :'new_employee_id'::uuid;

-- 3) ผูกกะทำงาน + ลงเวลา -------------------------------------------------------
update employment_assignments
   set work_shift_id = (select id from work_shifts where org_id = :'ORG'::uuid and code = 'OFFICE')
 where employee_id = :'new_employee_id'::uuid and effective_to is null;

-- วันทำการล่าสุด (จันทร์-ศุกร์)
select (case when extract(isodow from current_date) in (6,7)
             then current_date - extract(isodow from current_date)::int + 5
             else current_date end)::date as workday \gset

insert into time_logs (org_id, employee_id, facility_id, log_time, direction, method)
values (:'ORG'::uuid, :'new_employee_id'::uuid, :'FAC'::uuid,
        (:'workday'::date + time '08:52') at time zone 'Asia/Bangkok', 'IN', 'WEB'),
       (:'ORG'::uuid, :'new_employee_id'::uuid, :'FAC'::uuid,
        (:'workday'::date + time '17:35') at time zone 'Asia/Bangkok', 'OUT', 'WEB');

select fn_recalc_attendance(:'new_employee_id'::uuid, :'workday'::date);

\echo '--- สรุปเวลารายวัน (มาสาย 22 นาที หัก grace 15 = 7) ---'
select work_date, status, late_minutes, early_leave_minutes, ot_minutes, work_minutes
from attendance_daily where employee_id = :'new_employee_id'::uuid;

-- 4) สิทธิวันลา + ใบลา ---------------------------------------------------------
select fn_generate_leave_entitlements(:'ORG'::uuid, fn_fiscal_year(current_date)) as entitlement_rows;

\echo '--- สิทธิลาพักผ่อนคงเหลือก่อนลา ---'
select leave_type_code, total_days, used_days, remaining_days
from v_leave_balance
where employee_id = :'new_employee_id'::uuid and leave_type_code = 'VACATION';

insert into leave_requests (id, org_id, facility_id, employee_id, leave_type_id, period_year,
                            start_date, end_date, reason, status)
values ('aaaaaaaa-0000-0000-0000-000000000001', :'ORG'::uuid, :'FAC'::uuid,
        :'new_employee_id'::uuid,
        (select id from leave_types where org_id = :'ORG'::uuid and code = 'VACATION'),
        fn_fiscal_year(current_date),
        current_date + 7, current_date + 9, 'พักผ่อนประจำปี', 'DRAFT');

select request_no, status, total_days
from fn_submit_leave_request('aaaaaaaa-0000-0000-0000-000000000001'::uuid);

-- ต้องกันการลาซ้อน
do $$
begin
  insert into leave_requests (org_id, facility_id, employee_id, leave_type_id, period_year,
                              start_date, end_date, reason, status)
  values ('22222222-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
          (select id from employees where emp_code='EMP0001'),
          (select id from leave_types where code='PERSONAL' and org_id='22222222-0000-0000-0000-000000000001'),
          fn_fiscal_year(current_date), current_date + 8, current_date + 8, 'ทดสอบซ้อน', 'DRAFT');
  perform fn_submit_leave_request(
    (select id from leave_requests where reason = 'ทดสอบซ้อน'));
  raise exception 'FAIL: ระบบยอมให้ลาซ้อนวัน';
exception
  when others then
    if position('ซ้อนทับ' in sqlerrm) > 0 then
      raise notice 'PASS: กันการลาซ้อนวันได้ (%)', sqlerrm;
    else
      raise;
    end if;
end$$;

-- อนุมัติ
insert into app_users (id, org_id, email, display_name)
values ('bbbbbbbb-0000-0000-0000-000000000001', :'ORG'::uuid, 'boss@example.com', 'ผู้อำนวยการ')
on conflict do nothing;

select status, approved_at is not null as approved
from fn_act_leave_request('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'APPROVE',
                          'bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'อนุมัติ');

\echo '--- สิทธิลาพักผ่อนคงเหลือหลังลา ---'
select leave_type_code, total_days, used_days, remaining_days
from v_leave_balance
where employee_id = :'new_employee_id'::uuid and leave_type_code = 'VACATION';

-- 5) เลื่อนตำแหน่ง --------------------------------------------------------------
insert into career_movements (id, org_id, employee_id, movement_type, effective_date,
                              from_position_id, from_salary,
                              to_position_id, to_grade_id, to_salary,
                              reason, order_no, order_date, status)
select 'cccccccc-0000-0000-0000-000000000001', :'ORG'::uuid, :'new_employee_id'::uuid,
       'PROMOTION', current_date,
       a.position_id, a.base_salary,
       a.position_id,
       (select id from job_grades where org_id = :'ORG'::uuid and code = 'P2'),
       24000, 'เลื่อนระดับชำนาญการ', 'คส.001/2569', current_date, 'APPROVED'
from employment_assignments a
where a.employee_id = :'new_employee_id'::uuid and a.effective_to is null;

select (fn_apply_career_movement('cccccccc-0000-0000-0000-000000000001'::uuid)).id is not null as movement_applied;

\echo '--- ประวัติการดำรงตำแหน่ง (ต้องมี 2 แถว) ---'
select effective_from, effective_to, base_salary, reason
from employment_assignments where employee_id = :'new_employee_id'::uuid
order by effective_from;

\echo '--- timeline เหตุการณ์ ---'
select event_type, event_date, title from employment_events
where employee_id = :'new_employee_id'::uuid order by event_date, id;

-- 6) เงินเดือน ------------------------------------------------------------------
insert into payroll_periods (id, org_id, code, name_th, period_year, period_month,
                             start_date, end_date, pay_date)
values ('dddddddd-0000-0000-0000-000000000001', :'ORG'::uuid, '2569-01','งวดเดือนตุลาคม 2568',
        2569, 10, date_trunc('month', current_date)::date,
        (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
        (date_trunc('month', current_date) + interval '1 month - 5 days')::date)
on conflict do nothing;

insert into payroll_runs (id, org_id, period_id, run_no, run_type)
values ('eeeeeeee-0000-0000-0000-000000000001', :'ORG'::uuid,
        'dddddddd-0000-0000-0000-000000000001', 'RUN-001', 'REGULAR');

insert into employee_pay_components (org_id, employee_id, component_id, amount)
select :'ORG'::uuid, :'new_employee_id'::uuid, id, 24000
from pay_components where org_id = :'ORG'::uuid and code = 'BASE';

\echo '--- ข้อมูลตั้งต้นการคำนวณเงินเดือน ---'
select emp_code, full_name, base_salary, work_days, absent_days,
       jsonb_array_length(components) as component_count
from fn_payroll_input('eeeeeeee-0000-0000-0000-000000000001'::uuid);

insert into payroll_slips (org_id, run_id, employee_id, emp_code, full_name, base_salary,
                           gross_earning, total_deduction, net_pay, employer_cost)
select :'ORG'::uuid, 'eeeeeeee-0000-0000-0000-000000000001', :'new_employee_id'::uuid,
       'EMP0001','นางสาวสมหญิง ใจดี', 24000, 24000, 1950, 22050, 750;

select headcount, total_net, status
from fn_payroll_finalize('eeeeeeee-0000-0000-0000-000000000001'::uuid, 'CALCULATED');

-- 7) ประเมินผล ------------------------------------------------------------------
insert into appraisal_cycles (id, org_id, code, name_th, fiscal_year, round_no, start_date, end_date)
values ('ffffffff-0000-0000-0000-000000000001', :'ORG'::uuid, 'FY69R1',
        'รอบที่ 1/2569', 2569, 1, current_date - 180, current_date);

insert into appraisals (id, org_id, cycle_id, employee_id, form_id, status)
values ('ffffffff-0000-0000-0000-000000000002', :'ORG'::uuid,
        'ffffffff-0000-0000-0000-000000000001', :'new_employee_id'::uuid,
        '55555555-0000-0000-0000-000000000001', 'APPRAISED');

insert into appraisal_scores (appraisal_id, section, item_title, weight_percent, max_score, final_score)
select 'ffffffff-0000-0000-0000-000000000002', i.section, i.title, i.weight_percent, i.max_score,
       case when i.section = 'KPI' then 4.5 else 4.0 end
from appraisal_form_items i where i.form_id = '55555555-0000-0000-0000-000000000001';

\echo '--- คะแนนประเมิน (KPI 90 x70% + สมรรถนะ 80 x30% = 87.00 = ดีมาก) ---'
select kpi_score, competency_score, total_score, rating_code, rating_label
from fn_calc_appraisal_score('ffffffff-0000-0000-0000-000000000002'::uuid);

-- 8) Dashboard ------------------------------------------------------------------
\echo '--- Dashboard summary ---'
select jsonb_pretty(fn_dashboard_summary(:'ORG'::uuid));

-- 9) พ้นสภาพ --------------------------------------------------------------------
insert into separation_requests (id, org_id, employee_id, separation_type, last_working_date,
                                 effective_date, reason_detail, status)
values ('a1a1a1a1-0000-0000-0000-000000000001', :'ORG'::uuid, :'new_employee_id'::uuid,
        'RESIGN', current_date + 30, current_date + 30, 'ย้ายภูมิลำเนา', 'APPROVED');

insert into clearance_items (separation_id, category, item_name, status)
values ('a1a1a1a1-0000-0000-0000-000000000001','ASSET','คืนบัตรประจำตัวเจ้าหน้าที่','PENDING');

-- ต้องเคลียร์ให้ครบก่อน
do $$
begin
  perform fn_complete_separation('a1a1a1a1-0000-0000-0000-000000000001'::uuid);
  raise exception 'FAIL: ระบบยอมให้พ้นสภาพทั้งที่ยังมีของค้างคืน';
exception when others then
  if position('ค้างเคลียร์' in sqlerrm) > 0 then
    raise notice 'PASS: บังคับเคลียร์ก่อนพ้นสภาพ (%)', sqlerrm;
  else raise; end if;
end$$;

update clearance_items set status = 'CLEARED', cleared_at = now()
 where separation_id = 'a1a1a1a1-0000-0000-0000-000000000001';

select emp_code, employment_status, separation_date
from fn_complete_separation('a1a1a1a1-0000-0000-0000-000000000001'::uuid);

select 'assignment closed' as t, count(*) = 0 as ok
from employment_assignments where employee_id = :'new_employee_id'::uuid and effective_to is null;

-- 10) Audit ---------------------------------------------------------------------
\echo '--- Audit log ของบุคลากรรายนี้ ---'
select table_name, action, array_length(changed_fields,1) as n_changed
from audit_logs where record_id = :'new_employee_id'::uuid order by id;

\echo '--- ประวัติแก้ไข (fn_record_history) ---'
select occurred_at::date, action, changed_fields
from fn_record_history('employees', :'new_employee_id'::uuid, 10);

do $$
begin
  update audit_logs set action = 'INSERT' where id = (select min(id) from audit_logs);
  raise exception 'FAIL: audit_logs ถูกแก้ไขได้';
exception when others then
  if position('append-only' in sqlerrm) > 0 then
    raise notice 'PASS: audit_logs แก้ไขไม่ได้';
  else raise; end if;
end$$;

rollback;
