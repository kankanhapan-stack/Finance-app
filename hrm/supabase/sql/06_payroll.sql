-- =============================================================================
-- HRM :: 06_payroll.sql
-- โครงสร้างเงินเดือน / รายการได้-หัก / งวดจ่าย / การประมวลผล / สลิป
--
-- แนวคิด: pay_components เป็น "แม่แบบรายการ" ที่กำหนดสูตรได้
--          employee_pay_components ผูกรายการประจำให้รายบุคคล
--          payroll_runs -> payroll_slips -> payroll_slip_items (เก็บผลลัพธ์แบบ snapshot)
-- =============================================================================

-- บัญชีเงินเดือน/ขั้นเงินเดือน (salary structure)
create table if not exists salary_scales (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  job_grade_id    uuid references job_grades(id) on delete set null,
  effective_from  date not null default current_date,
  effective_to    date,
  steps           jsonb not null default '[]'::jsonb,  -- [{step:1, salary:15000}, ...]
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code, effective_from)
);

-- รายการเงินได้/เงินหัก
create table if not exists pay_components (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  component_type  text not null check (component_type in ('EARNING','DEDUCTION','EMPLOYER_COST','INFO')),
  category        text not null default 'OTHER'
                    check (category in ('BASE','ALLOWANCE','OT','BONUS','POSITION_ALLOW','SPECIAL_ALLOW',
                                        'TAX','SSO','PVD','LOAN','ABSENCE','WELFARE','OTHER')),
  calc_method     text not null default 'FIXED'
                    check (calc_method in ('FIXED','PERCENT_BASE','PERCENT_GROSS','FORMULA','RATE_TIME','MANUAL')),
  default_amount  numeric(14,2) default 0,
  default_percent numeric(7,4),
  formula         text,                          -- นิพจน์ประเมินฝั่ง Apps Script เช่น base*0.05
  is_taxable      boolean not null default true,
  is_sso_base     boolean not null default true,  -- นับเป็นฐานประกันสังคม
  is_recurring    boolean not null default true,
  cap_amount      numeric(14,2),
  gl_account      text,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- รายการประจำรายบุคคล (เงินประจำตำแหน่ง, ค.ต.ส., หักสหกรณ์ ฯลฯ)
create table if not exists employee_pay_components (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  component_id    uuid not null references pay_components(id) on delete cascade,
  amount          numeric(14,2),
  percent_value   numeric(7,4),
  effective_from  date not null default current_date,
  effective_to    date,
  reference_no    text,          -- เลขที่สัญญากู้/เลขที่คำสั่ง
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_epc_emp on employee_pay_components(employee_id)
  where effective_to is null;

-- ประวัติเงินเดือน (ใช้ย้อนหลังและคำนวณบำเหน็จ)
create table if not exists salary_histories (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  effective_date  date not null,
  old_salary      numeric(14,2),
  new_salary      numeric(14,2) not null,
  change_amount   numeric(14,2) generated always as (new_salary - coalesce(old_salary,0)) stored,
  change_percent  numeric(7,4),
  change_type     text not null default 'ANNUAL'
                    check (change_type in ('HIRE','ANNUAL','PROMOTION','ADJUSTMENT','SPECIAL','DEMOTION','MINIMUM_WAGE')),
  reason          text,
  order_no        text,
  order_date      date,
  approved_by     uuid references employees(id) on delete set null,
  created_at      timestamptz not null default now(),
  created_by uuid
);
create index if not exists idx_salhist_emp on salary_histories(employee_id, effective_date desc);

-- งวดการจ่าย
create table if not exists payroll_periods (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,                  -- 2569-01
  name_th         text not null,
  period_year     int not null,
  period_month    int not null check (period_month between 1 and 12),
  period_seq      int not null default 1,         -- กรณีจ่าย 2 งวด/เดือน
  start_date      date not null,
  end_date        date not null,
  cutoff_date     date,                           -- วันตัดยอด OT/ลา
  pay_date        date not null,
  status          text not null default 'OPEN'
                    check (status in ('OPEN','PROCESSING','CALCULATED','APPROVED','PAID','CLOSED','CANCELLED')),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, period_year, period_month, period_seq)
);

-- รอบประมวลผล (1 งวด อาจมีหลายรอบ เช่น รอบปกติ + รอบเงินตกเบิก)
create table if not exists payroll_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  period_id       uuid not null references payroll_periods(id) on delete cascade,
  facility_id     uuid references facilities(id) on delete set null,
  run_no          text,
  run_type        text not null default 'REGULAR'
                    check (run_type in ('REGULAR','OFF_CYCLE','BONUS','RETRO','FINAL_PAY')),
  employee_filter jsonb not null default '{}'::jsonb,  -- {employment_types:[], department_ids:[]}
  headcount       int not null default 0,
  total_earning   numeric(16,2) not null default 0,
  total_deduction numeric(16,2) not null default 0,
  total_net       numeric(16,2) not null default 0,
  total_employer_cost numeric(16,2) not null default 0,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','CALCULATED','PENDING_APPROVAL','APPROVED','PAID','CANCELLED')),
  calculated_at   timestamptz,
  approved_by     uuid references app_users(id) on delete set null,
  approved_at     timestamptz,
  paid_at         timestamptz,
  bank_file_url   text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_run_period on payroll_runs(period_id, status);

-- สลิปเงินเดือนรายคน (snapshot ข้อมูล ณ เวลาจ่าย)
create table if not exists payroll_slips (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  run_id          uuid not null references payroll_runs(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  slip_no         text,
  -- snapshot ข้อมูลบุคคล ณ งวดนั้น (ไม่ต้อง join ย้อนหลัง)
  emp_code        text,
  full_name       text,
  position_name   text,
  department_name text,
  facility_name   text,
  bank_account    jsonb not null default '{}'::jsonb,
  base_salary     numeric(14,2) not null default 0,
  work_days       numeric(6,2),
  absent_days     numeric(6,2) not null default 0,
  leave_unpaid_days numeric(6,2) not null default 0,
  ot_minutes      int not null default 0,
  gross_earning   numeric(14,2) not null default 0,
  total_deduction numeric(14,2) not null default 0,
  net_pay         numeric(14,2) not null default 0,
  employer_cost   numeric(14,2) not null default 0,
  tax_amount      numeric(14,2) not null default 0,
  sso_employee    numeric(14,2) not null default 0,
  sso_employer    numeric(14,2) not null default 0,
  payment_method  text not null default 'TRANSFER' check (payment_method in ('TRANSFER','CASH','CHEQUE')),
  payment_status  text not null default 'PENDING' check (payment_status in ('PENDING','PAID','FAILED','HOLD')),
  paid_at         timestamptz,
  slip_pdf_url    text,
  is_viewed       boolean not null default false,
  viewed_at       timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (run_id, employee_id)
);
create index if not exists idx_slip_emp on payroll_slips(employee_id, created_at desc);

create table if not exists payroll_slip_items (
  id              uuid primary key default gen_random_uuid(),
  slip_id         uuid not null references payroll_slips(id) on delete cascade,
  component_id    uuid references pay_components(id) on delete set null,
  component_code  text not null,
  component_name  text not null,
  component_type  text not null check (component_type in ('EARNING','DEDUCTION','EMPLOYER_COST','INFO')),
  category        text,
  quantity        numeric(12,2),
  rate            numeric(14,4),
  amount          numeric(14,2) not null default 0,
  is_taxable      boolean not null default true,
  calc_note       text,
  sort_order      int not null default 0
);
create index if not exists idx_slipitem_slip on payroll_slip_items(slip_id, sort_order);

-- ตารางภาษีเงินได้บุคคลธรรมดา (ขั้นบันได) และค่าลดหย่อน
create table if not exists tax_brackets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organizations(id) on delete cascade,  -- null = ใช้ร่วมทุกองค์กร
  tax_year        int not null,
  income_from     numeric(14,2) not null,
  income_to       numeric(14,2),
  rate_percent    numeric(6,3) not null,
  deduct_amount   numeric(14,2) not null default 0
);
create unique index if not exists uq_tax_bracket on tax_brackets
  (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), tax_year, income_from);

