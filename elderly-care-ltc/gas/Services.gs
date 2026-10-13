/**
 * Business logic ทุกโมดูล — ลงทะเบียนใน ACTIONS (action -> {roles, fn, audit})
 */

const R_ALL = ['admin', 'cm', 'cg', 'viewer'];
const R_READ = ['admin', 'cm', 'viewer'];
const R_STAFF = ['admin', 'cm'];
const R_ADMIN = ['admin'];

// ======================= helpers =======================

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('settings');
  if (hit) return JSON.parse(hit);
  const out = {};
  sbSelect('settings', 'select=key,value').forEach(function (r) { out[r.key] = r.value; });
  cache.put('settings', JSON.stringify(out), 300);
  return out;
}

function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

/** รับวันที่หลายรูปแบบ: 2024-01-31, 31/01/2567, 31/1/2024 -> YYYY-MM-DD (ค.ศ.) */
function normDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') { // Excel serial
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  if (y > 2400) y -= 543; // พ.ศ. -> ค.ศ.
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

function monthRange_(period) {
  if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error('รูปแบบงวดต้องเป็น YYYY-MM');
  const y = +period.slice(0, 4), m = +period.slice(5, 7);
  const next = m === 12 ? (y + 1) + '-01' : y + '-' + ('0' + (m + 1)).slice(-2);
  return { from: period + '-01', to: next + '-01' }; // [from, to)
}

function inList_(ids) { return 'in.(' + ids.map(function (i) { return '"' + i + '"'; }).join(',') + ')'; }

function requireOwnCg_(user) {
  if (!user.caregiver_id) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูล Caregiver');
  return user.caregiver_id;
}

const PERSON_EMBED = 'persons(id,cid,prefix,first_name,last_name,moo,birth_date,gender)';

// ======================= ADL =======================

const ADL_FIELDS = ['feeding', 'grooming', 'transfer', 'toilet_use', 'mobility', 'dressing', 'stairs', 'bathing', 'bowels', 'bladder'];

function calcAdl_(a) {
  const cfg = getSettings_().adl || { bed_max: 4, home_max: 11, ltc_max: 11 };
  const total = ADL_FIELDS.reduce(function (s, k) { return s + Number(a[k] || 0); }, 0);
  const level = total <= cfg.bed_max ? 'ติดเตียง' : total <= cfg.home_max ? 'ติดบ้าน' : 'ติดสังคม';
  let group = null;
  if (total <= cfg.ltc_max) {
    if (a.terminal_ill) group = 4;
    else if (total <= cfg.bed_max) group = 3;
    else if (a.cognitive_impairment) group = 2;
    else group = 1;
  }
  return { total_score: total, dependency_level: level, ltc_group: group };
}

// ======================= Persons =======================

function personsList_(p) {
  const f = ['select=*'];
  if (p.q) {
    const s = String(p.q).replace(/[(),*]/g, '');
    f.push('or=' + q_('(first_name.ilike.*' + s + '*,last_name.ilike.*' + s + '*,cid.like.*' + s + '*)'));
  }
  if (p.moo) f.push('moo=eq.' + q_(p.moo));
  f.push('status=eq.' + q_(p.status || 'alive'));
  if (p.elderly) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 60);
    f.push('birth_date=lte.' + Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd'));
  }
  if (p.disabled) f.push('disability_type=not.is.null');
  f.push('order=moo.asc,house_no.asc,first_name.asc');
  const size = Math.min(Number(p.size) || 50, 500);
  const page = Math.max(Number(p.page) || 1, 1);
  const res = sbSelectPaged('persons', f.join('&'), (page - 1) * size, size);
  if (res.rows.length) {
    const adl = sbSelect('v_latest_adl', 'select=person_id,total_score,dependency_level,ltc_group,assess_date&person_id=' +
      inList_(res.rows.map(function (r) { return r.id; })));
    const map = {};
    adl.forEach(function (a) { map[a.person_id] = a; });
    res.rows.forEach(function (r) { r.adl = map[r.id] || null; });
  }
  res.page = page; res.size = size;
  return res;
}

function personsGet_(p, user) {
  const person = sbOne('persons', p.id);
  if (!person) throw new Error('ไม่พบข้อมูล');
  if (user.role === 'cg') {
    const own = sbSelect('care_plans', 'select=id&person_id=eq.' + q_(p.id) + '&cg_id=eq.' + q_(requireOwnCg_(user)));
    if (!own.length) throw new Error('ไม่มีสิทธิ์ดูข้อมูลบุคคลนี้');
  }
  return {
    person: person,
    surveys: sbSelect('surveys', 'select=*&person_id=eq.' + q_(p.id) + '&order=survey_date.desc'),
    adl: sbSelect('adl_assessments', 'select=*&person_id=eq.' + q_(p.id) + '&order=assess_date.desc'),
    plans: sbSelect('care_plans', 'select=*,caregivers(full_name),care_managers(full_name)&person_id=eq.' + q_(p.id) + '&order=created_at.desc'),
    visits: sbSelect('cg_visits', 'select=id,visit_date,status,notes,caregivers(full_name)&person_id=eq.' + q_(p.id) + '&order=visit_date.desc&limit=30')
  };
}

