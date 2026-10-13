/**
 * รายงานและการส่งออกไฟล์
 *  - report.data   -> {title, subtitle, headers, rows} (ฝั่ง client แปลงเป็น Excel ด้วย SheetJS)
 *  - export.file   -> สร้าง Google Docs ชั่วคราว แล้ว export เป็น .docx หรือ .pdf (คืนค่า base64)
 */

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_S = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function thDate_(s, long) {
  if (!s) return '-';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s);
  return (+m[3]) + ' ' + (long ? TH_MONTHS : TH_MONTHS_S)[+m[2] - 1] + ' ' + (+m[1] + 543);
}

function thPeriod_(period) {
  return TH_MONTHS[+period.slice(5, 7) - 1] + ' ' + (+period.slice(0, 4) + 543);
}

function money_(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function age_(birth) {
  if (!birth) return '';
  const b = new Date(birth), t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
  return a;
}

function fullName_(p) { return p ? [p.prefix || '', p.first_name || ''].join('') + ' ' + (p.last_name || '') : '-'; }

/** แปลงจำนวนเงินเป็นตัวอักษรไทย เช่น 1250.50 -> หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์ */
function bahtText_(num) {
  const n = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const u = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];
  function read(s) {
    s = s.replace(/^0+/, '');
    if (!s) return '';
    if (s.length > 6) return read(s.slice(0, -6)) + 'ล้าน' + read(s.slice(-6));
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const d = +s[i], pos = s.length - i - 1;
      if (!d) continue;
      if (pos === 0 && d === 1 && s.length > 1) out += 'เอ็ด';
      else if (pos === 1 && d === 2) out += 'ยี่';
      else if (pos === 1 && d === 1) out += '';
      else out += n[d];
      out += u[pos];
    }
    return out;
  }
  const fixed = Math.abs(Number(num || 0)).toFixed(2).split('.');
  const baht = read(fixed[0]), satang = read(fixed[1]);
  if (!baht && !satang) return 'ศูนย์บาทถ้วน';
  return (baht ? baht + 'บาท' : '') + (satang ? satang + 'สตางค์' : 'ถ้วน');
}

const STATUS_TH = {
  draft: 'ร่าง', approved: 'อนุมัติ', active: 'ดำเนินการ', closed: 'ปิดแผน', submitted: 'รอตรวจ', verified: 'ตรวจแล้ว',
  rejected: 'ส่งกลับ', paid: 'จ่ายแล้ว', running: 'ดำเนินการ', done: 'เสร็จสิ้น', alive: 'มีชีวิต', dead: 'เสียชีวิต', moved: 'ย้ายออก'
};

// ======================= Tabular reports =======================

