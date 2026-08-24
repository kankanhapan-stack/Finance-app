-- =============================================================================
-- HRM :: 13_rls.sql
-- Row Level Security
--
-- โมเดลการเข้าถึง 2 ชั้น:
--   ชั้นที่ 1 (วันนี้)  Apps Script เรียก Supabase ด้วย service_role key
--                       -> ข้าม RLS แต่ Apps Script บังคับสิทธิเองใน Auth.gs
--   ชั้นที่ 2 (ต่อยอด)  เปิดเว็บ/มือถือให้บุคลากรเข้าตรงด้วย Supabase Auth
--                       -> RLS ด้านล่างทำงานทันทีโดยไม่ต้องแก้โค้ด
--
-- JWT claim ที่ใช้:  app_metadata.org_id, app_metadata.employee_id,
--                    app_metadata.facility_ids[], app_metadata.perms[]
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: อ่าน claim จาก JWT
-- -----------------------------------------------------------------------------
create or replace function auth_org_id()
returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,org_id}', ''),
    nullif(current_setting('app.current_org_id', true), '')
  )::uuid;
$$;

create or replace function auth_employee_id()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,employee_id}', '')::uuid;
$$;

create or replace function auth_facility_ids()
returns uuid[] language sql stable as $$
  select coalesce(
    array(select jsonb_array_elements_text(
      coalesce(current_setting('request.jwt.claims', true)::jsonb #> '{app_metadata,facility_ids}',
               '[]'::jsonb))::uuid),
    '{}')::uuid[];
$$;

create or replace function auth_has_perm(p_perm text)
returns boolean language sql stable as $$
  select coalesce(
    current_setting('request.jwt.claims', true)::jsonb #> '{app_metadata,perms}' ? p_perm,
    false)
    or coalesce(
    current_setting('request.jwt.claims', true)::jsonb #> '{app_metadata,perms}' ? '*',
    false);
$$;

-- เข้าถึงข้อมูลของบุคลากรคนนี้ได้หรือไม่ (ตนเอง / ลูกน้อง / มีสิทธิ HR)
create or replace function auth_can_see_employee(p_employee_id uuid)
returns boolean language sql stable as $$
  select
    -- HR / ผู้ดูแลระบบ
    auth_has_perm('employee.read_all')
    -- ตนเอง
    or p_employee_id = auth_employee_id()
    -- อยู่ในสถานบริการที่ตนดูแล
    or exists (
      select 1 from employment_assignments a
      where a.employee_id = p_employee_id
        and a.effective_to is null
        and a.facility_id = any(auth_facility_ids())
        and auth_has_perm('employee.read_facility'))
    -- เป็นผู้บังคับบัญชาโดยตรง
    or exists (
      select 1 from employment_assignments a
      where a.employee_id = p_employee_id
        and a.effective_to is null
        and a.supervisor_id = auth_employee_id());
$$;

-- -----------------------------------------------------------------------------
-- เปิด RLS ทุกตารางใน public (ยกเว้น master ที่อ่านได้ทั้งองค์กร)
-- -----------------------------------------------------------------------------
-- หมายเหตุ: ตาราง log ไม่ใช้ FORCE เพราะ trigger fn_audit_trigger (SECURITY DEFINER)
-- ต้องเขียนลงตารางเหล่านี้ได้ในนามเจ้าของตาราง
do $$
declare
  r record;
  log_tables text[] := array['audit_logs','data_access_logs','login_logs',
                             'number_sequences','user_sessions'];
begin
  for r in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', r.table_name);
    if not (r.table_name = any(log_tables)) then
      execute format('alter table %I force row level security', r.table_name);
    else
      execute format('alter table %I no force row level security', r.table_name);
    end if;
  end loop;
end$$;