const PERSON_COLS = ['cid', 'prefix', 'first_name', 'last_name', 'gender', 'birth_date', 'house_no', 'moo', 'subdistrict',
  'district', 'province', 'phone', 'health_right', 'disability_type', 'chronic_diseases', 'status'];

function cleanPerson_(r) {
  const o = {};
  PERSON_COLS.forEach(function (k) {
    let v = r[k];
    if (v === undefined) return;
    v = v === null ? null : String(v).trim();
    o[k] = v === '' ? null : v;
  });
  if (o.cid) o.cid = o.cid.replace(/\D/g, '');
  if (o.cid && o.cid.length !== 13) throw new Error('เลขบัตรประชาชนต้องมี 13 หลัก: ' + r.cid);
  if ('birth_date' in o) o.birth_date = normDate_(r.birth_date);
  if (o.gender && ['ชาย', 'หญิง'].indexOf(o.gender) < 0) o.gender = /^(m|ช|1)/i.test(o.gender) ? 'ชาย' : 'หญิง';
  if (!o.status) delete o.status;
  return o;
}

function personsSave_(p) {
  const row = cleanPerson_(p);
  if (!row.first_name || !row.last_name) throw new Error('กรุณากรอกชื่อและนามสกุล');
  row.updated_at = new Date().toISOString();
  if (p.lat !== undefined) row.lat = p.lat === '' ? null : Number(p.lat);
  if (p.lng !== undefined) row.lng = p.lng === '' ? null : Number(p.lng);
  row.id = p.id;
  return sbSave('persons', row);
}

/** นำเข้าข้อมูลประชากรจาก Excel/CSV (แถวที่มี cid ซ้ำจะถูกอัปเดต) */
function personsImport_(p) {
  const rows = p.rows || [];
  if (!rows.length) throw new Error('ไม่มีข้อมูลให้นำเข้า');
  if (rows.length > 5000) throw new Error('นำเข้าได้ครั้งละไม่เกิน 5,000 แถว');
  const withCid = [], noCid = [], errors = [];
  // ใช้เฉพาะคอลัมน์ที่มีในไฟล์ เพื่อไม่ให้ทับข้อมูลเดิมด้วยค่าว่าง
  const present = PERSON_COLS.filter(function (k) {
    return rows.some(function (r) { return r[k] !== undefined && r[k] !== null && r[k] !== ''; });
  });
  rows.forEach(function (r, i) {
    try {
      const o = cleanPerson_(r);
      if (!o.first_name || !o.last_name) throw new Error('ไม่มีชื่อ/นามสกุล');
      // ทุกแถวในชุดเดียวกันต้องมีคีย์เหมือนกันสำหรับ bulk insert ของ PostgREST
      Object.keys(o).forEach(function (k) { if (present.indexOf(k) < 0) delete o[k]; });
      present.forEach(function (k) { if (!(k in o)) o[k] = k === 'status' ? 'alive' : null; });
      (o.cid ? withCid : noCid).push(o);
    } catch (e) { errors.push('แถว ' + (i + 2) + ': ' + e.message); }
  });
  const seen = {};
  const dedup = withCid.filter(function (o) { if (seen[o.cid]) return false; seen[o.cid] = 1; return true; });
  for (let i = 0; i < dedup.length; i += 500) sbInsert('persons', dedup.slice(i, i + 500), 'cid');
  for (let i = 0; i < noCid.length; i += 500) sbInsert('persons', noCid.slice(i, i + 500));
  return { imported: dedup.length + noCid.length, errors: errors };
}

function personsSearch_(p) {
  const s = String(p.q || '').replace(/[(),*]/g, '');
  let f = 'select=id,cid,prefix,first_name,last_name,moo,house_no&status=eq.alive&limit=30&order=first_name';
  if (s) f += '&or=' + q_('(first_name.ilike.*' + s + '*,last_name.ilike.*' + s + '*,cid.like.*' + s + '*)');
  return sbSelect('persons', f);
}

// ======================= Surveys =======================

function surveysList_(p) {
  let f = 'select=*,' + PERSON_EMBED + '&order=survey_date.desc';
  if (p.person_id) f += '&person_id=eq.' + q_(p.person_id);
  if (p.from) f += '&survey_date=gte.' + q_(p.from);
  if (p.to) f += '&survey_date=lte.' + q_(p.to);
  const size = Math.min(Number(p.size) || 50, 500), page = Math.max(Number(p.page) || 1, 1);
  const res = sbSelectPaged('surveys', f, (page - 1) * size, size);
  res.page = page; res.size = size;
  return res;
}

function surveysSave_(p) {
  if (!p.person_id) throw new Error('กรุณาเลือกบุคคล');
  const keys = ['id', 'person_id', 'survey_date', 'surveyor', 'living_arrangement', 'main_caregiver', 'caregiver_relation',
    'income_level', 'housing_condition', 'needs', 'equipment', 'notes'];
  const row = {};
  keys.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  row.survey_date = normDate_(p.survey_date) || today_();
  return sbSave('surveys', row);
}

// ======================= ADL =======================