function buildReport_(p, user) {
  const prm = Object.assign({}, p.params || {}, { _fac: p._fac });
  const facId = facOf_(user, prm);
  const sub = facId ? getFacility_(facId).name || '' : 'ทุกสถานบริการ';
  if (user.role === 'cg' && ['plans', 'visits', 'pay_cg'].indexOf(p.report) < 0) throw new Error('ไม่มีสิทธิ์ส่งออกรายงานนี้');
  let rep;
  switch (p.report) {
    case 'persons': {
      const rows = personsList_(Object.assign({}, prm, { page: 1, size: 500 }), user).rows;
      rep = { title: 'ทะเบียนประชากร' + (prm.elderly ? ' (ผู้สูงอายุ 60 ปีขึ้นไป)' : ''),
        headers: ['ลำดับ', 'เลขบัตรประชาชน', 'ชื่อ-สกุล', 'เพศ', 'อายุ', 'บ้านเลขที่', 'หมู่', 'สิทธิการรักษา', 'โรคประจำตัว', 'ความพิการ', 'ADL', 'ระดับ'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.cid || '', fullName_(r), r.gender || '', age_(r.birth_date), r.house_no || '', r.moo || '', r.health_right || '',
            r.chronic_diseases || '', r.disability_type || '', r.adl ? r.adl.total_score : '', r.adl ? r.adl.dependency_level : ''];
        }), landscape: true };
      break;
    }
    case 'adl': {
      const rows = adlList_(Object.assign({}, prm, { page: 1, size: 1000 }), user).rows;
      rep = { title: 'ผลการประเมินความสามารถในการทำกิจวัตรประจำวัน (ADL) ล่าสุด',
        headers: ['ลำดับ', 'ชื่อ-สกุล', 'หมู่', 'อายุ', 'วันที่ประเมิน', 'คะแนน ADL', 'ระดับการพึ่งพิง', 'กลุ่ม LTC', 'ภาวะสับสน', 'ผู้ประเมิน'],
        rows: rows.map(function (r, i) {
          return [i + 1, fullName_(r), r.moo || '', age_(r.birth_date), thDate_(r.assess_date), r.total_score, r.dependency_level,
            r.ltc_group ? 'กลุ่ม ' + r.ltc_group : 'ไม่เข้าเกณฑ์', r.cognitive_impairment ? 'มี' : '-', r.assessor || ''];
        }), landscape: true };
      break;
    }
    case 'caregivers': {
      const rows = cgList_(prm, user);
      rep = { title: 'ทะเบียนผู้ช่วยเหลือดูแลผู้สูงอายุ (Caregiver)',
        headers: ['ลำดับ', 'ชื่อ-สกุล', 'โทรศัพท์', 'หมู่', 'ชม.อบรม', 'เลขที่ใบรับรอง', 'Care Manager', 'จำนวนผู้รับบริการ', 'สถานะ'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.full_name, r.phone || '', r.moo || '', r.training_hours || '', r.cert_no || '',
            r.care_managers ? r.care_managers.full_name : '', r.case_count, r.status === 'active' ? 'ปฏิบัติงาน' : 'พ้นสภาพ'];
        }) };
      break;
    }
    case 'plans': {
      const rows = plansList_(prm, user);
      rep = { title: 'ทะเบียน Care Plan',
        headers: ['ลำดับ', 'เลขที่แผน', 'ผู้รับบริการ', 'หมู่', 'ADL', 'กลุ่ม', 'CM', 'CG', 'เริ่ม', 'สิ้นสุด', 'งบประมาณ', 'ฉบับที่', 'สถานะ'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.plan_no || '', fullName_(r.persons), r.persons ? r.persons.moo : '', r.adl_score, r.ltc_group || '',
            r.care_managers ? r.care_managers.full_name : '', r.caregivers ? r.caregivers.full_name : '', thDate_(r.start_date),
            thDate_(r.end_date), Number(r.budget || 0), r.version, STATUS_TH[r.status] || r.status];
        }), landscape: true, totalCol: 10 };
      break;
    }
    case 'visits': {
      const rows = visitsList_(Object.assign({}, prm, { page: 1, size: 500 }), user).rows;
      rep = { title: 'บันทึกการปฏิบัติงานของ Caregiver' + (prm.from ? ' ระหว่าง ' + thDate_(prm.from) + ' - ' + thDate_(prm.to) : ''),
        headers: ['ลำดับ', 'วันที่', 'เวลา', 'ผู้รับบริการ', 'หมู่', 'CG', 'กิจกรรมที่ทำ', 'สัญญาณชีพ', 'บันทึก', 'รูป', 'สถานะ'],
        rows: rows.map(function (r, i) {
          const acts = (r.activities || []).filter(function (a) { return a.done; }).map(function (a) { return a.activity; }).join(', ');
          const vt = r.vitals || {};
          const vitals = [vt.bp && 'BP ' + vt.bp, vt.pulse && 'P ' + vt.pulse, vt.temp && 'T ' + vt.temp, vt.dtx && 'DTX ' + vt.dtx].filter(Boolean).join(' ');
          return [i + 1, thDate_(r.visit_date), [r.start_time, r.end_time].filter(Boolean).map(function (t) { return t.slice(0, 5); }).join('-'),
            fullName_(r.persons), r.persons ? r.persons.moo : '', r.caregivers ? r.caregivers.full_name : '', acts, vitals,
            r.notes || '', (r.visit_photos || []).length, STATUS_TH[r.status] || r.status];
        }), landscape: true };
      break;
    }
    case 'pay_cg': {
      const rows = payCgList_(prm, user);
      rep = { title: 'บัญชีรายละเอียดค่าตอบแทนผู้ช่วยเหลือดูแล (Caregiver) ประจำเดือน ' + thPeriod_(prm.period),
        headers: ['ลำดับ', 'ชื่อ-สกุล', 'จำนวนครั้งเยี่ยม', 'จำนวนผู้รับบริการ', 'อัตรา', 'จำนวนเงิน (บาท)', 'ธนาคาร/เลขบัญชี', 'สถานะ', 'ลายมือชื่อผู้รับเงิน'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.caregivers ? r.caregivers.full_name : '', r.visit_count, r.patient_count,
            money_(r.rate) + (r.rate_mode === 'per_visit' ? '/ครั้ง' : '/คน'), Number(r.amount),
            r.caregivers ? [r.caregivers.bank_name, r.caregivers.bank_account].filter(Boolean).join(' ') : '', STATUS_TH[r.status], ''];
        }), totalCol: 5, signatures: ['ผู้จัดทำ', 'ผู้ตรวจสอบ', 'ผู้อนุมัติ'], landscape: true };
      break;
    }
    case 'pay_cm': {
      const rows = payCmList_(prm, user);
      rep = { title: 'บัญชีรายละเอียดค่าตอบแทนผู้จัดการระบบการดูแล (Care Manager) ประจำเดือน ' + thPeriod_(prm.period),
        headers: ['ลำดับ', 'ชื่อ-สกุล', 'จำนวนเคสที่ดูแล', 'แผนใหม่ที่อนุมัติ', 'จำนวนเงิน (บาท)', 'ธนาคาร/เลขบัญชี', 'สถานะ', 'ลายมือชื่อผู้รับเงิน'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.care_managers ? r.care_managers.full_name : '', r.case_count, r.new_plan_count, Number(r.amount),
            r.care_managers ? [r.care_managers.bank_name, r.care_managers.bank_account].filter(Boolean).join(' ') : '', STATUS_TH[r.status], ''];
        }), totalCol: 4, signatures: ['ผู้จัดทำ', 'ผู้ตรวจสอบ', 'ผู้อนุมัติ'], landscape: true };
      break;
    }
    case 'projects': {
      const rows = sbSelect('projects', 'select=*&order=fiscal_year.desc' + facQ_(user, prm));
      rep = { title: 'ทะเบียนโครงการดูแลผู้สูงอายุและผู้พิการที่มีภาวะพึ่งพิง',
        headers: ['ลำดับ', 'ปีงบประมาณ', 'รหัส', 'ชื่อโครงการ', 'กลุ่มเป้าหมาย', 'จำนวน', 'ระยะเวลา', 'งบประมาณ', 'แหล่งงบ', 'สถานะ'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.fiscal_year || '', r.code || '', r.title, r.target_group || '', r.target_count || '',
            thDate_(r.start_date) + ' - ' + thDate_(r.end_date), Number(r.budget || 0), r.budget_source || '', STATUS_TH[r.status] || r.status];
        }), totalCol: 7, landscape: true };
      break;
    }
    case 'budget': {
      if (user.role === 'cg') throw new Error('ไม่มีสิทธิ์');
      const fy = Number(prm.fy) || currentFiscalYear_();
      const rows = budgetReport_({ fy: fy, _fac: prm._fac }, user) || [];
      rep = { title: 'รายงานการเบิกจ่ายงบโครงการดูแลผู้สูงอายุที่มีภาวะพึ่งพิง รายสถานบริการ ปีงบประมาณ ' + fy,
        headers: ['ลำดับ', 'ชื่อสถานบริการ', 'จำนวนผู้สูงอายุที่มีภาวะพึ่งพิง (คน)', 'จำนวนเงินงบประมาณ (บาท)', 'เบิกจ่ายแล้ว (บาท)', 'คงเหลือ (บาท)', 'ร้อยละเบิกจ่าย'],
        rows: rows.map(function (r, i) {
          return [i + 1, r.name + (r.budget_estimated ? ' *' : ''), r.dependents, Number(r.budget), Number(r.paid), Number(r.remaining),
            r.budget ? (Math.round(r.paid / r.budget * 1000) / 10) + '%' : '-'];
        }), moneyCols: [3, 4, 5], sumCols: [2, 3, 4, 5],
        note: '* ยังไม่ได้บันทึกงบที่ได้รับจัดสรร ระบบประมาณจาก จำนวนผู้มีภาวะพึ่งพิง x อัตราต่อคนต่อปี · เบิกจ่ายแล้ว = ค่าตอบแทน CG/CM สถานะจ่ายแล้วในปีงบประมาณ' };
      break;
    }
    default:
      throw new Error('ไม่รู้จักรายงาน ' + p.report);
  }
  rep.subtitle = sub;
  rep.printed = 'พิมพ์เมื่อ ' + thDate_(today_(), true);
  return rep;
}

