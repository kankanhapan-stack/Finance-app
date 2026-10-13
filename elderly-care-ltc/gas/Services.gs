/**
 * Business logic ทุกโมดูล — ลงทะเบียนใน ACTIONS (action -> {roles, fn, audit})
 *
 * หลายสถานบริการ (multi-facility)
 *  - ผู้ใช้ที่มี facility_id  : เห็น/แก้ไขได้เฉพาะข้อมูลของสถานบริการตนเอง
 *  - ผู้ใช้ส่วนกลาง (facility_id = null; admin/viewer) : เห็นทุกแห่ง และเลือกสถานบริการที่กำลังทำงานได้
 *    (ฝั่งหน้าเว็บส่งมาใน payload._fac) การบันทึกข้อมูลใหม่ต้องเลือกสถานบริการก่อน
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

/** ปีงบประมาณ (พ.ศ.) ปัจจุบัน: ต.ค.-ธ.ค. นับเป็นปีงบถัดไป */
function currentFiscalYear_() {
  const d = new Date();
  return d.getFullYear() + 543 + (d.getMonth() >= 9 ? 1 : 0);
}

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

function addYear_(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  d.setFullYear(d.getFullYear() + 1); d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
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

// ---------- facility scope ----------

function isCentral_(user) { return !user.facility_id; }

/** สถานบริการที่ใช้กรองข้อมูล (null = ทุกแห่ง สำหรับผู้ใช้ส่วนกลาง) */
function facOf_(user, p) { return user.facility_id || (p && p._fac) || null; }

/** สถานบริการที่ต้องมีเมื่อบันทึกข้อมูลใหม่ */
function facReq_(user, p) {
  const f = facOf_(user, p);
  if (!f) throw new Error('กรุณาเลือกสถานบริการก่อน (ช่องเลือกสถานบริการด้านบน)');
  return f;
}

/** ส่วนต่อท้าย query สำหรับกรองตามสถานบริการ */
function facQ_(user, p) { const f = facOf_(user, p); return f ? '&facility_id=eq.' + q_(f) : ''; }

function checkFac_(row, user) {
  if (!row) throw new Error('ไม่พบข้อมูล');
  if (user.facility_id && row.facility_id !== user.facility_id) throw new Error('ไม่มีสิทธิ์เข้าถึงข้อมูลของสถานบริการอื่น');
  return row;
}

function ownRow_(table, id, user, select) { return checkFac_(sbOne(table, id, select || '*'), user); }

function ownAdl_(id, user) {
  const a = sbSelect('adl_assessments', 'select=*,persons(prefix,first_name,last_name,facility_id)&id=eq.' + q_(id))[0];
  if (!a) throw new Error('ไม่พบผลประเมิน');
  checkFac_({ facility_id: a.persons && a.persons.facility_id }, user);
  return a;
}

function getFacility_(id) {
  if (!id) return {};
  return sbOne('facilities', id) || {};
}

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

function personsList_(p, user) {
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
  const res = sbSelectPaged('persons', f.join('&') + facQ_(user, p), (page - 1) * size, size);
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
  const person = ownRow_('persons', p.id, user);
  if (user.role === 'cg') {
    const own = sbSelect('care_plans', 'select=id&person_id=eq.' + q_(p.id) + '&cg_id=eq.' + q_(requireOwnCg_(user)));
    if (!own.length) throw new Error('ไม่มีสิทธิ์ดูข้อมูลบุคคลนี้');
  }
  return {
    person: person,
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

function personsSave_(p, user) {
  const row = cleanPerson_(p);
  if (!row.first_name || !row.last_name) throw new Error('กรุณากรอกชื่อและนามสกุล');
  row.updated_at = new Date().toISOString();
  if (p.lat !== undefined) row.lat = p.lat === '' ? null : Number(p.lat);
  if (p.lng !== undefined) row.lng = p.lng === '' ? null : Number(p.lng);
  if (p.id) ownRow_('persons', p.id, user, 'id,facility_id');
  else row.facility_id = facReq_(user, p);
  if (row.cid) {
    const dup = sbSelect('persons', 'select=id,facility_id&cid=eq.' + q_(row.cid))[0];
    if (dup && dup.id !== p.id) throw new Error('เลขบัตรประชาชนนี้มีในทะเบียนแล้ว' + (dup.facility_id !== facOf_(user, p) ? ' (อยู่ในสถานบริการอื่น)' : ''));
  }
  row.id = p.id;
  return sbSave('persons', row);
}

/** นำเข้าข้อมูลประชากรจาก Excel/CSV (แถวที่มี cid ซ้ำในสถานบริการเดียวกันจะถูกอัปเดต) */
function personsImport_(p, user) {
  const fac = facReq_(user, p);
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
      o.facility_id = fac;
      o._row = i + 2;
      (o.cid ? withCid : noCid).push(o);
    } catch (e) { errors.push('แถว ' + (i + 2) + ': ' + e.message); }
  });
  const seen = {};
  let dedup = withCid.filter(function (o) { if (seen[o.cid]) return false; seen[o.cid] = 1; return true; });
  // ห้ามทับข้อมูลบุคคลที่อยู่ในสถานบริการอื่น
  const other = {};
  for (let i = 0; i < dedup.length; i += 200) {
    sbSelect('persons', 'select=cid&facility_id=neq.' + q_(fac) + '&cid=' + inList_(dedup.slice(i, i + 200).map(function (o) { return o.cid; })))
      .forEach(function (x) { other[x.cid] = 1; });
  }
  dedup = dedup.filter(function (o) {
    if (!other[o.cid]) return true;
    errors.push('แถว ' + o._row + ': เลขบัตร ' + o.cid + ' อยู่ในทะเบียนของสถานบริการอื่น');
    return false;
  });
  [dedup, noCid].forEach(function (list) { list.forEach(function (o) { delete o._row; }); });
  for (let i = 0; i < dedup.length; i += 500) sbInsert('persons', dedup.slice(i, i + 500), 'cid');
  for (let i = 0; i < noCid.length; i += 500) sbInsert('persons', noCid.slice(i, i + 500));
  return { imported: dedup.length + noCid.length, errors: errors };
}