function adlList_(p) {
  const f = ['select=*'];
  if (p.group === 'eligible') f.push('ltc_group=not.is.null');
  else if (p.group) f.push('ltc_group=eq.' + q_(p.group));
  if (p.level) f.push('dependency_level=eq.' + q_(p.level));
  if (p.moo) f.push('moo=eq.' + q_(p.moo));
  f.push('person_status=eq.alive');
  f.push('order=total_score.asc,moo.asc');
  const size = Math.min(Number(p.size) || 50, 1000), page = Math.max(Number(p.page) || 1, 1);
  const res = sbSelectPaged('v_latest_adl', f.join('&'), (page - 1) * size, size);
  res.page = page; res.size = size;
  return res;
}

function adlSave_(p, user) {
  if (!p.person_id) throw new Error('กรุณาเลือกบุคคล');
  const row = { id: p.id, person_id: p.person_id, assess_date: normDate_(p.assess_date) || today_(),
    assessor: p.assessor || user.full_name, notes: p.notes,
    cognitive_impairment: !!p.cognitive_impairment, terminal_ill: !!p.terminal_ill };
  ADL_FIELDS.forEach(function (k) { row[k] = Number(p[k] || 0); });
  Object.assign(row, calcAdl_(row));
  return sbSave('adl_assessments', row);
}

// ======================= CG / CM =======================

function cgSave_(p) {
  if (!p.full_name) throw new Error('กรุณากรอกชื่อ');
  const keys = ['id', 'full_name', 'cid', 'phone', 'address', 'moo', 'training_hours', 'cert_no', 'start_date', 'cm_id',
    'bank_name', 'bank_account', 'status'];
  const row = {};
  keys.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  if (row.start_date) row.start_date = normDate_(row.start_date);
  return sbSave('caregivers', row);
}

function cmSave_(p) {
  if (!p.full_name) throw new Error('กรุณากรอกชื่อ');
  const keys = ['id', 'full_name', 'cid', 'phone', 'position', 'unit', 'cert_no', 'bank_name', 'bank_account', 'status'];
  const row = {};
  keys.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  return sbSave('care_managers', row);
}

function cgList_() {
  const cgs = sbSelect('caregivers', 'select=*,care_managers(full_name)&order=status.asc,full_name.asc');
  const plans = sbSelect('care_plans', 'select=cg_id&status=in.(approved,active)');
  const cnt = {};
  plans.forEach(function (r) { if (r.cg_id) cnt[r.cg_id] = (cnt[r.cg_id] || 0) + 1; });
  cgs.forEach(function (c) { c.case_count = cnt[c.id] || 0; });
  return cgs;
}

function cmList_() {
  const cms = sbSelect('care_managers', 'select=*&order=status.asc,full_name.asc');
  const plans = sbSelect('care_plans', 'select=cm_id&status=in.(approved,active)');
  const cnt = {};
  plans.forEach(function (r) { if (r.cm_id) cnt[r.cm_id] = (cnt[r.cm_id] || 0) + 1; });
  cms.forEach(function (c) { c.case_count = cnt[c.id] || 0; });
  return cms;
}

// ======================= Care Plans =======================

const PLAN_SELECT = 'select=*,' + PERSON_EMBED + ',caregivers(id,full_name),care_managers(id,full_name)';

function plansList_(p, user) {
  const f = [PLAN_SELECT, 'order=created_at.desc'];
  if (user.role === 'cg') f.push('cg_id=eq.' + q_(requireOwnCg_(user)), 'status=in.(approved,active)');
  else if (p.cg_id) f.push('cg_id=eq.' + q_(p.cg_id));
  if (p.status) f.push('status=eq.' + q_(p.status));
  if (p.person_id) f.push('person_id=eq.' + q_(p.person_id));
  if (p.cm_id) f.push('cm_id=eq.' + q_(p.cm_id));
  return sbSelect('care_plans', f.join('&'));
}

function plansGet_(p, user) {
  const plan = sbSelect('care_plans', PLAN_SELECT + '&id=eq.' + q_(p.id))[0];
  if (!plan) throw new Error('ไม่พบ Care Plan');
  if (user.role === 'cg' && plan.cg_id !== user.caregiver_id) throw new Error('ไม่มีสิทธิ์ดู Care Plan นี้');
  plan.items = sbSelect('care_plan_items', 'select=*&care_plan_id=eq.' + q_(p.id) + '&order=sort.asc');
  plan.revisions = sbSelect('care_plan_revisions', 'select=id,version,reason,changed_by,created_at&care_plan_id=eq.' + q_(p.id) + '&order=version.desc');
  plan.visit_count = sbSelect('cg_visits', 'select=id&care_plan_id=eq.' + q_(p.id)).length;
  return plan;
}

function monthsBetween_(a, b) {
  if (!a || !b) return 12;
  const d1 = new Date(a), d2 = new Date(b);
  const m = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + (d2.getDate() >= d1.getDate() ? 1 : 0);
  return Math.max(1, m);
}

/**
 * บันทึก Care Plan + รายการกิจกรรม
 * - แผนสถานะ draft แก้ไขได้ทันที
 * - แผนที่อนุมัติแล้ว ต้องระบุเหตุผล -> เก็บ snapshot เวอร์ชันเดิมใน care_plan_revisions แล้วเพิ่ม version
 */
