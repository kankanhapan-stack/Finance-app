-- =============================================================================
-- HRM :: 07_benefits.sql
-- สิทธิประโยชน์และสวัสดิการ: แผนสวัสดิการ / การลงทะเบียน / การเบิกจ่าย /
-- เงินกู้-สหกรณ์ / ตรวจสุขภาพ / เครื่องราชอิสริยาภรณ์
-- =============================================================================

create table if not exists benefit_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  benefit_type    text not null default 'WELFARE'
                    check (benefit_type in ('HEALTH','LIFE','ACCIDENT','DENTAL','EDUCATION','HOUSING',
                                            'TRANSPORT','MEAL','UNIFORM','FUNERAL','CHILDCARE',
                                            'PROVIDENT','WELFARE','OTHER')),
  provider        text,                              -- บริษัทประกัน/หน่วยงานผู้ให้สิทธิ
  description     text,
  eligibility     jsonb not null default '{}'::jsonb, -- {employment_types:[], min_months:12, grades:[]}
  annual_limit    numeric(14,2),
  per_claim_limit numeric(14,2),
  family_covered  boolean not null default false,
  employer_contribution numeric(14,2),
  employee_contribution numeric(14,2),
  effective_from  date not null default current_date,
  effective_to    date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

create table if not exists benefit_enrollments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  plan_id         uuid not null references benefit_plans(id) on delete cascade,
  enrolled_date   date not null default current_date,
  end_date        date,
  policy_no       text,
  covered_members jsonb not null default '[]'::jsonb,  -- [{family_id,name,relation}]
  status          text not null default 'ACTIVE'
                    check (status in ('ACTIVE','SUSPENDED','TERMINATED','PENDING')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, plan_id, enrolled_date)
);
create index if not exists idx_enroll_emp on benefit_enrollments(employee_id) where status = 'ACTIVE';

create table if not exists benefit_claims (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  plan_id         uuid not null references benefit_plans(id) on delete restrict,
  claim_no        text,
  claim_date      date not null default current_date,
  service_date    date,
  claimant_name   text,               -- ผู้ใช้สิทธิ (ตนเอง/บุคคลในครอบครัว)
  claimant_relation text,
  provider_name   text,               -- โรงพยาบาล/ร้านค้า
  description     text,
  claim_amount    numeric(14,2) not null,
  approved_amount numeric(14,2),
  paid_amount     numeric(14,2),
  receipt_url     text,
  status          text not null default 'SUBMITTED'
                    check (status in ('DRAFT','SUBMITTED','REVIEWING','APPROVED','PARTIAL','REJECTED','PAID','CANCELLED')),
  reviewed_by     uuid references app_users(id) on delete set null,
  reviewed_at     timestamptz,
  reject_reason   text,
  payroll_slip_id uuid references payroll_slips(id) on delete set null,  -- จ่ายพร้อมเงินเดือน
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_claim_emp on benefit_claims(employee_id, claim_date desc);
create index if not exists idx_claim_status on benefit_claims(org_id, status);

-- เงินกู้/สวัสดิการเงินกู้ (หักผ่านเงินเดือน)
create table if not exists employee_loans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  loan_no         text,
  loan_type       text not null default 'WELFARE'
                    check (loan_type in ('WELFARE','EMERGENCY','HOUSING','EDUCATION','COOP','OTHER')),
  lender          text,
  principal       numeric(14,2) not null,
  interest_rate   numeric(6,3) not null default 0,
  installments    int not null,
  installment_amount numeric(14,2) not null,
  start_period    date not null,
  paid_installments int not null default 0,
  outstanding     numeric(14,2),
  status          text not null default 'ACTIVE'
                    check (status in ('PENDING','ACTIVE','COMPLETED','SUSPENDED','WRITTEN_OFF')),
  contract_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_loan_emp on employee_loans(employee_id) where status = 'ACTIVE';

-- ตรวจสุขภาพประจำปี
create table if not exists health_checkups (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  checkup_year    int not null,
  checkup_date    date,
  provider        text,
  program         text,
  result_summary  text,
  risk_level      text check (risk_level in ('NORMAL','WATCH','RISK','ABNORMAL')),
  followup_needed boolean not null default false,
  followup_note   text,
  report_url      text,
  is_confidential boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (employee_id, checkup_year)
);

-- เครื่องราชอิสริยาภรณ์ / รางวัลเชิดชูเกียรติ
create table if not exists employee_awards (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  award_type      text not null default 'HONOR'
                    check (award_type in ('ROYAL_DECORATION','HONOR','PERFORMANCE','LONG_SERVICE','INNOVATION','OTHER')),
  award_name      text not null,
  award_level     text,               -- ชั้นตรา เช่น บ.ม., บ.ช., จ.ม.
  granted_date    date,
  announce_ref    text,               -- ราชกิจจานุเบกษา เล่ม/ตอน/หน้า
  granting_body   text,
  reward_amount   numeric(14,2),
  certificate_url text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index if not exists idx_award_emp on employee_awards(employee_id, granted_date desc);

-- -----------------------------------------------------------------------------
-- View : ยอดใช้สิทธิสวัสดิการคงเหลือของปีปัจจุบัน
-- -----------------------------------------------------------------------------
create or replace view v_benefit_usage as
select
  be.employee_id,
  be.org_id,
  bp.id           as plan_id,
  bp.code         as plan_code,
  bp.name_th      as plan_name,
  bp.benefit_type,
  bp.annual_limit,
  extract(year from current_date)::int as usage_year,
  coalesce(sum(bc.approved_amount) filter (
      where bc.status in ('APPROVED','PARTIAL','PAID')
        and extract(year from bc.claim_date) = extract(year from current_date)), 0)::numeric(14,2) as used_amount,
  (bp.annual_limit - coalesce(sum(bc.approved_amount) filter (
      where bc.status in ('APPROVED','PARTIAL','PAID')
        and extract(year from bc.claim_date) = extract(year from current_date)), 0))::numeric(14,2) as remaining_amount
from benefit_enrollments be
join benefit_plans bp on bp.id = be.plan_id
left join benefit_claims bc on bc.employee_id = be.employee_id and bc.plan_id = be.plan_id
where be.status = 'ACTIVE'
group by be.employee_id, be.org_id, bp.id, bp.code, bp.name_th, bp.benefit_type, bp.annual_limit;