-- service_role ข้ามทุกนโยบาย (Apps Script ใช้ key นี้)
do $$
declare r record;
begin
  for r in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('drop policy if exists p_service_all on %I', r.table_name);
    execute format(
      'create policy p_service_all on %I for all
       to service_role using (true) with check (true)', r.table_name);
  end loop;
end$$;

-- -----------------------------------------------------------------------------
-- นโยบายสำหรับผู้ใช้ที่ล็อกอินตรง (role: authenticated)
-- -----------------------------------------------------------------------------

-- 1) ตาราง master ระดับองค์กร: อ่านได้ทั้งองค์กร แก้ได้เฉพาะผู้มีสิทธิ org.manage
do $$
declare t text;
  master_tables text[] := array[
    'organizations','facilities','departments','positions','job_grades','position_slots',
    'work_shifts','holidays','leave_types','pay_components','benefit_plans',
    'training_courses','competencies','document_templates','appraisal_forms',
    'appraisal_cycles','career_paths','approval_flows','approval_flow_steps',
    'salary_scales','contribution_rates','tax_brackets','roles','permissions','role_permissions'];
begin
  foreach t in array master_tables loop
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format('drop policy if exists p_master_read on %I', t);
      execute format('drop policy if exists p_master_write on %I', t);

      if exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name=t and column_name='org_id') then
        execute format(
          'create policy p_master_read on %I for select to authenticated
           using (org_id is null or org_id = auth_org_id())', t);
        execute format(
          'create policy p_master_write on %I for all to authenticated
           using (org_id = auth_org_id() and auth_has_perm(''org.manage''))
           with check (org_id = auth_org_id() and auth_has_perm(''org.manage''))', t);
      else
        execute format(
          'create policy p_master_read on %I for select to authenticated using (true)', t);
        execute format(
          'create policy p_master_write on %I for all to authenticated
           using (auth_has_perm(''org.manage'')) with check (auth_has_perm(''org.manage''))', t);
      end if;
    end if;
  end loop;
end$$;

-- 2) ตารางที่ผูกกับบุคลากร: เห็นเฉพาะข้อมูลที่ตนมีสิทธิเห็น
-- รูปแบบ 'ชื่อตาราง=โมดูลสิทธิ[=คอลัมน์อ้างบุคลากร]' -> สิทธิเขียนคือ '<โมดูล>.write'
-- ถ้าไม่ระบุคอลัมน์ ใช้ employee_id (ยกเว้นตาราง employees ใช้ id)
do $$
declare
  pair text; t text; m text; id_col text;
  emp_tables text[] := array[
    'employees=employee','employment_assignments=employee','employment_events=employee',
    'employee_educations=employee','employee_licenses=employee','employee_families=employee',
    'employee_experiences=employee','employee_contacts=employee','employee_files=employee',
    'employee_pay_components=payroll','salary_histories=payroll','employee_tax_profiles=payroll',
    'payroll_slips=payroll',
    'leave_entitlements=leave','leave_requests=leave',
    'attendance_daily=time','time_logs=time','work_schedules=time',
    'overtime_requests=time','time_adjustments=time','business_trips=time',
    'benefit_enrollments=benefit','benefit_claims=benefit','employee_loans=benefit',
    'health_checkups=health','employee_awards=benefit',
    'employee_kpis=performance','appraisals=performance',
    'development_plans=training','employee_competencies=training',
    'training_registrations=training','training_records=training',
    'career_movements=career','succession_plans=career=candidate_id',
    'document_requests=document','issued_documents=document',
    'discipline_cases=discipline','discipline_actions=discipline',
    'separation_requests=offboarding','onboarding_tasks=recruitment'];
begin
  foreach pair in array emp_tables loop
    t := split_part(pair, '=', 1);
    m := split_part(pair, '=', 2);
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      id_col := coalesce(nullif(split_part(pair, '=', 3), ''),
                         case when t = 'employees' then 'id' else 'employee_id' end);

      execute format('drop policy if exists p_emp_read on %I', t);
      execute format('drop policy if exists p_emp_write on %I', t);

      execute format(
        'create policy p_emp_read on %I for select to authenticated
         using (auth_can_see_employee(%I))', t, id_col);

      execute format(
        'create policy p_emp_write on %I for all to authenticated
         using (auth_has_perm(''%s.write'') and auth_can_see_employee(%I))
         with check (auth_has_perm(''%s.write'') and auth_can_see_employee(%I))',
        t, m, id_col, m, id_col);
    end if;
  end loop;
end$$;

-- 3) ข้อมูลอ่อนไหว: เงินเดือน / วินัย / สุขภาพ ต้องมีสิทธิเฉพาะ
drop policy if exists p_emp_read on payroll_slips;
create policy p_payroll_read on payroll_slips for select to authenticated
  using (employee_id = auth_employee_id() or auth_has_perm('payroll.read'));

drop policy if exists p_emp_read on discipline_cases;
create policy p_discipline_read on discipline_cases for select to authenticated
  using (auth_has_perm('discipline.read')
         or (employee_id = auth_employee_id() and not is_confidential));

drop policy if exists p_emp_read on health_checkups;
create policy p_health_read on health_checkups for select to authenticated
  using (employee_id = auth_employee_id() or auth_has_perm('health.read'));

drop policy if exists p_emp_read on employee_files;
create policy p_files_read on employee_files for select to authenticated
  using ((auth_can_see_employee(employee_id) and not is_confidential)
         or employee_id = auth_employee_id()
         or auth_has_perm('employee.read_confidential'));

-- 4) Audit log: อ่านได้เฉพาะผู้ตรวจสอบ, เขียนผ่าน trigger เท่านั้น
drop policy if exists p_audit_read on audit_logs;
create policy p_audit_read on audit_logs for select to authenticated
  using (org_id = auth_org_id() and auth_has_perm('audit.read'));

drop policy if exists p_access_read on data_access_logs;
create policy p_access_read on data_access_logs for select to authenticated
  using (org_id = auth_org_id() and auth_has_perm('audit.read')
         or subject_employee_id = auth_employee_id());   -- PDPA: เจ้าของข้อมูลดูได้ว่าใครเปิดดู

-- 5) ผู้ใช้/สิทธิ
drop policy if exists p_users_self on app_users;
create policy p_users_self on app_users for select to authenticated
  using (employee_id = auth_employee_id()
         or (org_id = auth_org_id() and auth_has_perm('user.read')));