function plansSave_(p, user) {
  const plan = p.plan || {};
  const items = (p.items || []).filter(function (i) { return i.activity; });
  if (!plan.person_id) throw new Error('กรุณาเลือกผู้รับบริการ');
  if (!items.length) throw new Error('กรุณาเพิ่มกิจกรรมอย่างน้อย 1 รายการ');

  const monthly = items.reduce(function (s, i) { return s + Number(i.times_per_month || 0) * Number(i.unit_cost || 0); }, 0);
  const row = {
    person_id: plan.person_id, cm_id: plan.cm_id || null, cg_id: plan.cg_id || null, adl_id: plan.adl_id || null,
    ltc_group: plan.ltc_group ? Number(plan.ltc_group) : null, adl_score: plan.adl_score === '' || plan.adl_score == null ? null : Number(plan.adl_score),
    start_date: normDate_(plan.start_date) || today_(), end_date: normDate_(plan.end_date),
    problems: plan.problems || null, goals: plan.goals || null, updated_at: new Date().toISOString()
  };
  row.budget = Math.round(monthly * monthsBetween_(row.start_date, row.end_date) * 100) / 100;

  let saved;
  if (plan.id) {
    const old = plansGet_({ id: plan.id }, user);
    if (old.status === 'closed') throw new Error('แผนที่ปิดแล้วแก้ไขไม่ได้');
    if (old.status !== 'draft') {
      if (!p.reason) throw new Error('แผนนี้อนุมัติแล้ว กรุณาระบุเหตุผลการปรับแก้ Care Plan');
      const snap = Object.assign({}, old);
      delete snap.revisions;
      sbInsert('care_plan_revisions', { care_plan_id: plan.id, version: old.version, reason: p.reason,
        changed_by: user.full_name, snapshot: snap });
      row.version = old.version + 1;
    }
    saved = sbUpdate('care_plans', 'id=eq.' + q_(plan.id), row)[0];
    sbDelete('care_plan_items', 'care_plan_id=eq.' + q_(plan.id));
  } else {
    const year = new Date().getFullYear() + 543;
    const n = sbSelectPaged('care_plans', 'select=id&plan_no=like.' + q_('CP' + year + '-*'), 0, 1).total;
    row.plan_no = 'CP' + year + '-' + ('000' + (n + 1)).slice(-4);
    row.status = 'draft';
    saved = sbInsert('care_plans', row)[0];
  }
  sbInsert('care_plan_items', items.map(function (i, idx) {
    return { care_plan_id: saved.id, category: i.category || null, activity: i.activity,
      times_per_month: Number(i.times_per_month || 0), unit_cost: Number(i.unit_cost || 0),
      responsible: i.responsible || 'CG', sort: idx };
  }));

  const ceiling = row.ltc_group ? Number(((getSettings_().rates || {}).group_budget || {})[row.ltc_group] || 0) : 0;
  saved.warning = ceiling && row.budget > ceiling
    ? 'งบประมาณแผน ' + row.budget.toLocaleString() + ' บาท เกินเพดานกลุ่ม ' + row.ltc_group + ' (' + ceiling.toLocaleString() + ' บาท)'
    : '';
  return saved;
}

