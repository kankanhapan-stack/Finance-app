/**
 * HRM :: 04_Main.gs
 * จุดเข้าเว็บแอป + ตัวกระจายคำสั่ง (API router)
 *
 * ฝั่ง client เรียกทุกอย่างผ่านช่องทางเดียว:
 *   google.script.run.withSuccessHandler(cb).api('leave.list', { ... })
 * ทำให้เพิ่มโมดูลใหม่ได้โดยไม่ต้องประกาศฟังก์ชัน global เพิ่ม
 */

function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'app';

  // หน้าสมัครงานสาธารณะ (ไม่ต้องล็อกอิน)
  if (page === 'jobs') {
    return HtmlService.createTemplateFromFile('client/PublicJobs')
      .evaluate()
      .setTitle('ประกาศรับสมัครงาน')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // หน้าตรวจสอบเอกสาร (QR verify)
  if (page === 'verify') {
    const t = HtmlService.createTemplateFromFile('client/Verify');
    t.code = (e.parameter && e.parameter.code) || '';
    return t.evaluate().setTitle('ตรวจสอบเอกสาร');
  }

  const missing = CFG.validate();
  if (missing.length) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;max-width:640px;margin:auto">' +
      '<h2>ยังตั้งค่าระบบไม่ครบ</h2>' +
      '<p>กรุณากำหนด Script Properties ต่อไปนี้ก่อนใช้งาน:</p>' +
      '<ul><li>' + missing.join('</li><li>') + '</li></ul>' +
      '<p>ดูวิธีตั้งค่าได้ที่ <code>hrm/docs/DEPLOYMENT.md</code></p></div>');
  }

  return HtmlService.createTemplateFromFile('client/Index')
    .evaluate()
    .setTitle(CFG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setFaviconUrl('https://ssl.gstatic.com/docs/script/images/favicon.ico');
}

/** ใช้ใน template: <?!= include('client/Styles') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * ตารางเส้นทาง API : 'module.action' -> ฟังก์ชัน
 * แต่ละฟังก์ชันรับ (payload, ctx) และคืนข้อมูลดิบ (Util.handle จะห่อให้เอง)
 */
const ROUTES = {};

/** ลงทะเบียนเส้นทาง — เรียกจากไฟล์ Api_*.gs แต่ละไฟล์ */
function registerRoutes(map) {
  Object.keys(map).forEach(function (k) {
    if (ROUTES[k]) throw new Error('เส้นทาง API ซ้ำ: ' + k);
    ROUTES[k] = map[k];
  });
}

/** จุดเข้าหลักจากฝั่ง client */
function api(action, payload) {
  return Util.handle(action, function () {
    // รวมเส้นทางจากทุกโมดูล (ครั้งแรกของแต่ละ execution)
    buildRoutes();

    const route = ROUTES[action];
    if (!route) throw new Error('ไม่รู้จักคำสั่ง: ' + action);

    const ctx = Auth.require(route.perm || null);

    if (route.check) route.check(payload || {}, ctx);
    return route.fn(payload || {}, ctx);
  });
}

let _routesBuilt = false;
function buildRoutes() {
  if (_routesBuilt) return;
  // ไฟล์ Api_*.gs แต่ละไฟล์ประกาศฟังก์ชัน routes<Module>() คืน object เส้นทาง
  [
    routesCore, routesEmployee, routesRecruitment, routesTime, routesLeave,
    routesPayroll, routesBenefit, routesPerformance, routesTraining, routesCareer,
    routesDocument, routesDiscipline, routesOffboarding, routesReport, routesAdmin
  ].forEach(function (f) { registerRoutes(f()); });
  _routesBuilt = true;
}

/** ให้ฝั่ง client เรียกดูรายการคำสั่งทั้งหมด (ใช้ตอน debug) */
function listRoutes() {
  buildRoutes();
  return Object.keys(ROUTES).sort();
}