function personsSearch_(p, user) {
  const s = String(p.q || '').replace(/[(),*]/g, '');
  let f = 'select=id,cid,prefix,first_name,last_name,moo,house_no&status=eq.alive&limit=30&order=first_name' + facQ_(user, p);
  if (s) f += '&or=' + q_('(first_name.ilike.*' + s + '*,last_name.ilike.*' + s + '*,cid.like.*' + s + '*)');
  return sbSelect('persons', f);
}

// ======================= ADL =======================

function adlList_(p, user) {
  const f = ['select=*'];
  if (p.group === 'eligible') f.push('ltc_group=not.is.null');
  else if (p.group) f.push('ltc_group=eq.' + q_(p.group));
  if (p.level) f.push('dependency_level=eq.' + q_(p.level));
  if (p.moo) f.push('moo=eq.' + q_(p.moo));
  f.push('person_status=eq.alive');
  f.push('order=total_score.asc,moo.asc');
  const size = Math.min(Number(p.size) || 50, 1000), page = Math.max(Number(p.page) || 1, 1);
  const res = sbSelectPaged('v_latest_adl', f.join('&') + facQ_(user, p), (page - 1) * size, size);
  res.page = page; res.size = size;
  return res;
}

function adlSave_(p, user) {
  if (!p.person_id) throw new Error('กรุณาเลือกบุคคล');
  ownRow_('persons', p.person_id, user, 'id,facility_id');
  if (p.id) ownAdl_(p.id, user);
  const row = { id: p.id, person_id: p.person_id, assess_date: normDate_(p.assess_date) || today_(),
    assessor: p.assessor || user.full_name, notes: p.notes,
    cognitive_impairment: !!p.cognitive_impairment, terminal_ill: !!p.terminal_ill };
  ADL_FIELDS.forEach(function (k) { row[k] = Number(p[k] || 0); });
  Object.assign(row, calcAdl_(row));
  return sbSave('adl_assessments', row);
}

// ======================= CG / CM =======================

function cgSave_(p, user) {
  if (!p.full_name) throw new Error('กรุณากรอกชื่อ');
  const keys = ['id', 'full_name', 'cid', 'phone', 'address', 'moo', 'training_hours', 'cert_no', 'start_date', 'cm_id',
    'bank_name', 'bank_account', 'status'];
  const row = {};
  keys.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  if (row.start_date) row.start_date = normDate_(row.start_date);
  if (p.id) ownRow_('caregivers', p.id, user, 'id,facility_id');
  else row.facility_id = facReq_(user, p);
  return sbSave('caregivers', row);
}