function plansStatus_(p, user) {
  const allowed = ['draft', 'approved', 'active', 'closed'];
  if (allowed.indexOf(p.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  const patch = { status: p.status, updated_at: new Date().toISOString() };
  if (p.status === 'approved') { patch.approved_by = user.full_name; patch.approved_at = new Date().toISOString(); }
  if (p.status === 'closed' && !p.end_date) patch.end_date = today_();
  return sbUpdate('care_plans', 'id=eq.' + q_(p.id), patch)[0];
}

function plansRevision_(p) {
  return sbSelect('care_plan_revisions', 'select=*&id=eq.' + q_(p.id))[0];
}

// ======================= CG Visits =======================

function visitsList_(p, user) {
  const f = ['select=*,' + PERSON_EMBED + ',caregivers(full_name),care_plans(plan_no),visit_photos(id)', 'order=visit_date.desc,created_at.desc'];
  if (user.role === 'cg') f.push('cg_id=eq.' + q_(requireOwnCg_(user)));
  else if (p.cg_id) f.push('cg_id=eq.' + q_(p.cg_id));
  if (p.status) f.push('status=eq.' + q_(p.status));
  if (p.person_id) f.push('person_id=eq.' + q_(p.person_id));
  if (p.care_plan_id) f.push('care_plan_id=eq.' + q_(p.care_plan_id));
  if (p.from) f.push('visit_date=gte.' + q_(p.from));
  if (p.to) f.push('visit_date=lte.' + q_(p.to));
  const size = Math.min(Number(p.size) || 50, 500), page = Math.max(Number(p.page) || 1, 1);
  const res = sbSelectPaged('cg_visits', f.join('&'), (page - 1) * size, size);
  res.page = page; res.size = size;
  return res;
}

function visitOwned_(id, user) {
  const v = sbOne('cg_visits', id);
  if (!v) throw new Error('ไม่พบบันทึกการเยี่ยม');
  if (user.role === 'cg' && v.cg_id !== user.caregiver_id) throw new Error('ไม่มีสิทธิ์แก้ไขบันทึกนี้');
  return v;
}

function visitsSave_(p, user) {
  if (!p.care_plan_id) throw new Error('กรุณาเลือก Care Plan');
  const plan = sbOne('care_plans', p.care_plan_id, 'id,person_id,cg_id,status');
  if (!plan) throw new Error('ไม่พบ Care Plan');
  if (['approved', 'active'].indexOf(plan.status) < 0) throw new Error('Care Plan ยังไม่อนุมัติหรือปิดแล้ว');
  let cgId = p.cg_id || plan.cg_id;
  if (user.role === 'cg') {
    cgId = requireOwnCg_(user);
    if (plan.cg_id !== cgId) throw new Error('Care Plan นี้ไม่ได้มอบหมายให้คุณ');
  }
  if (!cgId) throw new Error('Care Plan นี้ยังไม่ได้กำหนด CG');
  if (p.id) {
    const old = visitOwned_(p.id, user);
    if (old.status === 'verified' && user.role === 'cg') throw new Error('บันทึกที่ตรวจสอบแล้วแก้ไขไม่ได้');
  }
  const row = {
    id: p.id, care_plan_id: plan.id, person_id: plan.person_id, cg_id: cgId,
    visit_date: normDate_(p.visit_date) || today_(), start_time: p.start_time || null, end_time: p.end_time || null,
    activities: p.activities || [], vitals: p.vitals || {}, notes: p.notes || null, problems: p.problems || null,
    lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null
  };
  if (p.id) row.status = 'submitted'; // แก้ไขแล้วต้องตรวจใหม่
  return sbSave('cg_visits', row);
}

function visitsAddPhoto_(p, user) {
  visitOwned_(p.visit_id, user);
  const count = sbSelect('visit_photos', 'select=id&visit_id=eq.' + q_(p.visit_id)).length;
  if (count >= 10) throw new Error('แนบรูปได้สูงสุด 10 รูปต่อครั้ง');
  const mime = /^image\/(jpeg|png|webp)$/.test(p.mime) ? p.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^,]+,/, ''));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('ไฟล์รูปใหญ่เกิน 4MB');
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const path = p.visit_id + '/' + Utilities.getUuid() + '.' + ext;
  sbUpload(path, bytes, mime);
  return sbInsert('visit_photos', { visit_id: p.visit_id, storage_path: path, caption: p.caption || null })[0];
}

function visitsGet_(p, user) {
  const v = sbSelect('cg_visits', 'select=*,' + PERSON_EMBED + ',caregivers(full_name),care_plans(plan_no)&id=eq.' + q_(p.id))[0];
  if (!v) throw new Error('ไม่พบบันทึก');
  if (user.role === 'cg' && v.cg_id !== user.caregiver_id) throw new Error('ไม่มีสิทธิ์');
  const photos = sbSelect('visit_photos', 'select=*&visit_id=eq.' + q_(p.id) + '&order=created_at');
  const urls = sbSignedUrls(photos.map(function (x) { return x.storage_path; }), 3600);
  v.photos = photos.map(function (x) { return { id: x.id, caption: x.caption, url: urls[x.storage_path] }; });
  return v;
}

function visitsDeletePhoto_(p, user) {
  const ph = sbOne('visit_photos', p.id);
  if (!ph) return true;
  const v = visitOwned_(ph.visit_id, user);
  if (v.status === 'verified' && user.role === 'cg') throw new Error('บันทึกที่ตรวจสอบแล้วลบรูปไม่ได้');
  sbRemoveFiles([ph.storage_path]);
  return sbDelete('visit_photos', 'id=eq.' + q_(p.id));
}