// ======================= Google Docs builder =======================

const FONT = 'Sarabun';

function newDoc_(title, landscape) {
  const doc = DocumentApp.create('ltc-export-' + title.slice(0, 40) + '-' + Date.now());
  const body = doc.getBody();
  if (landscape) body.setPageWidth(842).setPageHeight(595);
  body.setMarginTop(40).setMarginBottom(40).setMarginLeft(54).setMarginRight(40);
  return doc;
}

function para_(body, text, opt) {
  opt = opt || {};
  const p = body.appendParagraph(text || '');
  p.editAsText().setFontFamily(FONT).setFontSize(opt.size || 14).setBold(!!opt.bold);
  if (opt.center) p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  if (opt.right) p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  if (opt.indent) p.setIndentFirstLine(36);
  p.setSpacingAfter(opt.after == null ? 2 : opt.after).setSpacingBefore(opt.before || 0);
  return p;
}

function heading_(body, text) { return para_(body, text, { bold: true, size: 15, before: 8 }); }

function table_(body, headers, rows, opt) {
  opt = opt || {};
  const cells = [headers.map(String)].concat(rows.map(function (r) {
    return r.map(function (c) { return String(c == null ? '' : c); });
  }));
  const t = body.appendTable(cells);
  t.editAsText().setFontFamily(FONT).setFontSize(opt.size || 12);
  t.setBorderColor('#888888');
  const hdr = t.getRow(0);
  for (let c = 0; c < hdr.getNumCells(); c++) {
    hdr.getCell(c).setBackgroundColor('#e3efe7').editAsText().setBold(true);
    hdr.getCell(c).getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  }
  for (let r = 0; r < t.getNumRows(); r++) {
    const row = t.getRow(r);
    for (let c = 0; c < row.getNumCells(); c++) row.getCell(c).setPaddingTop(2).setPaddingBottom(2).setPaddingLeft(4).setPaddingRight(4);
  }
  return t;
}