create table if not exists employee_tax_profiles (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id) on delete cascade,
  tax_year        int not null,
  marital_status  text,
  spouse_has_income boolean not null default false,
  child_count     int not null default 0,
  parent_count    int not null default 0,
  disabled_count  int not null default 0,
  insurance_premium numeric(14,2) not null default 0,
  pvd_contribution  numeric(14,2) not null default 0,
  rmf_ltf_amount    numeric(14,2) not null default 0,
  home_loan_interest numeric(14,2) not null default 0,
  donation_amount   numeric(14,2) not null default 0,
  other_deduction   jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, tax_year)
);

-- อัตราประกันสังคม/กองทุน ตามปี
create table if not exists contribution_rates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organizations(id) on delete cascade,
  fund_type       text not null check (fund_type in ('SSO','PVD','GPF','WELFARE','OTHER')),
  effective_from  date not null,
  effective_to    date,
  employee_percent numeric(6,3) not null default 0,
  employer_percent numeric(6,3) not null default 0,
  min_base        numeric(14,2),
  max_base        numeric(14,2),
  employee_cap    numeric(14,2),
  employer_cap    numeric(14,2),
  note            text
);
create unique index if not exists uq_contrib_rate on contribution_rates
  (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), fund_type, effective_from);

-- -----------------------------------------------------------------------------
-- View : รายการเงินได้-หัก ประจำที่มีผลของบุคลากรแต่ละคน
-- -----------------------------------------------------------------------------
create or replace view v_employee_pay_setup as
select
  epc.employee_id,
  epc.org_id,
  pc.id            as component_id,
  pc.code          as component_code,
  pc.name_th       as component_name,
  pc.component_type,
  pc.category,
  pc.calc_method,
  pc.formula,
  pc.is_taxable,
  pc.is_sso_base,
  pc.cap_amount,
  pc.sort_order,
  coalesce(epc.amount, pc.default_amount)          as amount,
  coalesce(epc.percent_value, pc.default_percent)  as percent_value,
  epc.effective_from,
  epc.effective_to,
  epc.reference_no