function cmSave_(p, user) {
  if (!p.full_name) throw new Error('กรุณากรอกชื่อ');
  const keys = ['id', 'full_name', 'cid', 'phone', 'position', 'unit', 'cert_no', 'bank_name', 'bank_account', 'status'];
  const row = {};
  keys.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  if (p.id) ownRow_('care_managers', p.id, user, 'id,facility_id');
  else row.facility_id = facReq_(user, p);
  return sbSave('care_managers', row);
}

function cgList_(p, user) {
  const fq = facQ_(user, p);
  const cgs = sbSelect('caregivers', 'select=*,care_managers(full_name),facilities(name)&order=status.asc,full_name.asc' + fq);
  const plans = sbSelect('care_plans', 'select=cg_id&status=in.(approved,active)' + fq);
  const cnt = {};
  plans.forEach(function (r) { if (r.cg_id) cnt[r.cg_id] = (cnt[r.cg_id] || 0) + 1; });
  cgs.forEach(function (c) { c.case_count = cnt[c.id] || 0; });
  return cgs;
}

function cmList_(p, user) {
  const fq = facQ_(user, p);
  const cms = sbSelect('care_managers', 'select=*,facilities(name)&order=status.asc,full_name.asc' + fq);
  const plans = sbSelect('care_plans', 'select=cm_id&status=in.(approved,active)' + fq);
  const cnt = {};
  plans.forEach(function (r) { if (r.cm_id) cnt[r.cm_id] = (cnt[r.cm_id] || 0) + 1; });
  cms.forEach(function (c) { c.case_count = cnt[c.id] || 0; });
  return cms;
}

/** ผู้รับบริการที่ CG คนนี้ดูแลอยู่ (แผนที่ยังไม่ปิด) */
function cgPatients_(p, user) {
  ownRow_('caregivers', p.cg_id, user, 'id,facility_id');
  return sbSelect('care_plans', PLAN_SELECT + '&cg_id=eq.' + q_(p.cg_id) + '&status=neq.closed&order=created_at.desc');
}

/** ผู้มีภาวะพึ่งพิง (เข้าเกณฑ์ LTC) ในสถานบริการของ CG พร้อมชื่อ CG ที่ดูแลอยู่ (ถ้ามี) */
function cgCandidates_(p, user) {
  const cg = ownRow_('caregivers', p.cg_id, user, 'id,facility_id');
  const fac = q_(cg.facility_id);
  const el = sbSelect('v_latest_adl', 'select=person_id,prefix,first_name,last_name,moo,total_score,ltc_group,dependency_level' +
    '&ltc_group=not.is.null&person_status=eq.alive&facility_id=eq.' + fac + '&order=moo,first_name');
  const plans = sbSelect('care_plans', 'select=person_id,cg_id,caregivers(full_name)&status=neq.closed&facility_id=eq.' + fac);
  const who = {};
  plans.forEach(function (x) { if (x.cg_id) who[x.person_id] = { cg_id: x.cg_id, name: x.caregivers && x.caregivers.full_name }; });
  return el.map(function (x) {
    x.cg_id = who[x.person_id] ? who[x.person_id].cg_id : null;
    x.cg_name = who[x.person_id] ? who[x.person_id].name : null;
    return x;
  });
}

/**
 * CG รับดูแลผู้รับบริการ
 *  - ถ้าผู้รับบริการมี Care Plan ที่ยังไม่ปิด -> กำหนด CG ให้แผนนั้น
 *  - ถ้ายังไม่มี -> สร้าง Care Plan ฉบับร่าง (ดึงผล ADL ล่าสุด) ให้ CM เติมกิจกรรมและอนุมัติต่อ
 */
