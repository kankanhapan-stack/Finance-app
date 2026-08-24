-- =============================================================================
-- HRM :: 08_performance.sql
-- ประเมินผลการปฏิบัติงาน: รอบประเมิน / แบบฟอร์ม / KPI / ผลประเมิน / เลื่อนขั้น
-- รองรับรูปแบบราชการไทย: ผลสัมฤทธิ์ของงาน (70%) + พฤติกรรม/สมรรถนะ (30%)
-- =============================================================================

create table if not exists appraisal_cycles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,               -- 'รอบที่ 1/2569 (1 ต.ค. 68 - 31 มี.ค. 69)'
  fiscal_year     int not null,
  round_no        int not null default 1,
  start_date      date not null,
  end_date        date not null,
  self_eval_due   date,
  supervisor_due  date,
  calibration_due date,
  status          text not null default 'PLANNED'
                    check (status in ('PLANNED','SELF_EVAL','SUPERVISOR_EVAL','CALIBRATION',
                                      'APPROVED','PUBLISHED','CLOSED','CANCELLED')),
  quota_config    jsonb not null default '{}'::jsonb,  -- โควตาเกรด เช่น {"A":15,"B":30}
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, fiscal_year, round_no)
);

create table if not exists appraisal_forms (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_th         text not null,
  target_scope    jsonb not null default '{}'::jsonb,  -- {employment_types:[], job_families:[], grades:[]}
  section_weights jsonb not null default '{"KPI":70,"COMPETENCY":30}'::jsonb,
  rating_scale    jsonb not null default
                    '[{"code":"A","label":"ดีเด่น","min":90,"max":100},
                      {"code":"B","label":"ดีมาก","min":80,"max":89.99},
                      {"code":"C","label":"ดี","min":70,"max":79.99},
                      {"code":"D","label":"พอใช้","min":60,"max":69.99},
                      {"code":"E","label":"ต้องปรับปรุง","min":0,"max":59.99}]'::jsonb,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (org_id, code)
);

-- หัวข้อประเมินในแบบฟอร์ม
create table if not exists appraisal_form_items (
  id              uuid primary key default gen_random_uuid(),
  form_id         uuid not null references appraisal_forms(id) on delete cascade,
  section         text not null check (section in ('KPI','COMPETENCY','BEHAVIOR','OTHER')),
  item_no         int not null,
  title           text not null,
  description     text,
  measure_unit    text,
  weight_percent  numeric(6,2) not null default 0,
  max_score       numeric(6,2) not null default 5,
  is_required     boolean not null default true,
  unique (form_id, section, item_no)
);

-- KPI รายบุคคล (ตกลงเป้าหมายต้นรอบ)
create table if not exists employee_kpis (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  cycle_id        uuid not null references appraisal_cycles(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  kpi_no          int not null default 1,
  title           text not null,
  description     text,
  target_value    text,
  measure_unit    text,
  weight_percent  numeric(6,2) not null default 0,
  actual_value    text,
  achievement_percent numeric(6,2),
  score           numeric(6,2),
  evidence        text,
  agreed_at       timestamptz,
  agreed_by       uuid references employees(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (cycle_id, employee_id, kpi_no)
);

-- ใบประเมินรายบุคคล
create table if not exists appraisals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  cycle_id        uuid not null references appraisal_cycles(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  form_id         uuid references appraisal_forms(id) on delete set null,
  facility_id     uuid references facilities(id) on delete set null,
  department_id   uuid references departments(id) on delete set null,
  position_id     uuid references positions(id) on delete set null,
  appraiser_id    uuid references employees(id) on delete set null,     -- ผู้ประเมินขั้นต้น
  reviewer_id     uuid references employees(id) on delete set null,     -- ผู้กลั่นกรอง
  approver_id     uuid references employees(id) on delete set null,     -- ผู้บังคับบัญชาเหนือขึ้นไป

  self_score      numeric(6,2),
  kpi_score       numeric(6,2),
  competency_score numeric(6,2),
  total_score     numeric(6,2),
  rating_code     text,
  rating_label    text,
  rank_in_group   int,

  self_comment    text,
  appraiser_comment text,
  reviewer_comment  text,
  strengths       text,
  improvements    text,
  development_note text,

  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','SELF_SUBMITTED','APPRAISED','REVIEWED',
                                      'APPROVED','ACKNOWLEDGED','APPEALED','CLOSED')),
  self_submitted_at timestamptz,
  appraised_at    timestamptz,
  reviewed_at     timestamptz,
  approved_at     timestamptz,
  acknowledged_at timestamptz,          -- บุคลากรรับทราบผล
  acknowledge_note text,
  document_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (cycle_id, employee_id)
);
create index if not exists idx_appraisal_emp on appraisals(employee_id, created_at desc);
create index if not exists idx_appraisal_cycle on appraisals(cycle_id, status);