from employee_pay_components epc
join pay_components pc on pc.id = epc.component_id
where pc.is_active
  and epc.effective_from <= current_date
  and (epc.effective_to is null or epc.effective_to >= current_date);

-- -----------------------------------------------------------------------------
-- RPC : สรุปข้อมูลตั้งต้นการคำนวณเงินเดือนของงวดหนึ่ง
-- Apps Script จะดึงผลนี้ไปคำนวณ (สูตร/ภาษี) แล้ว POST กลับเป็น slips
-- -----------------------------------------------------------------------------
create or replace function fn_payroll_input(p_run_id uuid)
returns table (
  employee_id uuid, emp_code text, full_name text,
  position_name text, department_name text, facility_name text,
  employment_type text, base_salary numeric, bank_account jsonb,
  work_days numeric, absent_days numeric, unpaid_leave_days numeric,
  ot_minutes int, components jsonb
)
language plpgsql stable
as $$
declare v_run payroll_runs%rowtype; v_period payroll_periods%rowtype;
begin
  select * into v_run from payroll_runs where id = p_run_id;
  if not found then raise exception 'ไม่พบรอบประมวลผล %', p_run_id; end if;
  select * into v_period from payroll_periods where id = v_run.period_id;

  return query
  select
    v.employee_id, v.emp_code, v.full_name_th,
    v.position_name, v.department_name, v.facility_name,
    v.employment_type, coalesce(v.base_salary, 0), e.bank_account,
    coalesce(att.work_days, 0),
    coalesce(att.absent_days, 0),
    coalesce(lv.unpaid_days, 0),
    coalesce(ot.ot_minutes, 0)::int,
    coalesce(cmp.components, '[]'::jsonb)
  from v_employee_current v
  join employees e on e.id = v.employee_id
  left join lateral (
    select count(*) filter (where a.status in ('PRESENT','LATE','HALF_DAY','TRIP','TRAINING'))::numeric as work_days,
           count(*) filter (where a.status = 'ABSENT')::numeric as absent_days
    from attendance_daily a
    where a.employee_id = v.employee_id
      and a.work_date between v_period.start_date and v_period.end_date
  ) att on true
  left join lateral (
    select coalesce(sum(lr.total_days * lt.deduct_salary_rate), 0) as unpaid_days
    from leave_requests lr
    join leave_types lt on lt.id = lr.leave_type_id
    where lr.employee_id = v.employee_id and lr.status = 'APPROVED'
      and lr.start_date <= v_period.end_date and lr.end_date >= v_period.start_date
      and lt.deduct_salary_rate > 0
  ) lv on true
  left join lateral (
    select coalesce(sum(coalesce(o.actual_minutes, o.planned_minutes)), 0) as ot_minutes
    from overtime_requests o
    where o.employee_id = v.employee_id and o.status = 'APPROVED'
      and o.work_date between v_period.start_date and v_period.end_date
  ) ot on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'component_id', s.component_id, 'code', s.component_code,
             'name', s.component_name, 'type', s.component_type,
             'category', s.category, 'calc_method', s.calc_method,
             'formula', s.formula, 'amount', s.amount, 'percent', s.percent_value,
             'is_taxable', s.is_taxable, 'is_sso_base', s.is_sso_base,
             'cap', s.cap_amount, 'sort', s.sort_order)
             order by s.sort_order) as components
    from v_employee_pay_setup s
    where s.employee_id = v.employee_id
  ) cmp on true
  where v.org_id = v_run.org_id
    and v.employment_status in ('ACTIVE','PROBATION','ON_LEAVE')
    and (v_run.facility_id is null or v.facility_id = v_run.facility_id)
    and (
      coalesce(jsonb_array_length(v_run.employee_filter->'employment_types'), 0) = 0
      or v.employment_type in (
        select jsonb_array_elements_text(v_run.employee_filter->'employment_types'))
    )
  order by v.emp_code;
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC : ปิดรอบและสรุปยอดรวมของ run
-- -----------------------------------------------------------------------------
create or replace function fn_payroll_finalize(p_run_id uuid, p_status text default 'CALCULATED')
returns payroll_runs
language plpgsql
as $$
declare v_run payroll_runs%rowtype;
begin
  update payroll_runs r set
    headcount       = s.cnt,
    total_earning   = s.earning,
    total_deduction = s.deduction,
    total_net       = s.net,
    total_employer_cost = s.employer_cost,
    status          = p_status,
    calculated_at   = now(),
    updated_at      = now()
  from (
    select count(*) as cnt,
           coalesce(sum(gross_earning),0)   as earning,
           coalesce(sum(total_deduction),0) as deduction,
           coalesce(sum(net_pay),0)         as net,
           coalesce(sum(employer_cost),0)   as employer_cost
    from payroll_slips where run_id = p_run_id
  ) s
  where r.id = p_run_id
  returning r.* into v_run;

  return v_run;
end;
$$;