function signatures_(body, labels) {
  para_(body, '', {});
  const cells = [labels.map(function (l) {
    return '\n\nลงชื่อ.......................................\n(.......................................)\n' + l;
  })];
  const t = body.appendTable(cells);
  t.setBorderWidth(0);
  t.editAsText().setFontFamily(FONT).setFontSize(13);
  for (let c = 0; c < labels.length; c++) {
    const cell = t.getRow(0).getCell(c);
    for (let i = 0; i < cell.getNumChildren(); i++) cell.getChild(i).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  }
}

function docHeader_(body, title, subtitle) {
  const first = body.getParagraphs()[0];
  first.setText(title);
  first.editAsText().setFontFamily(FONT).setFontSize(17).setBold(true);
  first.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  if (subtitle) para_(body, subtitle, { center: true, size: 14, after: 6 });
}

/** export Google Doc เป็นไฟล์ แล้วลบไฟล์ชั่วคราว */
function finishDoc_(doc, format, filename) {
  doc.saveAndClose();
  const id = doc.getId();
  try {
    const res = UrlFetchApp.fetch('https://docs.google.com/document/d/' + id + '/export?format=' + format, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('ส่งออกไฟล์ไม่สำเร็จ (' + res.getResponseCode() + ')');
    const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return { filename: filename + '.' + format, mime: mime, base64: Utilities.base64Encode(res.getBlob().getBytes()) };
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}

function exportFile_(p, user) {
  const format = p.format === 'pdf' ? 'pdf' : 'docx';
  if (p.report === 'careplan') return finishDoc_(carePlanDoc_(p.params.id, user), format, 'careplan');
  if (p.report === 'project') {
    if (user.role === 'cg') throw new Error('ไม่มีสิทธิ์');
    return finishDoc_(projectDoc_(p.params.id, user), format, 'project');
  }
  if (p.report === 'visit') return finishDoc_(visitDoc_(p.params.id, user), format, 'visit');

  const rep = buildReport_(p, user);
  const doc = newDoc_(rep.title, rep.landscape);
  const body = doc.getBody();
  docHeader_(body, rep.title, rep.subtitle);
  const moneyCols = rep.moneyCols || (rep.totalCol != null ? [rep.totalCol] : []);
  const rows = rep.rows.map(function (r) {
    return r.map(function (c, i) { return moneyCols.indexOf(i) >= 0 ? money_(c) : c; });
  });
  if (rep.sumCols) {
    const tot = rep.headers.map(function () { return ''; });
    tot[1] = 'รวมทั้งสิ้น';
    rep.sumCols.forEach(function (c) {
      const sum = rep.rows.reduce(function (s, r) { return s + Number(r[c] || 0); }, 0);
      tot[c] = moneyCols.indexOf(c) >= 0 ? money_(sum) : sum.toLocaleString();
    });
    rows.push(tot);
    table_(body, rep.headers, rows, { size: 11 });
  } else if (rep.totalCol != null) {
    const sum = rep.rows.reduce(function (s, r) { return s + Number(r[rep.totalCol] || 0); }, 0);
    const tot = rep.headers.map(function () { return ''; });
    tot[1] = 'รวมทั้งสิ้น';
    tot[rep.totalCol] = money_(sum);
    rows.push(tot);
    table_(body, rep.headers, rows, { size: 11 });
    para_(body, '(' + bahtText_(sum) + ')', { right: true, size: 13, before: 4 });
  } else {
    table_(body, rep.headers, rows, { size: 11 });
  }
  if (rep.note) para_(body, rep.note, { size: 11, before: 4 });
  para_(body, 'จำนวน ' + rep.rows.length + ' รายการ   ' + rep.printed, { size: 11, before: 4 });
  if (rep.signatures) signatures_(body, rep.signatures);
  return finishDoc_(doc, format, p.report);
}

// ---------- เอกสาร Care Plan รายบุคคล ----------
function carePlanDoc_(id, user) {
  const plan = plansGet_({ id: id }, user);
  const person = sbOne('persons', plan.person_id);
  const org = getFacility_(plan.facility_id);
  const doc = newDoc_('careplan', false);
  const body = doc.getBody();
  docHeader_(body, 'แผนการดูแลรายบุคคล (Care Plan)', org.name);
  para_(body, 'เลขที่แผน ' + (plan.plan_no || '-') + '   ฉบับที่ ' + plan.version + '   สถานะ: ' + (STATUS_TH[plan.status] || plan.status), { center: true, size: 13, after: 8 });

  heading_(body, '1. ข้อมูลผู้รับบริการ');
  const info = [
    ['ชื่อ-สกุล', fullName_(person), 'เลขบัตรประชาชน', person.cid || '-'],
    ['อายุ', age_(person.birth_date) + ' ปี', 'เพศ', person.gender || '-'],
    ['ที่อยู่', [person.house_no, person.moo ? 'หมู่ ' + person.moo : '', person.subdistrict, person.district, person.province].filter(Boolean).join(' '), 'โทรศัพท์', person.phone || '-'],
    ['โรคประจำตัว', person.chronic_diseases || '-', 'สิทธิการรักษา', person.health_right || '-'],
    ['คะแนน ADL', String(plan.adl_score == null ? '-' : plan.adl_score), 'กลุ่มชุดสิทธิประโยชน์', plan.ltc_group ? 'กลุ่ม ' + plan.ltc_group : '-'],
    ['Care Manager', plan.care_managers ? plan.care_managers.full_name : '-', 'Caregiver', plan.caregivers ? plan.caregivers.full_name : '-'],
    ['ระยะเวลาแผน', thDate_(plan.start_date, true) + ' ถึง ' + thDate_(plan.end_date, true), 'งบประมาณ', money_(plan.budget) + ' บาท']
  ];
  const t = body.appendTable(info);
  t.editAsText().setFontFamily(FONT).setFontSize(12);
  t.setBorderColor('#999999');
  for (let r = 0; r < info.length; r++) {
    t.getRow(r).getCell(0).setBackgroundColor('#f1f1ec').editAsText().setBold(true);
    t.getRow(r).getCell(2).setBackgroundColor('#f1f1ec').editAsText().setBold(true);
  }

  heading_(body, '2. ปัญหาและความต้องการ');
  para_(body, plan.problems || '-', { indent: true });
  heading_(body, '3. เป้าหมายการดูแล');
  para_(body, plan.goals || '-', { indent: true });

  heading_(body, '4. กิจกรรมการดูแล');
  let monthly = 0;
  const rows = plan.items.map(function (it, i) {
    const sub = Number(it.times_per_month || 0) * Number(it.unit_cost || 0);
    monthly += sub;
    return [i + 1, it.category || '', it.activity, it.times_per_month, money_(it.unit_cost), money_(sub), it.responsible || ''];
  });
  rows.push(['', '', 'รวมต่อเดือน', '', '', money_(monthly), '']);
  table_(body, ['ที่', 'ด้าน', 'กิจกรรม', 'ครั้ง/เดือน', 'บาท/ครั้ง', 'รวม/เดือน', 'ผู้รับผิดชอบ'], rows, { size: 12 });
  para_(body, 'งบประมาณตลอดแผน ' + money_(plan.budget) + ' บาท (' + bahtText_(plan.budget) + ')', { before: 6, bold: true, size: 13 });

  if (plan.revisions.length) {
    heading_(body, '5. ประวัติการปรับแก้แผน');
    table_(body, ['ฉบับเดิม', 'วันที่ปรับ', 'เหตุผล', 'ผู้ปรับ'], plan.revisions.map(function (r) {
      return [r.version, thDate_(String(r.created_at).slice(0, 10)), r.reason, r.changed_by || ''];
    }), { size: 12 });
  }
  signatures_(body, ['ผู้จัดทำแผน (Care Manager)' + (org.cm_name ? '\n' + org.cm_name : ''), 'ผู้ให้บริการ (Caregiver)', 'ผู้รับบริการ/ญาติ']);
  signatures_(body, ['ผู้อนุมัติแผน' + (org.approver_name ? '\n' + org.approver_name : plan.approved_by ? '\n' + plan.approved_by : '') +
    (org.approver_position ? '\n' + org.approver_position : '')]);
  return doc;
}

// ---------- เอกสารบันทึกการเยี่ยม ----------
function visitDoc_(id, user) {
  const v = visitsGet_({ id: id }, user);
  const doc = newDoc_('visit', false);
  const body = doc.getBody();
  docHeader_(body, 'บันทึกการปฏิบัติงานของผู้ช่วยเหลือดูแล (Caregiver)', getFacility_(v.facility_id).name);
  para_(body, 'ผู้รับบริการ: ' + fullName_(v.persons) + '   หมู่ ' + (v.persons.moo || '-') + '   Care Plan: ' + (v.care_plans ? v.care_plans.plan_no : '-'));
  para_(body, 'วันที่ ' + thDate_(v.visit_date, true) + '   เวลา ' + (v.start_time || '').slice(0, 5) + ' - ' + (v.end_time || '').slice(0, 5) +
    '   ผู้ปฏิบัติ: ' + (v.caregivers ? v.caregivers.full_name : '-'));
  const vt = v.vitals || {};
  para_(body, 'สัญญาณชีพ: BP ' + (vt.bp || '-') + '  ชีพจร ' + (vt.pulse || '-') + '  อุณหภูมิ ' + (vt.temp || '-') + '  DTX ' + (vt.dtx || '-') + '  น้ำหนัก ' + (vt.weight || '-'));
  heading_(body, 'กิจกรรมที่ดำเนินการ');
  table_(body, ['ที่', 'กิจกรรม', 'ผล'], (v.activities || []).map(function (a, i) { return [i + 1, a.activity, a.done ? '✔ ทำแล้ว' : '✘ ไม่ได้ทำ']; }), { size: 12 });
  heading_(body, 'บันทึกเพิ่มเติม / ปัญหาที่พบ');
  para_(body, (v.notes || '-') + (v.problems ? '\nปัญหา: ' + v.problems : ''), { indent: true });
  if (v.photos.length) {
    heading_(body, 'ภาพประกอบการปฏิบัติงาน');
    v.photos.forEach(function (ph) {
      try {
        const blob = UrlFetchApp.fetch(ph.url).getBlob();
        const img = body.appendParagraph('').appendInlineImage(blob);
        const w = img.getWidth(), h = img.getHeight(), maxW = 300;
        if (w > maxW) { img.setWidth(maxW); img.setHeight(Math.round(h * maxW / w)); }
        if (ph.caption) para_(body, ph.caption, { size: 12 });
      } catch (e) { console.warn('photo', e); }
    });
  }
  para_(body, 'สถานะ: ' + (STATUS_TH[v.status] || v.status) + (v.verified_by ? ' โดย ' + v.verified_by : ''), { before: 6 });
  signatures_(body, ['ผู้ปฏิบัติงาน (Caregiver)', 'ผู้ตรวจสอบ (Care Manager)']);
  return doc;
}

// ---------- เอกสารโครงการ ----------
function projectDoc_(id, user) {
  const pr = projectsGet_({ id: id }, user);
  const org = getFacility_(pr.facility_id);
  const doc = newDoc_('project', false);
  const body = doc.getBody();
  docHeader_(body, 'โครงการ' + pr.title.replace(/^โครงการ/, ''), org.name);
  if (pr.fiscal_year) para_(body, 'ประจำปีงบประมาณ ' + pr.fiscal_year, { center: true, after: 8 });

  let n = 1;
  function sec(title, text) {
    heading_(body, (n++) + '. ' + title);
    String(text || '-').split(/\n/).forEach(function (line) { para_(body, line, { indent: true }); });
  }
  sec('ชื่อโครงการ', pr.title);
  sec('หลักการและเหตุผล', pr.rationale);
  sec('วัตถุประสงค์', pr.objectives);
  sec('กลุ่มเป้าหมาย', (pr.target_group || '-') + (pr.target_count ? ' จำนวน ' + pr.target_count + ' คน' : ''));
  sec('ระยะเวลาดำเนินการ', thDate_(pr.start_date, true) + ' ถึง ' + thDate_(pr.end_date, true));
  sec('สถานที่ดำเนินการ', pr.location);

  heading_(body, (n++) + '. วิธีดำเนินการ / กิจกรรม');
  const acts = pr.activities || [];
  if (acts.length) {
    const rows = acts.map(function (a, i) { return [i + 1, a.name, a.detail || '', a.period || '', money_(a.budget)]; });
    rows.push(['', 'รวม', '', '', money_(pr.budget)]);
    table_(body, ['ที่', 'กิจกรรม', 'รายละเอียด', 'ระยะเวลา', 'งบประมาณ (บาท)'], rows, { size: 12 });
  } else para_(body, '-', { indent: true });

  sec('งบประมาณ', 'จาก ' + (pr.budget_source || '-') + ' จำนวน ' + money_(pr.budget) + ' บาท (' + bahtText_(pr.budget) + ')\n(ทุกรายการถัวเฉลี่ยจ่ายได้ตามที่จ่ายจริง)');
  sec('ผลที่คาดว่าจะได้รับ', pr.expected_outcomes);
  sec('การติดตามและประเมินผล', pr.evaluation);
  sec('ผู้รับผิดชอบโครงการ', pr.responsible);

  signatures_(body, ['ผู้เสนอโครงการ', 'ผู้เห็นชอบโครงการ']);
  signatures_(body, ['ผู้อนุมัติโครงการ' + (org.approver_name ? '\n' + org.approver_name : '') + '\n' + (org.approver_position || '')]);

  if (pr.beneficiaries.length) {
    body.appendPageBreak();
    para_(body, 'ภาคผนวก: รายชื่อกลุ่มเป้าหมาย', { bold: true, size: 15, center: true, after: 6 });
    table_(body, ['ที่', 'ชื่อ-สกุล', 'อายุ', 'หมู่', 'เลขบัตรประชาชน'], pr.beneficiaries.filter(Boolean).map(function (b, i) {
      return [i + 1, fullName_(b), age_(b.birth_date), b.moo || '', b.cid || ''];
    }), { size: 12 });
  }
  return doc;
}
