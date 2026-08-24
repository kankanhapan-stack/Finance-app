-- =============================================================================
-- HRM :: 11_audit.sql
-- Audit trail แบบรวมศูนย์: ทุกการเพิ่ม/แก้/ลบ ในตารางสำคัญถูกบันทึกอัตโนมัติ
-- + บันทึกการเข้าถึงข้อมูลอ่อนไหว (PDPA access log)
-- =============================================================================

create table if not exists audit_logs (
  id              bigserial primary key,
  org_id          uuid,
  table_name      text not null,
  record_id       uuid,
  action          text not null check (action in ('INSERT','UPDATE','DELETE','TRUNCATE')),
  changed_fields  text[],
  old_data        jsonb,
  new_data        jsonb,
  actor_user_id   uuid,
  actor_email     text,
  actor_ip        text,
  context         jsonb not null default '{}'::jsonb,  -- {module, action_label, request_id}
  occurred_at     timestamptz not null default now()
);
create index if not exists idx_audit_table  on audit_logs(table_name, record_id, occurred_at desc);
create index if not exists idx_audit_org    on audit_logs(org_id, occurred_at desc);
create index if not exists idx_audit_actor  on audit_logs(actor_user_id, occurred_at desc);
create index if not exists idx_audit_new    on audit_logs using gin (new_data jsonb_path_ops);

comment on table audit_logs is 'ร่องรอยการเปลี่ยนแปลงข้อมูลทั้งระบบ (ห้ามลบ/แก้ - append only)';

-- บันทึกการเข้าถึงข้อมูลส่วนบุคคล (PDPA)
create table if not exists data_access_logs (
  id              bigserial primary key,
  org_id          uuid,
  actor_user_id   uuid,
  actor_email     text,
  subject_employee_id uuid,
  module          text not null,
  action          text not null,       -- VIEW, EXPORT, PRINT, SEARCH, DOWNLOAD
  entity_type     text,
  entity_id       uuid,
  purpose         text,
  ip              text,
  user_agent      text,
  occurred_at     timestamptz not null default now()
);
create index if not exists idx_access_subject on data_access_logs(subject_employee_id, occurred_at desc);
create index if not exists idx_access_actor on data_access_logs(actor_user_id, occurred_at desc);

-- บันทึกการเข้าสู่ระบบ
create table if not exists login_logs (
  id              bigserial primary key,
  org_id          uuid,
  user_id         uuid,
  email           text,
  result          text not null check (result in ('SUCCESS','FAIL_PASSWORD','FAIL_NOT_FOUND',
                                                  'FAIL_DISABLED','FAIL_EXPIRED','LOGOUT')),
  method          text default 'GOOGLE' check (method in ('GOOGLE','PASSWORD','TOKEN','SSO')),
  ip              text,
  user_agent      text,
  occurred_at     timestamptz not null default now()
);
create index if not exists idx_login_user on login_logs(user_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Trigger function กลาง
-- -----------------------------------------------------------------------------
create or replace function fn_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[];
  v_org      uuid;
  v_id       uuid;
  v_email    text;
  v_user     uuid;
begin
  v_user := fn_current_user_id();
  select email into v_email from app_users where id = v_user;

  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
  elsif tg_op = 'INSERT' then
    v_old := null;
    v_new := to_jsonb(new);
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    select array_agg(key) into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from (v_old -> n.key)
      and n.key not in ('updated_at','updated_by');
    -- ไม่มีอะไรเปลี่ยนจริง ๆ (นอกจาก timestamp) ก็ไม่ต้องบันทึก
    if v_changed is null or array_length(v_changed, 1) is null then
      return new;
    end if;
  end if;

  v_org := coalesce((v_new->>'org_id')::uuid, (v_old->>'org_id')::uuid, fn_current_org_id());
  v_id  := coalesce((v_new->>'id')::uuid, (v_old->>'id')::uuid);

  insert into audit_logs (org_id, table_name, record_id, action, changed_fields,
                          old_data, new_data, actor_user_id, actor_email, context)
  values (v_org, tg_table_name, v_id, tg_op, v_changed, v_old, v_new, v_user, v_email,
          jsonb_build_object('source', coalesce(current_setting('app.source', true), 'db')));

  return coalesce(new, old);
end;
$$;

-- -----------------------------------------------------------------------------
-- ติดตั้ง trigger ให้ทุกตารางที่ต้องตรวจสอบย้อนหลัง
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  audited text[] := array[
    'organizations','facilities','departments','positions','job_grades','position_slots',
    'app_users','roles','role_permissions','user_roles',
    'employees','employment_assignments','employment_events',
    'employee_educations','employee_licenses','employee_families','employee_files',
    'manpower_requests','job_postings','applicants','applications','job_offers',
    'work_shifts','work_schedules','attendance_daily','overtime_requests','time_adjustments',
    'leave_types','leave_entitlements','leave_requests',
    'pay_components','employee_pay_components','salary_histories',
    'payroll_periods','payroll_runs','payroll_slips',
    'benefit_plans','benefit_enrollments','benefit_claims','employee_loans',
    'appraisal_cycles','appraisals','merit_increases',
    'training_courses','training_sessions','training_registrations','development_plans',
    'career_movements','succession_plans',
    'document_templates','document_requests','issued_documents',
    'discipline_cases','discipline_actions','personnel_orders',
    'separation_requests','clearance_items',
    'approval_requests','approval_flows'
  ];
begin
  foreach t in array audited loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('drop trigger if exists trg_audit_%1$s on %1$I', t);
      execute format(
        'create trigger trg_audit_%1$s after insert or update or delete on %1$I
         for each row execute function fn_audit_trigger()', t);
    end if;
  end loop;
end$$;

-- -----------------------------------------------------------------------------
-- ติดตั้ง trigger updated_at ให้ทุกตารางที่มีคอลัมน์ updated_at
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'updated_at'
      and exists (select 1 from information_schema.tables t
                  where t.table_schema='public' and t.table_name=c.table_name
                    and t.table_type='BASE TABLE')
  loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$I', r.table_name);
    execute format(
      'create trigger trg_touch_%1$s before update on %1$I
       for each row execute function fn_touch_row()', r.table_name);
  end loop;
end$$;

-- -----------------------------------------------------------------------------
-- ป้องกันการแก้ไข/ลบ audit log
-- -----------------------------------------------------------------------------
create or replace function fn_block_audit_change()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs เป็นข้อมูล append-only ห้ามแก้ไขหรือลบ';
end;
$$;

drop trigger if exists trg_audit_immutable on audit_logs;
create trigger trg_audit_immutable
  before update or delete on audit_logs
  for each row execute function fn_block_audit_change();

-- -----------------------------------------------------------------------------
-- RPC : ดูประวัติการเปลี่ยนแปลงของระเบียนใดระเบียนหนึ่ง (ใช้ในหน้า "ประวัติแก้ไข")
-- -----------------------------------------------------------------------------
create or replace function fn_record_history(p_table text, p_record_id uuid, p_limit int default 100)
returns table (
  occurred_at timestamptz, action text, actor_email text,
  changed_fields text[], changes jsonb
)
language sql stable
as $$
  select a.occurred_at, a.action, a.actor_email, a.changed_fields,
         case when a.action = 'UPDATE' then (
           select jsonb_object_agg(f, jsonb_build_object('from', a.old_data->f, 'to', a.new_data->f))
           from unnest(coalesce(a.changed_fields, '{}')) f
         ) else coalesce(a.new_data, a.old_data) end
  from audit_logs a
  where a.table_name = p_table and a.record_id = p_record_id
  order by a.occurred_at desc
  limit p_limit;
$$;
