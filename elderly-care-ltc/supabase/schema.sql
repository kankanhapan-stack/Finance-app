-- =====================================================================
--  ระบบดูแลผู้สูงอายุและผู้มีภาวะพึ่งพิง (Long-Term Care) — Supabase schema
--  รันไฟล์นี้ใน Supabase > SQL Editor ครั้งเดียว (รันซ้ำได้ ปลอดภัย)
--  การเข้าถึงทั้งหมดผ่าน Google Apps Script ด้วย service_role key
--  จึงเปิด RLS ทุกตารางโดยไม่สร้าง policy => anon key อ่าน/เขียนไม่ได้
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- ผู้ใช้งานระบบ ----------
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  salt          text not null,
  full_name     text not null,
  role          text not null check (role in ('admin','cm','cg','viewer')),
  caregiver_id  uuid,
  care_manager_id uuid,
  active        boolean not null default true,
  last_login    timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------- Care Manager ----------
create table if not exists care_managers (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  cid         text,
  phone       text,
  position    text,
  unit        text,                    -- หน่วยบริการ/รพ.สต.
  cert_no     text,                    -- เลขที่ใบรับรอง CM
  bank_name   text,
  bank_account text,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now()
);

-- ---------- Caregiver ----------
create table if not exists caregivers (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  cid            text,
  phone          text,
  address        text,
  moo            text,
  training_hours int default 70,       -- หลักสูตร CG 70 ชม.
  cert_no        text,
  start_date     date,
  cm_id          uuid references care_managers(id) on delete set null,
  bank_name      text,
  bank_account   text,
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now()
);

alter table app_users drop constraint if exists app_users_caregiver_fk;
alter table app_users add constraint app_users_caregiver_fk
  foreign key (caregiver_id) references caregivers(id) on delete set null;
alter table app_users drop constraint if exists app_users_cm_fk;
alter table app_users add constraint app_users_cm_fk
  foreign key (care_manager_id) references care_managers(id) on delete set null;

