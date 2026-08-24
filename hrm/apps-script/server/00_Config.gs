/**
 * HRM :: 00_Config.gs
 * ค่าตั้งต้นของระบบ อ่านจาก Script Properties (ไม่ hardcode ความลับในโค้ด)
 *
 * ตั้งค่าครั้งแรกที่  Project Settings > Script Properties  หรือเรียก setupConfig() หนึ่งครั้ง:
 *   SUPABASE_URL          https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key  (เก็บเฉพาะฝั่ง server เท่านั้น)
 *   SUPABASE_ANON_KEY     anon key          (ใช้กับหน้าเว็บสมัครงานสาธารณะ)
 *   DEFAULT_ORG_CODE      รหัสองค์กรตั้งต้น
 *   DRIVE_FOLDER_ID       โฟลเดอร์เก็บเอกสารที่ระบบสร้าง
 *   LINE_NOTIFY_TOKEN     (ไม่บังคับ) token แจ้งเตือน
 */

const CFG = (function () {
  const props = PropertiesService.getScriptProperties();

  function get(key, fallback) {
    const v = props.getProperty(key);
    return (v === null || v === '') ? fallback : v;
  }

  return {
    get SUPABASE_URL()      { return String(get('SUPABASE_URL', '')).replace(/\/+$/, ''); },
    get SERVICE_KEY()       { return get('SUPABASE_SERVICE_KEY', ''); },
    get ANON_KEY()          { return get('SUPABASE_ANON_KEY', ''); },
    get REST()              { return this.SUPABASE_URL + '/rest/v1'; },
    get RPC()               { return this.SUPABASE_URL + '/rest/v1/rpc'; },
    get STORAGE()           { return this.SUPABASE_URL + '/storage/v1'; },
    get DEFAULT_ORG_CODE()  { return get('DEFAULT_ORG_CODE', 'CUP001'); },
    get DRIVE_FOLDER_ID()   { return get('DRIVE_FOLDER_ID', ''); },
    get LINE_TOKEN()        { return get('LINE_NOTIFY_TOKEN', ''); },
    get APP_NAME()          { return get('APP_NAME', 'HRM — ระบบบริหารงานบุคคล'); },
    get APP_URL()           { return ScriptApp.getService().getUrl(); },
    get TZ()                { return Session.getScriptTimeZone() || 'Asia/Bangkok'; },
    get SESSION_HOURS()     { return Number(get('SESSION_HOURS', '12')); },
    get DEBUG()             { return get('DEBUG', 'false') === 'true'; },

    /** ตรวจว่าตั้งค่าครบหรือยัง - เรียกก่อนเปิดหน้าเว็บ */
    validate() {
      const missing = [];
      if (!this.SUPABASE_URL) missing.push('SUPABASE_URL');
      if (!this.SERVICE_KEY)  missing.push('SUPABASE_SERVICE_KEY');
      return missing;
    }
  };
})();

/** ตั้งค่าครั้งแรก - แก้ค่าแล้วกด Run หนึ่งครั้ง (อย่า commit ค่าจริงลง git) */
function setupConfig() {
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
    SUPABASE_SERVICE_KEY: 'YOUR-SERVICE-ROLE-KEY',
    SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
    DEFAULT_ORG_CODE: 'CUP001',
    DRIVE_FOLDER_ID: '',
    SESSION_HOURS: '12',
    DEBUG: 'false'
  }, false);
  Logger.log('บันทึกค่าตั้งต้นแล้ว - อย่าลืมแก้เป็นค่าจริงของโปรเจกต์');
}

/** รายการโมดูลของระบบ (ใช้สร้างเมนูฝั่ง client และตรวจสิทธิ) */
const MODULES = [
  { id: 'dashboard',   no: '01', name: 'แดชบอร์ด',        icon: 'grid',      perm: 'dashboard.read' },
  { id: 'org',         no: '02', name: 'โครงสร้างองค์กร',  icon: 'sitemap',   perm: 'org.read' },
  { id: 'employee',    no: '03', name: 'ทะเบียนบุคลากร',   icon: 'users',     perm: 'employee.read' },
  { id: 'recruitment', no: '04', name: 'รับสมัคร/คัดเลือก', icon: 'userplus',  perm: 'recruitment.read' },
  { id: 'time',        no: '05', name: 'เวลาปฏิบัติงาน',   icon: 'clock',     perm: 'time.read' },
  { id: 'leave',       no: '06', name: 'การลา',            icon: 'calendar',  perm: 'leave.read' },
  { id: 'payroll',     no: '07', name: 'เงินเดือน',        icon: 'cash',      perm: 'payroll.read' },
  { id: 'benefit',     no: '08', name: 'สวัสดิการ',        icon: 'heart',     perm: 'benefit.read' },
  { id: 'performance', no: '09', name: 'ประเมินผล',        icon: 'target',    perm: 'performance.read' },
  { id: 'training',    no: '10', name: 'ฝึกอบรม/พัฒนา',    icon: 'book',      perm: 'training.read' },
  { id: 'career',      no: '11', name: 'ความก้าวหน้า',     icon: 'trending',  perm: 'career.read' },
  { id: 'document',    no: '12', name: 'เอกสาร',           icon: 'file',      perm: 'document.read' },
  { id: 'discipline',  no: '13', name: 'วินัย',            icon: 'shield',    perm: 'discipline.read' },
  { id: 'offboarding', no: '14', name: 'พ้นสภาพ',          icon: 'logout',    perm: 'offboarding.read' },
  { id: 'report',      no: '15', name: 'รายงาน',           icon: 'chart',     perm: 'report.read' },
  { id: 'audit',       no: '16', name: 'Audit Log',        icon: 'search',    perm: 'audit.read' },
  { id: 'admin',       no: '17', name: 'ผู้ใช้และสิทธิ',   icon: 'settings',  perm: 'user.manage' }
];