function cgAssign_(p, user) {
  const cg = ownRow_('caregivers', p.cg_id, user, 'id,facility_id,cm_id,full_name,status');
  if (cg.status !== 'active') throw new Error('CG คนนี้พ้นสภาพแล้ว');
  const person = ownRow_('persons', p.person_id, user, 'id,facility_id,prefix,first_name,last_name');
  if (person.facility_id !== cg.facility_id) throw new Error('ผู้รับบริการและ CG ต้องอยู่สถานบริการเดียวกัน');
  const plan = sbSelect('care_plans', 'select=id,plan_no,status&person_id=eq.' + q_(person.id) + '&status=neq.closed&order=created_at.desc&limit=1')[0];
  if (plan) {
    sbUpdate('care_plans', 'id=eq.' + q_(plan.id), { cg_id: cg.id, updated_at: new Date().toISOString() });
    return { plan_id: plan.id, plan_no: plan.plan_no, created: false };
  }
  const adl = sbSelect('v_latest_adl', 'select=id,total_score,ltc_group&person_id=eq.' + q_(person.id))[0] || {};
  const start = today_();
  const saved = sbInsert('care_plans', {
    plan_no: nextPlanNo_(), person_id: person.id, facility_id: person.facility_id, cg_id: cg.id, cm_id: cg.cm_id || null,
    adl_id: adl.id || null, adl_score: adl.total_score == null ? null : adl.total_score, ltc_group: adl.ltc_group || null,
    start_date: start, end_date: addYear_(start), status: 'draft', budget: 0
  })[0];
  return { plan_id: saved.id, plan_no: saved.plan_no, created: true };
}

function cgUnassign_(p, user) {
  const plan = ownRow_('care_plans', p.plan_id, user, 'id,facility_id,cg_id');
  if (p.cg_id && plan.cg_id !== p.cg_id) throw new Error('แผนนี้ไม่ได้อยู่ในความดูแลของ CG คนนี้');
  return sbUpdate('care_plans', 'id=eq.' + q_(plan.id), { cg_id: null, updated_at: new Date().toISOString() })[0];
}

// ======================= Care Plans =======================

const PLAN_SELECT = 'select=*,' + PERSON_EMBED + ',caregivers(id,full_name),care_managers(id,full_name)';

function nextPlanNo_() {
  const year = new Date().getFullYear() + 543;
  const n = sbSelectPaged('care_plans', 'select=id&plan_no=like.' + q_('CP' + year + '-*'), 0, 1).total;
  return 'CP' + year + '-' + ('000' + (n + 1)).slice(-4);
}

function plansList_(p, user) {
  const f = [PLAN_SELECT, 'order=created_at.desc'];
  if (user.role === 'cg') f.push('cg_id=eq.' + q_(requireOwnCg_(user)), 'status=in.(approved,active)');
  else if (p.cg_id) f.push('cg_id=eq.' + q_(p.cg_id));
  if (p.status) f.push('status=eq.' + q_(p.status));
  if (p.person_id) f.push('person_id=eq.' + q_(p.person_id));
  if (p.cm_id) f.push('cm_id=eq.' + q_(p.cm_id));
  return sbSelect('care_plans', f.join('&') + facQ_(user, p));
}

