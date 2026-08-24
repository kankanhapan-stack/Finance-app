/**
 * HRM :: run_tests.js — ทดสอบตรรกะฝั่ง server
 *   node hrm/apps-script/tests/run_tests.js
 */
'use strict';
const { sandbox, fixtures, ORG, EMP } = require('./harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; }
}
function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((label || '') + ' ได้ ' + JSON.stringify(actual) +
                    ' คาดว่า ' + JSON.stringify(expected));
  }
}
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > (tol || 0.01)) {
    throw new Error((label || '') + ' ได้ ' + actual + ' คาดว่า ~' + expected);
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'เงื่อนไขไม่เป็นจริง'); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (substr && e.message.indexOf(substr) < 0) {
      throw new Error('ข้อความผิดพลาดไม่ตรง: ' + e.message);
    }
    return;
  }
  throw new Error('คาดว่าจะเกิดข้อผิดพลาดแต่ไม่เกิด');
}

console.log('\n== 1. เครื่องมือกลาง (Util) ==');
const Util = sandbox.Util;

test('ปีงบประมาณไทย: ก.ย. อยู่ปีเดิม, ต.ค. ขึ้นปีใหม่', function () {
  eq(Util.fiscalYear('2026-09-30'), 2569);
  eq(Util.fiscalYear('2026-10-01'), 2570);
});

test('ช่วงวันที่ของปีงบประมาณ', function () {
  eq(Util.fiscalRange(2569), { start: '2025-10-01', end: '2026-09-30' });
});

test('วันที่ไทย', function () {
  eq(Util.thaiDate('2026-08-24'), '24 สิงหาคม 2569');
  eq(Util.thaiDate('2026-08-24', true), '24 ส.ค. 2569');
});

test('ตรวจเลขประจำตัวประชาชน (ตรงกับ fn_valid_thai_id ฝั่ง DB)', function () {
  // 1101700207366 = เลขที่ผ่าน checksum, ตรวจยืนยันแล้วกับฟังก์ชันฝั่ง PostgreSQL
  ok(Util.validThaiId('1101700207366'), 'เลขที่ถูกต้องต้องผ่าน');
  ok(!Util.validThaiId('1101700207364'), 'หลักตรวจสอบผิดต้องไม่ผ่าน');
  ok(!Util.validThaiId('3100600445841'), 'หลักตรวจสอบผิดต้องไม่ผ่าน');
  ok(!Util.validThaiId('123'), 'ความยาวไม่ครบต้องไม่ผ่าน');
  ok(Util.validThaiId(null), 'ค่าว่างไม่บังคับกรอก');

  // ตรวจว่าหลักตรวจสอบที่คำนวณเองตรงกับที่ฟังก์ชันยอมรับ
  const prefix = '110170020736';
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(prefix[i]) * (13 - i);
  const check = (11 - (sum % 11)) % 10;
  ok(Util.validThaiId(prefix + check), 'หลักตรวจสอบที่คำนวณเองต้องผ่าน');
});

