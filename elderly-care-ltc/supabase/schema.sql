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

-- ---------- View: ผลประเมิน ADL ล่าสุดของแต่ละคน ----------
create or replace view v_latest_adl with (security_invoker = true) as
select distinct on (a.person_id)
  a.*, p.cid, p.prefix, p.first_name, p.last_name, p.gender, p.birth_date, p.moo, p.status as person_status
from adl_assessments a
join persons p on p.id = a.person_id
order by a.person_id, a.assess_date desc, a.created_at desc;

-- ---------- RPC: สรุปตัวเลข Dashboard ----------
create or replace function dashboard_summary(p_month text default to_char(current_date,'YYYY-MM'))
returns json language sql stable as $$
  with m as (
    select to_date(p_month || '-01','YYYY-MM-DD') as d0,
           (to_date(p_month || '-01','YYYY-MM-DD') + interval '1 month')::date as d1
  ), la as (select * from v_latest_adl where person_status = 'alive')
  select json_build_object(
    'persons',        (select count(*) from persons where status='alive'),
    'elderly',        (select count(*) from persons where status='alive' and birth_date <= current_date - interval '60 years'),
    'disabled',       (select count(*) from persons where status='alive' and coalesce(disability_type,'') <> ''),
    'assessed',       (select count(*) from la),
    'dep_social',     (select count(*) from la where dependency_level='ติดสังคม'),
    'dep_home',       (select count(*) from la where dependency_level='ติดบ้าน'),
    'dep_bed',        (select count(*) from la where dependency_level='ติดเตียง'),
    'groups',         (select coalesce(json_object_agg(g, c), '{}'::json) from
                        (select ltc_group g, count(*) c from la where ltc_group is not null group by ltc_group) t),
    'ltc_eligible',   (select count(*) from la where ltc_group is not null),
    'with_plan',      (select count(distinct person_id) from care_plans where status in ('approved','active')),
    'plans_draft',    (select count(*) from care_plans where status='draft'),
    'caregivers',     (select count(*) from caregivers where status='active'),
    'care_managers',  (select count(*) from care_managers where status='active'),
    'visits_month',   (select count(*) from cg_visits, m where visit_date >= m.d0 and visit_date < m.d1),
    'visits_pending', (select count(*) from cg_visits where status='submitted'),
    'cg_pay_month',   (select coalesce(sum(amount),0) from cg_payments where period = p_month),
    'cm_pay_month',   (select coalesce(sum(amount),0) from cm_payments where period = p_month),
    'visits_trend',   (select coalesce(json_agg(json_build_object('month', mo, 'n', n) order by mo), '[]'::json) from (
                        select to_char(visit_date,'YYYY-MM') mo, count(*) n from cg_visits
                        where visit_date >= (select d0 from m) - interval '11 months'
                          and visit_date < (select d1 from m)
                        group by 1) t),
    'by_moo',         (select coalesce(json_agg(json_build_object('moo', moo, 'n', n) order by moo), '[]'::json) from (
                        select coalesce(moo,'-') moo, count(*) n from la where ltc_group is not null group by 1) t)
  );
$$;

-- ---------- ค่าตั้งต้น ----------
insert into settings(key, value) values
 ('org', '{"name":"องค์การบริหารส่วนตำบล ....","unit":"กองทุนดูแลระยะยาวสำหรับผู้สูงอายุที่มีภาวะพึ่งพิง (LTC)","address":"","phone":"","director":"","director_position":"นายก อบต."}'),
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
    'cm_payments','projects','project_beneficiaries','settings','audit_logs']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- view/function ไม่ให้ anon / authenticated เรียกได้
revoke all on v_latest_adl from anon, authenticated;
revoke execute on function dashboard_summary(text) from public, anon, authenticated;
grant execute on function dashboard_summary(text) to service_role;