function plansGet_(p, user) {
  const plan = sbSelect('care_plans', PLAN_SELECT + '&id=eq.' + q_(p.id))[0];
  checkFac_(plan, user);
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
  const person = ownRow_('persons', plan.person_id, user, 'id,facility_id');

  const monthly = items.reduce(function (s, i) { return s + Number(i.times_per_month || 0) * Number(i.unit_cost || 0); }, 0);
  const row = {
    person_id: plan.person_id, facility_id: person.facility_id, cm_id: plan.cm_id || null, cg_id: plan.cg_id || null, adl_id: plan.adl_id || null,
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
    row.plan_no = nextPlanNo_();
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
  ownRow_('care_plans', p.id, user, 'id,facility_id');
  const patch = { status: p.status, updated_at: new Date().toISOString() };
  if (p.status === 'approved') { patch.approved_by = user.full_name; patch.approved_at = new Date().toISOString(); }
  if (p.status === 'closed' && !p.end_date) patch.end_date = today_();
  return sbUpdate('care_plans', 'id=eq.' + q_(p.id), patch)[0];
}

function plansRevision_(p, user) {
  const r = sbSelect('care_plan_revisions', 'select=*&id=eq.' + q_(p.id))[0];
  if (!r) throw new Error('ไม่พบข้อมูล');
  ownRow_('care_plans', r.care_plan_id, user, 'id,facility_id');
  return r;
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
  const res = sbSelectPaged('cg_visits', f.join('&') + facQ_(user, p), (page - 1) * size, size);
  res.page = page; res.size = size;
  return res;
}

function visitOwned_(id, user) {
  const v = ownRow_('cg_visits', id, user);
  if (user.role === 'cg' && v.cg_id !== user.caregiver_id) throw new Error('ไม่มีสิทธิ์แก้ไขบันทึกนี้');
  return v;
}

function visitsSave_(p, user) {
  if (!p.care_plan_id) throw new Error('กรุณาเลือก Care Plan');
  const plan = ownRow_('care_plans', p.care_plan_id, user, 'id,person_id,cg_id,status,facility_id');
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
    id: p.id, care_plan_id: plan.id, person_id: plan.person_id, cg_id: cgId, facility_id: plan.facility_id,
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
  checkFac_(v, user);
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
  return sbUpdate('cg_visits', 'id=' + inList_(ids) + facQ_(user, p), {
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

/** คำนวณค่าตอบแทน CG ประจำงวด (รายสถานบริการ) จากการเยี่ยมที่ "ตรวจสอบแล้ว" */
function payCgCalc_(p, user) {
  const fac = facReq_(user, p);
  const r = monthRange_(p.period);
  const rates = getSettings_().rates || {};
  const visits = sbSelect('cg_visits', 'select=cg_id,person_id&status=eq.verified&visit_date=gte.' + r.from + '&visit_date=lt.' + r.to +
    '&facility_id=eq.' + q_(fac));
  const agg = {};
  visits.forEach(function (v) {
    const a = agg[v.cg_id] = agg[v.cg_id] || { visits: 0, persons: {} };
    a.visits++; a.persons[v.person_id] = 1;
  });
  const existing = {};
  sbSelect('cg_payments', 'select=*&period=eq.' + q_(p.period) + '&facility_id=eq.' + q_(fac)).forEach(function (x) { existing[x.cg_id] = x; });
  const mode = rates.cg_mode || 'per_visit';
  const rate = Number(mode === 'per_visit' ? rates.cg_rate_per_visit : rates.cg_rate_per_patient) || 0;
  const cap = Number(rates.cg_monthly_cap) || 0;
  const rows = [];
  Object.keys(agg).forEach(function (cgId) {
    if (existing[cgId] && existing[cgId].status !== 'draft') return; // อนุมัติ/จ่ายแล้ว ไม่คำนวณทับ
    const a = agg[cgId], pc = Object.keys(a.persons).length;
    let amount = (mode === 'per_visit' ? a.visits : pc) * rate;
    if (cap) amount = Math.min(amount, cap);
    rows.push({ period: p.period, cg_id: cgId, facility_id: fac, visit_count: a.visits, patient_count: pc, rate_mode: mode, rate: rate,
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
  let f = 'select=*,caregivers(full_name,bank_name,bank_account),facilities(name)&period=eq.' + q_(p.period) + '&order=amount.desc' + facQ_(user, p);
  if (user.role === 'cg') f += '&cg_id=eq.' + q_(requireOwnCg_(user));
  return sbSelect('cg_payments', f);
}

/** คำนวณค่าตอบแทน CM: จำนวนเคสที่ดูแล (แผน approved/active ในงวด) + แผนใหม่ที่อนุมัติในงวด */
function payCmCalc_(p, user) {
  const fac = facReq_(user, p);
  const r = monthRange_(p.period);
  const rates = getSettings_().rates || {};
  const plans = sbSelect('care_plans', 'select=id,cm_id,status,start_date,end_date,approved_at&cm_id=not.is.null&status=in.(approved,active,closed)' +
    '&start_date=lt.' + r.to + '&facility_id=eq.' + q_(fac));
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
  sbSelect('cm_payments', 'select=*&period=eq.' + q_(p.period) + '&facility_id=eq.' + q_(fac)).forEach(function (x) { existing[x.cm_id] = x; });
  const cap = Number(rates.cm_monthly_cap) || 0;
  const rows = [];
  Object.keys(agg).forEach(function (cmId) {
    if (existing[cmId] && existing[cmId].status !== 'draft') return;
    const a = agg[cmId];
    let amount = a.cases * (Number(rates.cm_rate_per_case) || 0) + a.newPlans * (Number(rates.cm_rate_per_new_plan) || 0);
    if (cap) amount = Math.min(amount, cap);
    rows.push({ period: p.period, cm_id: cmId, facility_id: fac, case_count: a.cases, new_plan_count: a.newPlans, amount: amount, status: 'draft' });
  });
  Object.keys(existing).forEach(function (cmId) {
    if (!agg[cmId] && existing[cmId].status === 'draft') sbDelete('cm_payments', 'id=eq.' + existing[cmId].id);
  });
  if (rows.length) sbInsert('cm_payments', rows, 'period,cm_id');
  return payCmList_(p, user);
}

function payCmList_(p, user) {
  return sbSelect('cm_payments', 'select=*,care_managers(full_name,bank_name,bank_account),facilities(name)&period=eq.' + q_(p.period) +
    '&order=amount.desc' + facQ_(user, p));
}

function payStatus_(table) {
  return function (p, user) {
    if (['draft', 'approved', 'paid'].indexOf(p.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
    const patch = { status: p.status };
    if (p.status === 'approved') patch.approved_by = user.full_name;
    if (p.status === 'paid') patch.paid_at = today_();
    if (p.note !== undefined) patch.note = p.note;
    return sbUpdate(table, 'id=' + inList_(p.ids) + facQ_(user, p), patch);
  };
}

// ======================= Projects =======================

function projectsSave_(p, user) {
  const pr = p.project || {};
  if (!pr.title) throw new Error('กรุณากรอกชื่อโครงการ');
  const keys = ['id', 'fiscal_year', 'code', 'title', 'rationale', 'objectives', 'target_group', 'target_count', 'method', 'location',
    'start_date', 'end_date', 'budget', 'budget_source', 'activities', 'expected_outcomes', 'evaluation', 'responsible', 'status'];
  const row = {};
  keys.forEach(function (k) { if (pr[k] !== undefined) row[k] = pr[k]; });
  row.start_date = normDate_(row.start_date); row.end_date = normDate_(row.end_date);
  row.activities = (row.activities || []).filter(function (a) { return a.name; });
  row.budget = row.activities.length
    ? row.activities.reduce(function (s, a) { return s + Number(a.budget || 0); }, 0)
    : Number(row.budget || 0);
  row.updated_at = new Date().toISOString();
  if (pr.id) ownRow_('projects', pr.id, user, 'id,facility_id');
  else row.facility_id = facReq_(user, p);
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

function projectsGet_(p, user) {
  const pr = ownRow_('projects', p.id, user);
  pr.beneficiaries = sbSelect('project_beneficiaries', 'select=person_id,persons(id,cid,prefix,first_name,last_name,moo,birth_date)&project_id=eq.' + q_(p.id))
    .map(function (b) { return b.persons; });
  return pr;
}

/** ดึงรายชื่อผู้มีภาวะพึ่งพิงที่เข้าเกณฑ์ LTC เพื่อเพิ่มเป็นกลุ่มเป้าหมายโครงการ */
function projectsEligible_(p, user) {
  return sbSelect('v_latest_adl', 'select=person_id,prefix,first_name,last_name,moo,total_score,ltc_group&ltc_group=not.is.null&person_status=eq.alive&order=moo' +
    facQ_(user, p));
}

// ======================= Facilities =======================

const FACILITY_COLS = ['code', 'name', 'cm_name', 'cm_position', 'director_name', 'director_position', 'fund_name', 'center_chair',
  'center_chair_position', 'lao_name',
  'address', 'subdistrict', 'district', 'province', 'phone', 'approver_name', 'approver_position', 'active'];

function facilitiesList_(p, user) {
  let f = 'select=*&order=name';
  if (user.facility_id) f += '&id=eq.' + q_(user.facility_id);
  return sbSelect('facilities', f);
}

function facilitiesSave_(p, user) {
  if (!p.name) throw new Error('กรุณากรอกชื่อสถานบริการ');
  if (!p.id && !isCentral_(user)) throw new Error('เพิ่มสถานบริการใหม่ได้เฉพาะผู้ดูแลระบบส่วนกลาง');
  if (p.id && user.facility_id && p.id !== user.facility_id) throw new Error('แก้ไขได้เฉพาะข้อมูลสถานบริการของตนเอง');
  const row = { id: p.id };
  FACILITY_COLS.forEach(function (k) { if (p[k] !== undefined) row[k] = p[k]; });
  if (row.active !== undefined) row.active = row.active !== false && row.active !== 'false';
  if (!isCentral_(user)) delete row.active;
  return sbSave('facilities', row);
}

function facilityBudgets_(p, user) {
  const fac = p.facility_id || facReq_(user, p);
  checkFac_({ facility_id: fac }, user);
  return sbSelect('facility_budgets', 'select=*&facility_id=eq.' + q_(fac) + '&order=fiscal_year.desc');
}

function facilityBudgetSave_(p, user) {
  const fac = p.facility_id || facReq_(user, p);
  checkFac_({ facility_id: fac }, user);
  const fy = Number(p.fiscal_year);
  if (!(fy > 2500 && fy < 2700)) throw new Error('ปีงบประมาณ (พ.ศ.) ไม่ถูกต้อง');
  return sbInsert('facility_budgets', { facility_id: fac, fiscal_year: fy, amount: Number(p.amount || 0), note: p.note || null,
    updated_at: new Date().toISOString() }, 'facility_id,fiscal_year')[0];
}

/** รายงานการเบิกจ่ายงบรายสถานบริการ */
function budgetReport_(p, user) {
  return sbRpc('facility_budget_report', { p_fy: Number(p.fy) || currentFiscalYear_(), p_facility: facOf_(user, p) });
}

// ======================= Settings & Users =======================

function settingsSave_(p, user) {
  if (!isCentral_(user)) throw new Error('อัตราและเกณฑ์กลาง แก้ไขได้เฉพาะผู้ดูแลระบบส่วนกลาง');
  if (['rates', 'adl'].indexOf(p.key) < 0) throw new Error('คีย์การตั้งค่าไม่ถูกต้อง');
  sbInsert('settings', { key: p.key, value: p.value, updated_at: new Date().toISOString() }, 'key');
  CacheService.getScriptCache().remove('settings');
  return getSettings_();
}

function usersList_(p, user) {
  let f = 'select=id,username,full_name,role,facility_id,caregiver_id,care_manager_id,active,last_login,facilities(name)&order=role,username';
  if (user.facility_id) f += '&facility_id=eq.' + q_(user.facility_id);
  else if (p._fac) f += '&facility_id=eq.' + q_(p._fac);
  return sbSelect('app_users', f);
}

function usersSave_(p, user) {
  const row = { full_name: p.full_name, role: p.role, active: p.active !== false && p.active !== 'false',
    caregiver_id: p.caregiver_id || null, care_manager_id: p.care_manager_id || null,
    facility_id: user.facility_id || p.facility_id || null };
  if (R_ALL.indexOf(row.role) < 0) throw new Error('บทบาทไม่ถูกต้อง');
  if (!row.full_name) throw new Error('กรุณากรอกชื่อ-สกุล');
  if (!row.facility_id && (row.role === 'cm' || row.role === 'cg')) throw new Error('ผู้ใช้บทบาท CM / CG ต้องระบุสถานบริการ');
  if (row.role === 'cg' && !row.caregiver_id) throw new Error('ผู้ใช้บทบาท CG ต้องผูกกับข้อมูล Caregiver');
  if (row.caregiver_id) checkFac_(sbOne('caregivers', row.caregiver_id, 'facility_id'), { facility_id: row.facility_id || user.facility_id });
  if (p.id) {
    const old = sbOne('app_users', p.id, 'id,facility_id');
    checkFac_(old, user);
    if (old.id === user.id && (!row.active || row.role !== 'admin')) throw new Error('ไม่สามารถลดสิทธิ์หรือระงับบัญชีของตนเองได้');
  }
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

function dashboard_(p, user) {
  const month = p.month || Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM');
  return sbRpc('dashboard_summary', { p_month: month, p_facility: facOf_(user, p) });
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

function delOwn_(table) {
  return function (p, user) { ownRow_(table, p.id, user, 'id,facility_id'); return sbDelete(table, 'id=eq.' + q_(p.id)); };
}

const ACTIONS = {
  'me': { roles: R_ALL, fn: function (p, u) { return { user: u, settings: getSettings_(), facilities: facilitiesList_(p, u) }; } },
  'account.password': { roles: R_ALL, fn: changePassword_, audit: true },

  'dashboard': { roles: R_READ, fn: dashboard_ },
  'dashboard.cg': { roles: ['cg'], fn: dashboardCg_ },
  'budget.report': { roles: R_READ, fn: budgetReport_ },

  'persons.list': { roles: R_READ, fn: personsList_ },
  'persons.get': { roles: R_ALL, fn: personsGet_ },
  'persons.search': { roles: R_READ, fn: personsSearch_ },
  'persons.save': { roles: R_STAFF, fn: personsSave_, audit: true },
  'persons.delete': { roles: R_ADMIN, fn: delOwn_('persons'), audit: true },
  'persons.import': { roles: R_STAFF, fn: personsImport_, audit: true },

  'adl.list': { roles: R_READ, fn: adlList_ },
  'adl.save': { roles: R_STAFF, fn: adlSave_, audit: true },
  'adl.delete': { roles: R_STAFF, fn: function (p, u) { ownAdl_(p.id, u); return sbDelete('adl_assessments', 'id=eq.' + q_(p.id)); }, audit: true },
  'adl.get': { roles: R_READ, fn: function (p, u) { return ownAdl_(p.id, u); } },
  'adl.latest': { roles: R_READ, fn: function (p, u) {
    ownRow_('persons', p.person_id, u, 'id,facility_id');
    return sbSelect('v_latest_adl', 'select=*&person_id=eq.' + q_(p.person_id))[0] || null;
  } },

  'cg.list': { roles: R_READ, fn: cgList_ },
  'cg.save': { roles: R_STAFF, fn: cgSave_, audit: true },
  'cg.delete': { roles: R_ADMIN, fn: delOwn_('caregivers'), audit: true },
  'cg.patients': { roles: R_READ, fn: cgPatients_ },
  'cg.candidates': { roles: R_STAFF, fn: cgCandidates_ },
  'cg.assign': { roles: R_STAFF, fn: cgAssign_, audit: true },
  'cg.unassign': { roles: R_STAFF, fn: cgUnassign_, audit: true },
  'cm.list': { roles: R_READ, fn: cmList_ },
  'cm.save': { roles: R_STAFF, fn: cmSave_, audit: true },
  'cm.delete': { roles: R_ADMIN, fn: delOwn_('care_managers'), audit: true },

  'plans.list': { roles: R_ALL, fn: plansList_ },
  'plans.get': { roles: R_ALL, fn: plansGet_ },
  'plans.save': { roles: R_STAFF, fn: plansSave_, audit: true },
  'plans.status': { roles: R_STAFF, fn: plansStatus_, audit: true },
  'plans.revision': { roles: R_READ, fn: plansRevision_ },
  'plans.delete': { roles: R_STAFF, fn: function (p, u) {
    const pl = ownRow_('care_plans', p.id, u, 'id,status,facility_id');
    if (pl.status !== 'draft') throw new Error('ลบได้เฉพาะแผนสถานะร่าง');
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

  'projects.list': { roles: R_READ, fn: function (p, u) { return sbSelect('projects', 'select=*,facilities(name)&order=fiscal_year.desc,created_at.desc' + facQ_(u, p)); } },
  'projects.get': { roles: R_READ, fn: projectsGet_ },
  'projects.save': { roles: R_STAFF, fn: projectsSave_, audit: true },
  'projects.delete': { roles: R_STAFF, fn: delOwn_('projects'), audit: true },
  'projects.eligible': { roles: R_READ, fn: projectsEligible_ },

  'facilities.list': { roles: R_ALL, fn: facilitiesList_ },
  'facilities.save': { roles: R_ADMIN, fn: facilitiesSave_, audit: true },
  'facilities.budgets': { roles: R_READ, fn: facilityBudgets_ },
  'facilities.budget.save': { roles: R_ADMIN, fn: facilityBudgetSave_, audit: true },

  'settings.save': { roles: R_ADMIN, fn: settingsSave_, audit: true },
  'users.list': { roles: R_ADMIN, fn: usersList_ },
  'users.save': { roles: R_ADMIN, fn: usersSave_, audit: true },
  'audit.list': { roles: R_ADMIN, fn: function (p, u) {
    let f = 'select=*&order=id.desc&limit=200';
    if (u.facility_id) {
      const names = sbSelect('app_users', 'select=username&facility_id=eq.' + q_(u.facility_id)).map(function (x) { return x.username; });
      if (!names.length) return [];
      f += '&username=' + inList_(names);
    }
    return sbSelect('audit_logs', f);
  } },

  'report.data': { roles: R_ALL, fn: function (p, u) { return buildReport_(p, u); } },
  'export.file': { roles: R_ALL, fn: function (p, u) { return exportFile_(p, u); } }
};