drop policy if exists p_users_manage on app_users;
create policy p_users_manage on app_users for all to authenticated
  using (org_id = auth_org_id() and auth_has_perm('user.manage'))
  with check (org_id = auth_org_id() and auth_has_perm('user.manage'));

drop policy if exists p_notify_own on notifications;
create policy p_notify_own on notifications for all to authenticated
  using (employee_id = auth_employee_id()
         or user_id in (select id from app_users where employee_id = auth_employee_id()))
  with check (employee_id = auth_employee_id()
         or user_id in (select id from app_users where employee_id = auth_employee_id()));

-- 6) ประกาศรับสมัครแบบสาธารณะ (anon อ่านได้เฉพาะที่เปิด)
drop policy if exists p_posting_public on job_postings;
create policy p_posting_public on job_postings for select to anon
  using (is_public and status = 'OPEN'
         and current_date between open_date and close_date);

-- ผู้สมัครภายนอกยื่นใบสมัครได้ แต่ดูได้เฉพาะของตน (ผ่าน Supabase Auth ของผู้สมัคร)
drop policy if exists p_applicant_self on applicants;
create policy p_applicant_self on applicants for all to authenticated
  using (auth_has_perm('recruitment.read')
         or lower(email) = coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''))
  with check (auth_has_perm('recruitment.write')
         or lower(email) = coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''));

comment on function auth_can_see_employee is
  'กติกาการมองเห็นข้อมูลบุคลากร: HR เห็นทั้งหมด / หัวหน้าเห็นลูกน้อง / ทุกคนเห็นของตนเอง';