-- ---------- ทะเบียนประชากร ----------
create table if not exists persons (
  id               uuid primary key default gen_random_uuid(),
  cid              text unique,          -- เลขบัตรประชาชน 13 หลัก
  prefix           text,
  first_name       text not null,
  last_name        text not null,
  gender           text check (gender in ('ชาย','หญิง') or gender is null),
  birth_date       date,
  house_no         text,
  moo              text,
  subdistrict      text,
  district         text,
  province         text,
  phone            text,
  health_right     text,                 -- สิทธิการรักษา (UC/ข้าราชการ/ประกันสังคม)
  disability_type  text,                 -- ประเภทความพิการ (ถ้ามี)
  chronic_diseases text,                 -- โรคประจำตัว
  status           text not null default 'alive' check (status in ('alive','dead','moved')),
  lat              double precision,
  lng              double precision,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists persons_moo_idx on persons(moo);
create index if not exists persons_name_idx on persons(first_name, last_name);

-- ---------- การสำรวจประชากร / ครัวเรือน ----------
create table if not exists surveys (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references persons(id) on delete cascade,
  survey_date        date not null default current_date,
  surveyor           text,
  living_arrangement text,               -- อยู่คนเดียว/อยู่กับคู่สมรส/อยู่กับบุตรหลาน
  main_caregiver     text,               -- ผู้ดูแลหลักในครอบครัว
  caregiver_relation text,
  income_level       text,
  housing_condition  text,
  needs              text,               -- ความต้องการช่วยเหลือ (คั่นด้วย ,)
  equipment          text,               -- อุปกรณ์ที่มี/ต้องการ
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists surveys_person_idx on surveys(person_id);

-- ---------- การประเมิน ADL (Barthel Index 0-20) ----------
create table if not exists adl_assessments (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references persons(id) on delete cascade,
  assess_date          date not null default current_date,
  assessor             text,
  feeding    smallint not null check (feeding    between 0 and 2),
  grooming   smallint not null check (grooming   between 0 and 1),
  transfer   smallint not null check (transfer   between 0 and 3),
  toilet_use smallint not null check (toilet_use between 0 and 2),
  mobility   smallint not null check (mobility   between 0 and 3),
  dressing   smallint not null check (dressing   between 0 and 2),
  stairs     smallint not null check (stairs     between 0 and 2),
  bathing    smallint not null check (bathing    between 0 and 1),
  bowels     smallint not null check (bowels     between 0 and 2),
  bladder    smallint not null check (bladder    between 0 and 2),
  total_score          smallint not null,
  dependency_level     text not null,    -- ติดสังคม / ติดบ้าน / ติดเตียง
  cognitive_impairment boolean not null default false,
  terminal_ill         boolean not null default false,
  ltc_group            smallint,         -- กลุ่มชุดสิทธิประโยชน์ 1-4 (null = ไม่เข้าเกณฑ์ LTC)
  notes                text,
  created_at           timestamptz not null default now()
);
create index if not exists adl_person_idx on adl_assessments(person_id, assess_date desc);

-- ---------- Care Plan ----------
create table if not exists care_plans (
  id          uuid primary key default gen_random_uuid(),
  plan_no     text,
  person_id   uuid not null references persons(id) on delete cascade,
  cm_id       uuid references care_managers(id) on delete set null,
  cg_id       uuid references caregivers(id) on delete set null,
  adl_id      uuid references adl_assessments(id) on delete set null,
  ltc_group   smallint,
  adl_score   smallint,
  start_date  date not null default current_date,
  end_date    date,
  problems    text,                       -- ปัญหา/ความต้องการ
  goals       text,                       -- เป้าหมายการดูแล
  budget      numeric(12,2) default 0,
  status      text not null default 'draft' check (status in ('draft','approved','active','closed')),
  version     int not null default 1,
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists plans_person_idx on care_plans(person_id);
create index if not exists plans_cg_idx on care_plans(cg_id);

create table if not exists care_plan_items (
  id             uuid primary key default gen_random_uuid(),
  care_plan_id   uuid not null references care_plans(id) on delete cascade,
  category       text,                    -- ด้านการดูแล (ร่างกาย/โภชนาการ/ฟื้นฟู/จิตใจ/สิ่งแวดล้อม)
  activity       text not null,
  times_per_month int default 4,
  unit_cost      numeric(10,2) default 0,
  responsible    text default 'CG',
  sort           int default 0
);
create index if not exists plan_items_plan_idx on care_plan_items(care_plan_id);

-- ประวัติการปรับแก้ Care Plan (เก็บ snapshot ทั้งแผนก่อนแก้)
create table if not exists care_plan_revisions (
  id           uuid primary key default gen_random_uuid(),
  care_plan_id uuid not null references care_plans(id) on delete cascade,
  version      int not null,
  reason       text not null,
  changed_by   text,
  snapshot     jsonb not null,
  created_at   timestamptz not null default now()
);

-- ---------- การปฏิบัติงานของ CG ตาม Care Plan ----------
create table if not exists cg_visits (
  id           uuid primary key default gen_random_uuid(),
  care_plan_id uuid references care_plans(id) on delete set null,
  person_id    uuid not null references persons(id) on delete cascade,
  cg_id        uuid not null references caregivers(id) on delete cascade,
  visit_date   date not null default current_date,
  start_time   time,
  end_time     time,
  activities   jsonb default '[]'::jsonb,  -- [{item_id, activity, done}]
  vitals       jsonb default '{}'::jsonb,  -- {bp, pulse, temp, dtx, weight}
  notes        text,
  problems     text,
  lat          double precision,
  lng          double precision,
  status       text not null default 'submitted' check (status in ('submitted','verified','rejected')),
  verified_by  text,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists visits_date_idx on cg_visits(visit_date);
create index if not exists visits_cg_idx on cg_visits(cg_id, visit_date);

create table if not exists visit_photos (
  id           uuid primary key default gen_random_uuid(),
  visit_id     uuid not null references cg_visits(id) on delete cascade,
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now()
);

-- ---------- ค่าตอบแทน ----------
create table if not exists cg_payments (
  id            uuid primary key default gen_random_uuid(),
  period        text not null,              -- YYYY-MM
  cg_id         uuid not null references caregivers(id) on delete cascade,
  visit_count   int not null default 0,
  patient_count int not null default 0,
  rate_mode     text,
  rate          numeric(10,2),
  amount        numeric(12,2) not null default 0,
  status        text not null default 'draft' check (status in ('draft','approved','paid')),
  approved_by   text,
  paid_at       date,
  note          text,
  created_at    timestamptz not null default now(),
  unique (period, cg_id)
);

create table if not exists cm_payments (
  id            uuid primary key default gen_random_uuid(),
  period        text not null,
  cm_id         uuid not null references care_managers(id) on delete cascade,
  case_count    int not null default 0,
  new_plan_count int not null default 0,
  amount        numeric(12,2) not null default 0,
  status        text not null default 'draft' check (status in ('draft','approved','paid')),
  approved_by   text,
  paid_at       date,
  note          text,
  created_at    timestamptz not null default now(),
  unique (period, cm_id)
);

-- ---------- โครงการดูแลผู้สูงอายุ/ผู้พิการที่มีภาวะพึ่งพิง ----------
create table if not exists projects (
  id                uuid primary key default gen_random_uuid(),
  fiscal_year       int,
  code              text,
  title             text not null,
  rationale         text,                    -- หลักการและเหตุผล
  objectives        text,                    -- วัตถุประสงค์
  target_group      text,                    -- กลุ่มเป้าหมาย
  target_count      int,
  location          text,
  start_date        date,
  end_date          date,
  budget            numeric(12,2) default 0,
  budget_source     text,                    -- แหล่งงบประมาณ
  activities        jsonb default '[]'::jsonb, -- [{name, detail, period, budget}]
  expected_outcomes text,
  evaluation        text,
  responsible       text,
  status            text not null default 'draft' check (status in ('draft','submitted','approved','running','done')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists project_beneficiaries (
  project_id uuid not null references projects(id) on delete cascade,
  person_id  uuid not null references persons(id) on delete cascade,
  primary key (project_id, person_id)
);

-- ---------- การตั้งค่า / Audit ----------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id         bigserial primary key,
  username   text,
  action     text,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- =====================================================================
--  หลายสถานบริการ (multi-facility)
-- =====================================================================
create table if not exists facilities (
  id                uuid primary key default gen_random_uuid(),
  code              text unique,              -- รหัสสถานบริการ (เช่น รหัส 5 หลัก)
  name              text not null,            -- ชื่อสถานบริการ
  cm_name           text,                     -- ชื่อ-สกุล CM
  cm_position       text,                     -- ตำแหน่ง CM
  director_name     text,                     -- ชื่อ-สกุล ผอ.รพ.สต.
  fund_name         text,                     -- ชื่อกองทุน
  center_chair      text,                     -- ชื่อ-สกุล ประธานศูนย์ฯ
  lao_name          text,                     -- ชื่อ อปท.
  address           text,
  subdistrict       text,
  district          text,
  province          text,
  phone             text,
  approver_name     text,                     -- ชื่อผู้บริหาร (ผู้อนุมัติ)
  approver_position text,                     -- ตำแหน่งผู้บริหาร
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- งบประมาณที่ได้รับจัดสรรรายปีงบประมาณ (พ.ศ.)
create table if not exists facility_budgets (
  id          uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  fiscal_year int not null,
  amount      numeric(14,2) not null default 0,
  note        text,
  updated_at  timestamptz not null default now(),
  unique (facility_id, fiscal_year)
);

do $$
declare t text;
begin
  foreach t in array array['app_users','persons','care_managers','caregivers','care_plans','cg_visits',
    'cg_payments','cm_payments','projects']
  loop
    execute format('alter table %I add column if not exists facility_id uuid references facilities(id) on delete restrict', t);
    execute format('create index if not exists %I on %I(facility_id)', t || '_facility_idx', t);
  end loop;
end $$;

-- ย้ายข้อมูลเดิม (ก่อนรองรับหลายสถานบริการ) เข้าสถานบริการแรก
do $$
declare fid uuid;
begin
  if exists (select 1 from persons where facility_id is null) or exists (select 1 from caregivers where facility_id is null)
     or exists (select 1 from care_managers where facility_id is null) or exists (select 1 from projects where facility_id is null)
     or exists (select 1 from app_users where facility_id is null and role in ('cm','cg')) then
    select id into fid from facilities order by created_at limit 1;
    if fid is null then
      insert into facilities(name, approver_position)
      values (coalesce((select value->>'name' from settings where key = 'org'), 'สถานบริการหลัก'),
              (select value->>'director_position' from settings where key = 'org'))
      returning id into fid;
    end if;
    update persons       set facility_id = fid where facility_id is null;
    update care_managers set facility_id = fid where facility_id is null;
    update caregivers    set facility_id = fid where facility_id is null;
    update care_plans    set facility_id = fid where facility_id is null;
    update cg_visits     set facility_id = fid where facility_id is null;
    update cg_payments   set facility_id = fid where facility_id is null;
    update cm_payments   set facility_id = fid where facility_id is null;
    update projects      set facility_id = fid where facility_id is null;
    update app_users     set facility_id = fid where facility_id is null and role in ('cm','cg');
  end if;
end $$;

-- ---------- View: ผลประเมิน ADL ล่าสุดของแต่ละคน ----------
create or replace view v_latest_adl with (security_invoker = true) as
select distinct on (a.person_id)
  a.*, p.cid, p.prefix, p.first_name, p.last_name, p.gender, p.birth_date, p.moo, p.status as person_status,
  p.facility_id
from adl_assessments a
join persons p on p.id = a.person_id
order by a.person_id, a.assess_date desc, a.created_at desc;

-- ---------- RPC: สรุปตัวเลข Dashboard (p_facility = null คือทุกสถานบริการ) ----------
drop function if exists dashboard_summary(text);
create or replace function dashboard_summary(p_month text default to_char(current_date,'YYYY-MM'), p_facility uuid default null)
returns json language sql stable as $$
  with m as (
    select to_date(p_month || '-01','YYYY-MM-DD') as d0,
           (to_date(p_month || '-01','YYYY-MM-DD') + interval '1 month')::date as d1
  ),
  per as (select * from persons       where p_facility is null or facility_id = p_facility),
  la  as (select * from v_latest_adl  where person_status = 'alive' and (p_facility is null or facility_id = p_facility)),
  cp  as (select * from care_plans    where p_facility is null or facility_id = p_facility),
  cgs as (select * from caregivers    where p_facility is null or facility_id = p_facility),
  cms as (select * from care_managers where p_facility is null or facility_id = p_facility),
  vs  as (select * from cg_visits     where p_facility is null or facility_id = p_facility),
  cgp as (select * from cg_payments   where p_facility is null or facility_id = p_facility),
  cmp as (select * from cm_payments   where p_facility is null or facility_id = p_facility)
  select json_build_object(
    'persons',        (select count(*) from per where status='alive'),
    'elderly',        (select count(*) from per where status='alive' and birth_date <= current_date - interval '60 years'),
    'disabled',       (select count(*) from per where status='alive' and coalesce(disability_type,'') <> ''),
    'assessed',       (select count(*) from la),
    'dep_social',     (select count(*) from la where dependency_level='ติดสังคม'),
    'dep_home',       (select count(*) from la where dependency_level='ติดบ้าน'),
    'dep_bed',        (select count(*) from la where dependency_level='ติดเตียง'),
    'groups',         (select coalesce(json_object_agg(g, c), '{}'::json) from
                        (select ltc_group g, count(*) c from la where ltc_group is not null group by ltc_group) t),
    'ltc_eligible',   (select count(*) from la where ltc_group is not null),
    'with_plan',      (select count(distinct person_id) from cp where status in ('approved','active')),
    'plans_draft',    (select count(*) from cp where status='draft'),
    'caregivers',     (select count(*) from cgs where status='active'),
    'care_managers',  (select count(*) from cms where status='active'),
    'visits_month',   (select count(*) from vs, m where visit_date >= m.d0 and visit_date < m.d1),
    'visits_pending', (select count(*) from vs where status='submitted'),
    'cg_pay_month',   (select coalesce(sum(amount),0) from cgp where period = p_month),
    'cm_pay_month',   (select coalesce(sum(amount),0) from cmp where period = p_month),
    'visits_trend',   (select coalesce(json_agg(json_build_object('month', mo, 'n', n) order by mo), '[]'::json) from (
                        select to_char(visit_date,'YYYY-MM') mo, count(*) n from vs
                        where visit_date >= (select d0 from m) - interval '11 months'
                          and visit_date < (select d1 from m)
                        group by 1) t),
    'by_moo',         (select coalesce(json_agg(json_build_object('moo', moo, 'n', n) order by moo), '[]'::json) from (
                        select coalesce(moo,'-') moo, count(*) n from la where ltc_group is not null group by 1) t)
  );
$$;

-- ---------- RPC: รายงานการเบิกจ่ายงบรายสถานบริการ ตามปีงบประมาณ (พ.ศ.) ----------
-- งบประมาณ = ยอดที่บันทึกใน facility_budgets ถ้าไม่มีจะประมาณจาก ผู้มีภาวะพึ่งพิง x อัตราต่อคน/ปี
-- เบิกจ่ายแล้ว = ค่าตอบแทน CG + CM ที่สถานะ "จ่ายแล้ว" ในงวด ต.ค. - ก.ย. ของปีงบประมาณนั้น
create or replace function facility_budget_report(p_fy int, p_facility uuid default null)
returns json language sql stable as $$
  with rate as (
    select coalesce((select (value->>'fund_per_person_year')::numeric from settings where key = 'rates'), 0) r
  ), fy as (
    select to_char(make_date(p_fy - 544, 10, 1), 'YYYY-MM') p0, to_char(make_date(p_fy - 543, 9, 1), 'YYYY-MM') p1
  ), dep as (
    select facility_id, count(*) n from v_latest_adl
    where person_status = 'alive' and ltc_group is not null group by 1
  ), paid as (
    select x.facility_id, sum(x.amount) s from (
      select facility_id, amount, period, status from cg_payments
      union all
      select facility_id, amount, period, status from cm_payments
    ) x, fy
    where x.status = 'paid' and x.period between fy.p0 and fy.p1 group by 1
  )
  select coalesce(json_agg(row_to_json(t) order by t.name), '[]'::json) from (
    select f.id, f.code, f.name,
           coalesce(dep.n, 0) as dependents,
           coalesce(b.amount, coalesce(dep.n, 0) * (select r from rate)) as budget,
           (b.amount is null) as budget_estimated,
           coalesce(paid.s, 0) as paid,
           coalesce(b.amount, coalesce(dep.n, 0) * (select r from rate)) - coalesce(paid.s, 0) as remaining
    from facilities f
    left join dep  on dep.facility_id = f.id
    left join paid on paid.facility_id = f.id
    left join facility_budgets b on b.facility_id = f.id and b.fiscal_year = p_fy
    where f.active and (p_facility is null or f.id = p_facility)
  ) t;
$$;

-- ---------- ค่าตั้งต้น ----------
insert into settings(key, value) values
 ('rates', '{"fund_per_person_year":10442,"group_budget":{"1":10442,"2":10442,"3":10442,"4":10442},"cg_mode":"per_visit","cg_rate_per_visit":100,"cg_rate_per_patient":300,"cg_monthly_cap":3000,"cm_rate_per_case":100,"cm_rate_per_new_plan":200,"cm_monthly_cap":5000}'),
 ('adl', '{"bed_max":4,"home_max":11,"ltc_max":11}')
on conflict (key) do nothing;

-- ---------- Storage bucket สำหรับรูปภาพการปฏิบัติงาน (private) ----------
insert into storage.buckets (id, name, public)
values ('visit-photos', 'visit-photos', false)
on conflict (id) do nothing;

-- ---------- เปิด RLS ทุกตาราง (เข้าถึงได้เฉพาะ service_role ผ่าน GAS) ----------
do $$
declare t text;
begin
  foreach t in array array['app_users','care_managers','caregivers','persons','surveys','adl_assessments',
    'care_plans','care_plan_items','care_plan_revisions','cg_visits','visit_photos','cg_payments',
    'cm_payments','projects','project_beneficiaries','settings','audit_logs','facilities','facility_budgets']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- view/function ไม่ให้ anon / authenticated เรียกได้
revoke all on v_latest_adl from anon, authenticated;
revoke execute on function dashboard_summary(text, uuid) from public, anon, authenticated;
grant execute on function dashboard_summary(text, uuid) to service_role;
revoke execute on function facility_budget_report(int, uuid) from public, anon, authenticated;
grant execute on function facility_budget_report(int, uuid) to service_role;