create table if not exists appraisal_scores (
  id              uuid primary key default gen_random_uuid(),
  appraisal_id    uuid not null references appraisals(id) on delete cascade,
  form_item_id    uuid references appraisal_form_items(id) on delete set null,
  section         text not null,
  item_title      text not null,
  weight_percent  numeric(6,2) not null default 0,
  max_score       numeric(6,2) not null default 5,
  self_score      numeric(6,2),
  appraiser_score numeric(6,2),
  final_score     numeric(6,2),
  weighted_score  numeric(8,4),
  comment         text,
  sort_order      int not null default 0
);
create index if not exists idx_apscore_ap on appraisal_scores(appraisal_id, sort_order);

-- การอุทธรณ์ผลประเมิน
create table if not exists appraisal_appeals (
  id              uuid primary key default gen_random_uuid(),
  appraisal_id    uuid not null references appraisals(id) on delete cascade,
  reason          text not null,
  requested_at    timestamptz not null default now(),
  requested_by    uuid references employees(id) on delete set null,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','REVIEWING','ACCEPTED','REJECTED','WITHDRAWN')),
  decision        text,
  decided_by      uuid references employees(id) on delete set null,
  decided_at      timestamptz,
  new_score       numeric(6,2),
  created_at      timestamptz not null default now()
);

-- ผลการเลื่อนเงินเดือน/เลื่อนขั้นตามผลประเมิน
create table if not exists merit_increases (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  cycle_id        uuid references appraisal_cycles(id) on delete set null,
  employee_id     uuid not null references employees(id) on delete cascade,
  effective_date  date not null,
  rating_code     text,
  increase_percent numeric(6,3),
  increase_amount numeric(14,2),
  old_salary      numeric(14,2),
  new_salary      numeric(14,2),
  order_no        text,
  status          text not null default 'DRAFT'
                    check (status in ('DRAFT','PROPOSED','APPROVED','APPLIED','CANCELLED')),
  approved_by     uuid references employees(id) on delete set null,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  unique (cycle_id, employee_id)
);

-- -----------------------------------------------------------------------------
-- RPC : คำนวณคะแนนรวมและเกรดของใบประเมิน
-- -----------------------------------------------------------------------------
create or replace function fn_calc_appraisal_score(p_appraisal_id uuid)
returns appraisals
language plpgsql
as $$
declare
  v_ap      appraisals%rowtype;
  v_form    appraisal_forms%rowtype;
  v_kpi     numeric := 0;
  v_comp    numeric := 0;
  v_w_kpi   numeric;
  v_w_comp  numeric;
  v_total   numeric;
  v_rating  jsonb;
begin
  select * into v_ap from appraisals where id = p_appraisal_id for update;
  if not found then raise exception 'ไม่พบใบประเมิน %', p_appraisal_id; end if;
  select * into v_form from appraisal_forms where id = v_ap.form_id;

  -- คะแนนถ่วงน้ำหนักแต่ละส่วน (แปลงเป็นสเกล 100)
  update appraisal_scores s
     set weighted_score = case when s.max_score > 0
                          then coalesce(s.final_score, s.appraiser_score, s.self_score, 0)
                               / s.max_score * s.weight_percent
                          else 0 end
   where s.appraisal_id = p_appraisal_id;

  select coalesce(sum(weighted_score),0) into v_kpi
    from appraisal_scores where appraisal_id = p_appraisal_id and section = 'KPI';
  select coalesce(sum(weighted_score),0) into v_comp
    from appraisal_scores where appraisal_id = p_appraisal_id and section in ('COMPETENCY','BEHAVIOR');

  v_w_kpi  := coalesce((v_form.section_weights->>'KPI')::numeric, 70);
  v_w_comp := coalesce((v_form.section_weights->>'COMPETENCY')::numeric, 30);

  v_total := round(v_kpi * v_w_kpi / 100 + v_comp * v_w_comp / 100, 2);

  select x into v_rating
  from jsonb_array_elements(coalesce(v_form.rating_scale,'[]'::jsonb)) x
  where v_total >= (x->>'min')::numeric and v_total <= (x->>'max')::numeric
  limit 1;

  update appraisals set
    kpi_score        = round(v_kpi, 2),
    competency_score = round(v_comp, 2),
    total_score      = v_total,
    rating_code      = v_rating->>'code',
    rating_label     = v_rating->>'label',
    updated_at       = now()
  where id = p_appraisal_id
  returning * into v_ap;

  return v_ap;
end;
$$;