function visitsVerify_(p, user) {
  if (['verified', 'rejected', 'submitted'].indexOf(p.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  const ids = p.ids || [p.id];
  return sbUpdate('cg_visits', 'id=' + inList_(ids), {
    status: p.status, verified_by: user.full_name, verified_at: new Date().toISOString()
  });
}

function visitsDelete_(p, user) {
  const v = visitOwned_(p.id, user);
  if (user.role === 'cg' && v.status !== 'submitted') throw new Error('ลบได้เฉพาะบันทึกที่ยังไม่ตรวจสอบ');
  const photos = sbSelect('visit_photos', 'select=storage_path&visit_id=eq.' + q_(p.id));
  sbRemoveFiles(photos.map(function (x) { return x.storage_path; }));
  return sbDelete('cg_visits', 'id=eq.' + q_(p.id));
}

// ======================= Payments =======================

/** คำนวณค่าตอบแทน CG ประจำงวด จากการเยี่ยมที่ "ตรวจสอบแล้ว" */
function payCgCalc_(p, user) {
  const r = monthRange_(p.period);
  const rates = getSettings_().rates || {};
  const visits = sbSelect('cg_visits', 'select=cg_id,person_id&status=eq.verified&visit_date=gte.' + r.from + '&visit_date=lt.' + r.to);
  const agg = {};
  visits.forEach(function (v) {
    const a = agg[v.cg_id] = agg[v.cg_id] || { visits: 0, persons: {} };
    a.visits++; a.persons[v.person_id] = 1;
  });
  const existing = {};
  sbSelect('cg_payments', 'select=*&period=eq.' + q_(p.period)).forEach(function (x) { existing[x.cg_id] = x; });
  const mode = rates.cg_mode || 'per_visit';
  const rate = Number(mode === 'per_visit' ? rates.cg_rate_per_visit : rates.cg_rate_per_patient) || 0;
  const cap = Number(rates.cg_monthly_cap) || 0;
  const rows = [];
  Object.keys(agg).forEach(function (cgId) {
    if (existing[cgId] && existing[cgId].status !== 'draft') return; // อนุมัติ/จ่ายแล้ว ไม่คำนวณทับ
    const a = agg[cgId], pc = Object.keys(a.persons).length;
    let amount = (mode === 'per_visit' ? a.visits : pc) * rate;
    if (cap) amount = Math.min(amount, cap);
    rows.push({ period: p.period, cg_id: cgId, visit_count: a.visits, patient_count: pc, rate_mode: mode, rate: rate,
      amount: amount, status: 'draft' });
  });
  // ลบรายการ draft ของ CG ที่ไม่มีการเยี่ยมแล้ว
  Object.keys(existing).forEach(function (cgId) {
    if (!agg[cgId] && existing[cgId].status === 'draft') sbDelete('cg_payments', 'id=eq.' + existing[cgId].id);
  });
  if (rows.length) sbInsert('cg_payments', rows, 'period,cg_id');
  return payCgList_(p, user);
}

function payCgList_(p, user) {
  let f = 'select=*,caregivers(full_name,bank_name,bank_account)&period=eq.' + q_(p.period) + '&order=amount.desc';
  if (user.role === 'cg') f += '&cg_id=eq.' + q_(requireOwnCg_(user));
  return sbSelect('cg_payments', f);
}

/** คำนวณค่าตอบแทน CM: จำนวนเคสที่ดูแล (แผน approved/active ในงวด) + แผนใหม่ที่อนุมัติในงวด */
function payCmCalc_(p, user) {
  const r = monthRange_(p.period);
  const rates = getSettings_().rates || {};
  const plans = sbSelect('care_plans', 'select=id,cm_id,status,start_date,end_date,approved_at&cm_id=not.is.null&status=in.(approved,active,closed)' +
    '&start_date=lt.' + r.to);
  const agg = {};
  plans.forEach(function (pl) {
    if (pl.end_date && pl.end_date < r.from) return;
    const a = agg[pl.cm_id] = agg[pl.cm_id] || { cases: 0, newPlans: 0 };
    a.cases++;
    if (pl.approved_at) {
      const ap = Utilities.formatDate(new Date(pl.approved_at), 'Asia/Bangkok', 'yyyy-MM-dd');
      if (ap >= r.from && ap < r.to) a.newPlans++;
    }
  });
  const existing = {};
  sbSelect('cm_payments', 'select=*&period=eq.' + q_(p.period)).forEach(function (x) { existing[x.cm_id] = x; });
  const cap = Number(rates.cm_monthly_cap) || 0;
  const rows = [];
  Object.keys(agg).forEach(function (cmId) {
    if (existing[cmId] && existing[cmId].status !== 'draft') return;
    const a = agg[cmId];
    let amount = a.cases * (Number(rates.cm_rate_per_case) || 0) + a.newPlans * (Number(rates.cm_rate_per_new_plan) || 0);
    if (cap) amount = Math.min(amount, cap);
    rows.push({ period: p.period, cm_id: cmId, case_count: a.cases, new_plan_count: a.newPlans, amount: amount, status: 'draft' });
  });
  Object.keys(existing).forEach(function (cmId) {
    if (!agg[cmId] && existing[cmId].status === 'draft') sbDelete('cm_payments', 'id=eq.' + existing[cmId].id);
  });
  if (rows.length) sbInsert('cm_payments', rows, 'period,cm_id');
  return payCmList_(p);
}

function payCmList_(p) {
  return sbSelect('cm_payments', 'select=*,care_managers(full_name,bank_name,bank_account)&period=eq.' + q_(p.period) + '&order=amount.desc');
}

function payStatus_(table) {
  return function (p, user) {
    if (['draft', 'approved', 'paid'].indexOf(p.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
    const patch = { status: p.status };
    if (p.status === 'approved') patch.approved_by = user.full_name;
    if (p.status === 'paid') patch.paid_at = today_();
    if (p.note !== undefined) patch.note = p.note;
    return sbUpdate(table, 'id=' + inList_(p.ids), patch);
  };
}

// ======================= Projects =======================

function projectsSave_(p) {
  const pr = p.project || {};
  if (!pr.title) throw new Error('กรุณากรอกชื่อโครงการ');
  const keys = ['id', 'fiscal_year', 'code', 'title', 'rationale', 'objectives', 'target_group', 'target_count', 'location',
    'start_date', 'end_date', 'budget', 'budget_source', 'activities', 'expected_outcomes', 'evaluation', 'responsible', 'status'];
  const row = {};
  keys.forEach(function (k) { if (pr[k] !== undefined) row[k] = pr[k]; });
  row.start_date = normDate_(row.start_date); row.end_date = normDate_(row.end_date);
  row.activities = (row.activities || []).filter(function (a) { return a.name; });
  row.budget = row.activities.length
    ? row.activities.reduce(function (s, a) { return s + Number(a.budget || 0); }, 0)
    : Number(row.budget || 0);
  row.updated_at = new Date().toISOString();
  const saved = sbSave('projects', row);
  if (p.beneficiary_ids) {
    sbDelete('project_beneficiaries', 'project_id=eq.' + q_(saved.id));
    const ids = p.beneficiary_ids.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    for (let i = 0; i < ids.length; i += 500) {
      sbInsert('project_beneficiaries', ids.slice(i, i + 500).map(function (pid) { return { project_id: saved.id, person_id: pid }; }));
    }
  }
  return saved;
}

function projectsGet_(p) {
  const pr = sbOne('projects', p.id);
  if (!pr) throw new Error('ไม่พบโครงการ');
  pr.beneficiaries = sbSelect('project_beneficiaries', 'select=person_id,persons(id,cid,prefix,first_name,last_name,moo,birth_date)&project_id=eq.' + q_(p.id))
    .map(function (b) { return b.persons; });
  return pr;
}

/** ดึงรายชื่อผู้มีภาวะพึ่งพิงที่เข้าเกณฑ์ LTC เพื่อเพิ่มเป็นกลุ่มเป้าหมายโครงการ */
function projectsEligible_() {
  return sbSelect('v_latest_adl', 'select=person_id,prefix,first_name,last_name,moo,total_score,ltc_group&ltc_group=not.is.null&person_status=eq.alive&order=moo');
}

// ======================= Settings & Users =======================

function settingsSave_(p) {
  if (['org', 'rates', 'adl'].indexOf(p.key) < 0) throw new Error('คีย์การตั้งค่าไม่ถูกต้อง');
  sbInsert('settings', { key: p.key, value: p.value, updated_at: new Date().toISOString() }, 'key');
  CacheService.getScriptCache().remove('settings');
  return getSettings_();
}

function usersList_() {
  return sbSelect('app_users', 'select=id,username,full_name,role,caregiver_id,care_manager_id,active,last_login&order=role,username');
}

function usersSave_(p) {
  const row = { full_name: p.full_name, role: p.role, active: p.active !== false && p.active !== 'false',
    caregiver_id: p.caregiver_id || null, care_manager_id: p.care_manager_id || null };
  if (R_ALL.indexOf(row.role) < 0) throw new Error('บทบาทไม่ถูกต้อง');
  if (!row.full_name) throw new Error('กรุณากรอกชื่อ-สกุล');
  if (row.role === 'cg' && !row.caregiver_id) throw new Error('ผู้ใช้บทบาท CG ต้องผูกกับข้อมูล Caregiver');
  if (p.password) {
    if (String(p.password).length < 8) throw new Error('รหัสผ่านอย่างน้อย 8 ตัวอักษร');
    row.salt = newSalt_();
    row.password_hash = hashPassword_(p.password, row.salt);
  }
  if (p.id) return publicUser_(sbUpdate('app_users', 'id=eq.' + q_(p.id), row)[0]);
  const username = String(p.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ใช้ a-z 0-9 . _ - ความยาว 3-30 ตัว');
  if (!p.password) throw new Error('กรุณากำหนดรหัสผ่าน');
  row.username = username;
  return publicUser_(sbInsert('app_users', row)[0]);
}

function changePassword_(p, user) {
  const u = sbOne('app_users', user.id);
  if (hashPassword_(p.old_password, u.salt) !== u.password_hash) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  if (String(p.new_password || '').length < 8) throw new Error('รหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร');
  const salt = newSalt_();
  sbUpdate('app_users', 'id=eq.' + q_(user.id), { salt: salt, password_hash: hashPassword_(p.new_password, salt) });
  return true;
}

// ======================= Dashboard =======================

function dashboard_(p) {
  const month = p.month || Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM');
  return sbRpc('dashboard_summary', { p_month: month });
}

function dashboardCg_(p, user) {
  const cgId = requireOwnCg_(user);
  const r = monthRange_(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM'));
  const plans = sbSelect('care_plans', PLAN_SELECT + '&cg_id=eq.' + q_(cgId) + '&status=in.(approved,active)');
  const visits = sbSelect('cg_visits', 'select=id,status,person_id&cg_id=eq.' + q_(cgId) + '&visit_date=gte.' + r.from + '&visit_date=lt.' + r.to);
  return { plans: plans, visits_month: visits.length,
    verified: visits.filter(function (v) { return v.status === 'verified'; }).length,
    rejected: visits.filter(function (v) { return v.status === 'rejected'; }).length };
}

// ======================= Action registry =======================

const ACTIONS = {
  'me': { roles: R_ALL, fn: function (p, u) { return { user: u, settings: getSettings_() }; } },
  'account.password': { roles: R_ALL, fn: changePassword_, audit: true },

  'dashboard': { roles: R_READ, fn: dashboard_ },
  'dashboard.cg': { roles: ['cg'], fn: dashboardCg_ },

  'persons.list': { roles: R_READ, fn: personsList_ },
  'persons.get': { roles: R_ALL, fn: personsGet_ },
  'persons.search': { roles: R_READ, fn: personsSearch_ },
  'persons.save': { roles: R_STAFF, fn: personsSave_, audit: true },
  'persons.delete': { roles: R_ADMIN, fn: function (p) { return sbDelete('persons', 'id=eq.' + q_(p.id)); }, audit: true },
  'persons.import': { roles: R_STAFF, fn: personsImport_, audit: true },

  'surveys.list': { roles: R_READ, fn: surveysList_ },
  'surveys.save': { roles: R_STAFF, fn: surveysSave_, audit: true },
  'surveys.delete': { roles: R_STAFF, fn: function (p) { return sbDelete('surveys', 'id=eq.' + q_(p.id)); }, audit: true },

  'adl.list': { roles: R_READ, fn: adlList_ },
  'adl.save': { roles: R_STAFF, fn: adlSave_, audit: true },
  'adl.delete': { roles: R_STAFF, fn: function (p) { return sbDelete('adl_assessments', 'id=eq.' + q_(p.id)); }, audit: true },
  'adl.get': { roles: R_READ, fn: function (p) { return sbSelect('adl_assessments', 'select=*,persons(prefix,first_name,last_name)&id=eq.' + q_(p.id))[0]; } },
  'adl.latest': { roles: R_READ, fn: function (p) { return sbSelect('v_latest_adl', 'select=*&person_id=eq.' + q_(p.person_id))[0] || null; } },

  'cg.list': { roles: R_READ, fn: cgList_ },
  'cg.save': { roles: R_STAFF, fn: cgSave_, audit: true },
  'cg.delete': { roles: R_ADMIN, fn: function (p) { return sbDelete('caregivers', 'id=eq.' + q_(p.id)); }, audit: true },
  'cm.list': { roles: R_READ, fn: cmList_ },
  'cm.save': { roles: R_STAFF, fn: cmSave_, audit: true },
  'cm.delete': { roles: R_ADMIN, fn: function (p) { return sbDelete('care_managers', 'id=eq.' + q_(p.id)); }, audit: true },

  'plans.list': { roles: R_ALL, fn: plansList_ },
  'plans.get': { roles: R_ALL, fn: plansGet_ },
  'plans.save': { roles: R_STAFF, fn: plansSave_, audit: true },
  'plans.status': { roles: R_STAFF, fn: plansStatus_, audit: true },
  'plans.revision': { roles: R_READ, fn: plansRevision_ },
  'plans.delete': { roles: R_STAFF, fn: function (p) {
    const pl = sbOne('care_plans', p.id, 'status');
    if (!pl || pl.status !== 'draft') throw new Error('ลบได้เฉพาะแผนสถานะร่าง');
    return sbDelete('care_plans', 'id=eq.' + q_(p.id));
  }, audit: true },

  'visits.list': { roles: R_ALL, fn: visitsList_ },
  'visits.get': { roles: R_ALL, fn: visitsGet_ },
  'visits.save': { roles: ['admin', 'cm', 'cg'], fn: visitsSave_, audit: true },
  'visits.photo': { roles: ['admin', 'cm', 'cg'], fn: visitsAddPhoto_ },
  'visits.photo.delete': { roles: ['admin', 'cm', 'cg'], fn: visitsDeletePhoto_ },
  'visits.verify': { roles: R_STAFF, fn: visitsVerify_, audit: true },
  'visits.delete': { roles: ['admin', 'cm', 'cg'], fn: visitsDelete_, audit: true },

  'pay.cg.calc': { roles: R_STAFF, fn: payCgCalc_, audit: true },
  'pay.cg.list': { roles: R_ALL, fn: payCgList_ },
  'pay.cg.status': { roles: R_STAFF, fn: payStatus_('cg_payments'), audit: true },
  'pay.cm.calc': { roles: R_STAFF, fn: payCmCalc_, audit: true },
  'pay.cm.list': { roles: R_READ, fn: payCmList_ },
  'pay.cm.status': { roles: R_ADMIN, fn: payStatus_('cm_payments'), audit: true },

  'projects.list': { roles: R_READ, fn: function () { return sbSelect('projects', 'select=*&order=fiscal_year.desc,created_at.desc'); } },
  'projects.get': { roles: R_READ, fn: projectsGet_ },
  'projects.save': { roles: R_STAFF, fn: projectsSave_, audit: true },
  'projects.delete': { roles: R_STAFF, fn: function (p) { return sbDelete('projects', 'id=eq.' + q_(p.id)); }, audit: true },
  'projects.eligible': { roles: R_READ, fn: projectsEligible_ },

  'settings.save': { roles: R_ADMIN, fn: settingsSave_, audit: true },
  'users.list': { roles: R_ADMIN, fn: usersList_ },
  'users.save': { roles: R_ADMIN, fn: usersSave_, audit: true },
  'audit.list': { roles: R_ADMIN, fn: function () { return sbSelect('audit_logs', 'select=*&order=id.desc&limit=200'); } },

  'report.data': { roles: R_ALL, fn: function (p, u) { return buildReport_(p, u); } },
  'export.file': { roles: R_ALL, fn: function (p, u) { return exportFile_(p, u); } }
};