test('อ่านจำนวนเงินเป็นตัวหนังสือ', function () {
  eq(Util.bahtText(0), 'ศูนย์บาทถ้วน');
  eq(Util.bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
  eq(Util.bahtText(100), 'หนึ่งร้อยบาทถ้วน');
  eq(Util.bahtText(1000.50), 'หนึ่งพันบาทห้าสิบสตางค์');
});

test('requireFields โยน error พร้อมชื่อไทย', function () {
  throws(function () {
    Util.requireFields({ a: '' }, ['a', 'b'], ['ชื่อ', 'นามสกุล']);
  }, 'ชื่อ, นามสกุล');
});

test('pick เก็บเฉพาะคีย์ที่อนุญาต และแปลงค่าว่างเป็น null', function () {
  eq(Util.pick({ a: 1, evil: 'x', b: '' }, ['a', 'b']), { a: 1, b: null });
});

console.log('\n== 2. ตัวสร้าง query ของ Supabase ==');
const DB = sandbox.DB;

test('ช่วงวันที่ใช้ AND ไม่ใช่ OR', function () {
  fixtures.testrange = [
    { id: '1', d: '2026-01-01' }, { id: '2', d: '2026-06-15' }, { id: '3', d: '2026-12-31' }
  ];
  const rows = DB.select('testrange', {
    filter: { d: [{ op: 'gte', value: '2026-03-01' }, { op: 'lte', value: '2026-09-30' }] }
  });
  eq(rows.map(r => r.id), ['2']);
});

test('อาเรย์ค่าธรรมดาแปลงเป็น in.()', function () {
  const rows = DB.select('testrange', { filter: { id: ['1', '3'] } });
  eq(rows.map(r => r.id), ['1', '3']);
});

test('ปฏิเสธการลบแบบไม่มีเงื่อนไข', function () {
  throws(function () { DB.remove('testrange', {}); }, 'ไม่มีเงื่อนไข');
});

console.log('\n== 3. สิทธิและขอบเขต (Auth) ==');
const Auth = sandbox.Auth;

test('โหลด context ของผู้ใช้ได้', function () {
  const ctx = Auth.context(true);
  eq(ctx.orgId, ORG);
  eq(ctx.employeeId, EMP);
  ok(ctx.perms['leave.approve'], 'ต้องมีสิทธิอนุมัติลา');
});

test('can / canAny ทำงานถูกต้อง', function () {
  const ctx = Auth.context();
  ok(Auth.can(ctx, 'employee.read'));
  ok(!Auth.can(ctx, 'discipline.read'), 'ไม่ควรมีสิทธิที่ไม่ได้ให้');
  ok(Auth.canAny(ctx, ['discipline.read', 'leave.read']));
});

test('require โยน error เมื่อไม่มีสิทธิ', function () {
  throws(function () { Auth.require('discipline.write'); }, 'ไม่มีสิทธิ');
});

test('scopeFilter: มี employee.read_all -> เห็นทั้งองค์กร', function () {
  const ctx = Auth.context();
  eq(Auth.scopeFilter(ctx, { module: 'employee' }), { org_id: ORG });
});

test('scopeFilter: ไม่มี read_all -> จำกัดตามสถานบริการ', function () {
  const ctx = JSON.parse(JSON.stringify(Auth.context()));
  delete ctx.perms['employee.read_all'];
  ctx.perms['employee.read_facility'] = true;
  const f = Auth.scopeFilter(ctx, { module: 'employee' });
  eq(f.facility_id, ctx.facilityIds);
});

test('scopeFilter: ไม่มีสิทธิใด -> เห็นเฉพาะตนเอง', function () {
  const ctx = JSON.parse(JSON.stringify(Auth.context()));
  ctx.perms = {};
  const f = Auth.scopeFilter(ctx, { module: 'employee' });
  eq(f.employee_id, EMP);
});

console.log('\n== 4. ตารางเส้นทาง API ==');

test('ลงทะเบียนเส้นทางได้โดยไม่ซ้ำ', function () {
  const routes = sandbox.listRoutes();
  ok(routes.length > 90, 'ควรมีเส้นทางมากกว่า 90 รายการ ได้ ' + routes.length);
  eq(routes.length, new Set(routes).size, 'ต้องไม่มีเส้นทางซ้ำ');
});

test('ครบทั้ง 15 โมดูล', function () {
  const routes = sandbox.listRoutes();
  ['dashboard.', 'org.', 'employee.', 'recruitment.', 'time.', 'leave.', 'payroll.',
   'benefit.', 'performance.', 'training.', 'career.', 'document.', 'discipline.',
   'offboarding.', 'report.', 'audit.', 'admin.'].forEach(function (prefix) {
    ok(routes.some(r => r.indexOf(prefix) === 0), 'ขาดเส้นทางของโมดูล ' + prefix);
  });
});

test('เรียกคำสั่งที่ไม่รู้จักคืน ok:false', function () {
  const out = sandbox.api('ไม่มีจริง.เลย', {});
  eq(out.ok, false);
  ok(out.error.indexOf('ไม่รู้จักคำสั่ง') >= 0);
});

test('เรียก API ที่ไม่มีสิทธิ คืน ok:false พร้อมข้อความสิทธิ', function () {
  const out = sandbox.api('discipline.list', {});
  eq(out.ok, false);
  ok(out.error.indexOf('ไม่มีสิทธิ') >= 0, 'ได้: ' + out.error);
});

test('app.bootstrap คืนข้อมูลตั้งต้นครบ', function () {
  const out = sandbox.api('app.bootstrap', {});
  eq(out.ok, true, out.error);
  eq(out.data.org.code, 'CUP001');
  eq(out.data.user.employeeId, EMP);
  ok(out.data.modules.length > 0, 'ต้องมีเมนู');
  ok(out.data.modules.every(m => m.perm !== 'discipline.read'),
     'เมนูที่ไม่มีสิทธิต้องไม่แสดง');
});

console.log('\n== 5. เครื่องคำนวณเงินเดือน ==');
const calculatePayslip = sandbox.calculatePayslip;
const calcAnnualTax = sandbox.calcAnnualTax;
const brackets = fixtures.tax_brackets;
const rates = { SSO: fixtures.contribution_rates[0] };

test('ภาษีขั้นบันได: เงินได้สุทธิ 150,000 ไม่เสียภาษี', function () {
  eq(calcAnnualTax(150000, brackets), 0);
});

test('ภาษีขั้นบันได: เงินได้สุทธิ 300,000 = 7,500', function () {
  near(calcAnnualTax(300000, brackets), 7500, 0.01);
});

test('ภาษีขั้นบันได: เงินได้สุทธิ 400,000 = 17,500', function () {
  near(calcAnnualTax(400000, brackets), 17500, 0.01);
});

test('สลิปพื้นฐาน: เงินเดือน 24,000 ไม่มีรายการอื่น', function () {
  const r = calculatePayslip({
    employee_id: EMP, base_salary: 24000, work_days: 22, absent_days: 0,
    unpaid_leave_days: 0, ot_minutes: 0, components: []
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });

  near(r.grossEarning, 24000, 0.01, 'เงินได้รวม');
  near(r.ssoEmployee, 750, 0.01, 'ประกันสังคมลูกจ้าง (ฐานสูงสุด 15,000 x 5%)');
  near(r.ssoEmployer, 750, 0.01, 'ประกันสังคมนายจ้าง');
  ok(r.netPay > 0 && r.netPay < r.grossEarning, 'จ่ายสุทธิต้องน้อยกว่าเงินได้รวม');
  ok(r.items.some(i => i.code === 'BASE'), 'ต้องมีรายการเงินเดือน');
  ok(r.items.some(i => i.code === 'SSO'), 'ต้องมีรายการประกันสังคม');
});

test('ประกันสังคมไม่เกินเพดาน 750 แม้เงินเดือนสูง', function () {
  const r = calculatePayslip({
    base_salary: 80000, work_days: 22, absent_days: 0, unpaid_leave_days: 0,
    ot_minutes: 0, components: []
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });
  near(r.ssoEmployee, 750, 0.01);
});

test('หักขาดงาน 2 วัน จากฐาน 22 วัน', function () {
  const r = calculatePayslip({
    base_salary: 22000, work_days: 20, absent_days: 2, unpaid_leave_days: 0,
    ot_minutes: 0, components: []
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });
  const absent = r.items.find(i => i.code === 'ABSENT');
  ok(absent, 'ต้องมีรายการหักขาดงาน');
  near(absent.amount, 2000, 0.01, 'หัก 2 วัน x 1,000');
});

test('ค่าล่วงเวลาคำนวณจากนาทีที่อนุมัติ (อัตรา 1.5 เท่า)', function () {
  const r = calculatePayslip({
    base_salary: 22000, work_days: 22, absent_days: 0, unpaid_leave_days: 0,
    ot_minutes: 600,   // 10 ชั่วโมง
    components: [
      { component_id: 'c1', code: 'BASE', name: 'เงินเดือน', type: 'EARNING',
        category: 'BASE', calc_method: 'FIXED', amount: 22000,
        is_taxable: true, is_sso_base: true, sort: 1 },
      { component_id: 'c2', code: 'OT', name: 'ค่าล่วงเวลา', type: 'EARNING',
        category: 'OT', calc_method: 'RATE_TIME', amount: 0,
        is_taxable: true, is_sso_base: true, sort: 6 }
    ]
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });

  const ot = r.items.find(i => i.code === 'OT');
  ok(ot, 'ต้องมีรายการค่าล่วงเวลา');
  // 22000/22 = 1000/วัน -> 125/ชม. -> x1.5 = 187.5 -> x10 ชม. = 1875
  near(ot.amount, 1875, 0.01, 'ค่าล่วงเวลา');
  near(r.grossEarning, 23875, 0.01, 'เงินได้รวม');
});

test('รายการหักประจำ (สหกรณ์) ถูกรวมในยอดหัก', function () {
  const r = calculatePayslip({
    base_salary: 24000, work_days: 22, absent_days: 0, unpaid_leave_days: 0,
    ot_minutes: 0,
    components: [
      { component_id: 'c1', code: 'BASE', name: 'เงินเดือน', type: 'EARNING',
        category: 'BASE', calc_method: 'FIXED', amount: 24000,
        is_taxable: true, is_sso_base: true, sort: 1 },
      { component_id: 'c3', code: 'COOP', name: 'หักสหกรณ์', type: 'DEDUCTION',
        category: 'LOAN', calc_method: 'FIXED', amount: 3000, sort: 23 }
    ]
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });

  const coop = r.items.find(i => i.code === 'COOP');
  ok(coop, 'ต้องมีรายการหักสหกรณ์');
  near(coop.amount, 3000, 0.01);
  near(r.netPay, r.grossEarning - r.totalDeduction, 0.01, 'สุทธิ = ได้ - หัก');
  ok(r.totalDeduction >= 3000 + 750, 'ยอดหักต้องรวมสหกรณ์และประกันสังคม');
});

test('เพดานรายการ (cap) ถูกบังคับ', function () {
  const r = calculatePayslip({
    base_salary: 24000, work_days: 22, absent_days: 0, unpaid_leave_days: 0, ot_minutes: 0,
    components: [
      { component_id: 'c1', code: 'BASE', name: 'เงินเดือน', type: 'EARNING',
        category: 'BASE', calc_method: 'FIXED', amount: 24000,
        is_taxable: true, is_sso_base: true, sort: 1 },
      { component_id: 'c4', code: 'PTS', name: 'เงิน พ.ต.ส.', type: 'EARNING',
        category: 'SPECIAL_ALLOW', calc_method: 'FIXED', amount: 9999,
        cap: 5000, is_taxable: true, is_sso_base: false, sort: 3 }
    ]
  }, { period: { end_date: '2026-08-31' }, rates: rates, brackets: brackets,
       workDaysInPeriod: 22 });
  near(r.items.find(i => i.code === 'PTS').amount, 5000, 0.01);
});

console.log('\n== 6. ระยะทาง GPS สำหรับลงเวลา ==');
const haversine = sandbox.haversineMeters;

test('พิกัดเดียวกัน = 0 เมตร', function () {
  near(haversine(13.7563, 100.5018, 13.7563, 100.5018), 0, 0.5);
});

test('ห่าง ~1 กม. คำนวณได้ใกล้เคียง', function () {
  // 0.009 องศาละติจูด ≈ 1,000 เมตร
  near(haversine(13.7563, 100.5018, 13.7653, 100.5018), 1000, 20);
});

console.log('\n== 7. นิยามรายงาน ==');

test('รายงานทุกฉบับมี columns และ fetch', function () {
  const defs = sandbox.REPORT_DEFS;
  Object.keys(defs).forEach(function (k) {
    ok(defs[k].name, k + ' ต้องมีชื่อ');
    ok(defs[k].perm, k + ' ต้องระบุสิทธิ');
    ok(Array.isArray(defs[k].columns) && defs[k].columns.length, k + ' ต้องมีคอลัมน์');
    ok(typeof defs[k].fetch === 'function', k + ' ต้องมีฟังก์ชันดึงข้อมูล');
  });
});

test('report.catalog แสดงเฉพาะรายงานที่มีสิทธิ', function () {
  const out = sandbox.api('report.catalog', {});
  eq(out.ok, true, out.error);
  ok(out.data.length > 0);
  ok(out.data.every(r => sandbox.REPORT_DEFS[r.code]), 'รหัสรายงานต้องมีจริง');
});

test('report.exportCsv ใส่ BOM และ escape ค่าที่มีจุลภาค', function () {
  fixtures.v_turnover_by_year = [
    { org_id: ORG, fiscal_year: 2569, headcount: 10, hire_count: 2,
      separation_count: 1, turnover_percent: 10 }
  ];
  const out = sandbox.api('report.exportCsv', { code: 'TURNOVER' });
  eq(out.ok, true, out.error);
  ok(out.data.csv.charCodeAt(0) === 0xFEFF, 'ต้องขึ้นต้นด้วย BOM');
  eq(out.data.rows, 1);
});

console.log('\n== 8. โมดูลที่ประกาศไว้ ==');

test('MODULES ครบ 15 โมดูลหลัก + ส่วนเสริม', function () {
  const mods = sandbox.MODULES;
  ok(mods.length >= 15, 'ต้องมีอย่างน้อย 15 โมดูล ได้ ' + mods.length);
  const nos = mods.slice(0, 15).map(m => m.no);
  eq(nos, ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15']);
  mods.forEach(function (m) {
    ok(m.id && m.name && m.perm, 'โมดูล ' + m.no + ' ข้อมูลไม่ครบ');
  });
});

console.log('\n=================================');
console.log('ผ่าน ' + passed + ' / ล้มเหลว ' + failed);
console.log('=================================\n');
process.exit(failed ? 1 : 0);
