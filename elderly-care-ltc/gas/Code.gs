/**
 * ระบบดูแลผู้สูงอายุและผู้มีภาวะพึ่งพิง (LTC Dashboard)
 * Entry point ของ Web App + ระบบล็อกอิน + ตัวกระจายคำสั่ง API
 */

const APP_NAME = 'ระบบดูแลผู้สูงอายุและผู้มีภาวะพึ่งพิง';
const SESSION_TTL = 6 * 60 * 60; // วินาที (สูงสุดของ CacheService)
const MAX_LOGIN_FAIL = 5;

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * ฝังไฟล์ JavaScript (เช่น App.html) แบบ base64
 * HtmlService แปลงเนื้อหาในแท็ก <script> เหมือน HTML (ถอด entity / ตีความ <tag> ใน template string)
 * ทำให้โค้ดพัง จึงส่งเป็น base64 ซึ่งมีแต่ A-Z a-z 0-9 + / = แล้วให้เบราว์เซอร์ถอดรหัสและรันเอง
 * (ตัว loader ด้านล่างจงใจไม่มีอักขระ < และ & เลย)
 */
function includeScript(name) {
  const code = HtmlService.createTemplateFromFile(name).getRawContent()
    .replace(/^\s*<script[^>]*>/i, '')
    .replace(/<\/script>\s*$/i, '');
  const b64 = Utilities.base64Encode(code, Utilities.Charset.UTF_8);
  return '<script>(function () {' +
    'var bin = atob("' + b64 + '");' +
    'var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });' +
    'var s = document.createElement("script");' +
    's.text = new TextDecoder("utf-8").decode(bytes) + "\\n//# sourceURL=' + name + '.js";' +
    'document.body.appendChild(s);' +
    '})();</script>';
}

// ======================= Auth =======================

function hashPassword_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < 500; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return h;
}

function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }

function publicUser_(u) {
  return {
    id: u.id, username: u.username, full_name: u.full_name, role: u.role,
    caregiver_id: u.caregiver_id, care_manager_id: u.care_manager_id
  };
}

function login(username, password) {
  try {
    username = String(username || '').trim().toLowerCase();
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + username;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= MAX_LOGIN_FAIL) return { ok: false, error: 'ล็อกอินผิดเกินกำหนด กรุณารอ 15 นาที' };

    const u = sbSelect('app_users', 'select=*&username=eq.' + q_(username))[0];
    if (!u || !u.active || hashPassword_(password, u.salt) !== u.password_hash) {
      cache.put(failKey, String(fails + 1), 900);
      return { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    }
    cache.remove(failKey);
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const user = publicUser_(u);
    cache.put('sess_' + token, JSON.stringify(user), SESSION_TTL);
    sbUpdate('app_users', 'id=eq.' + u.id, { last_login: new Date().toISOString() });
    audit_(user, 'login', u.id);
    return { ok: true, data: { token: token, user: user } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sessionUser_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) return null;
  cache.put('sess_' + token, raw, SESSION_TTL); // sliding expiration
  return JSON.parse(raw);
}

function logout(token) {
  CacheService.getScriptCache().remove('sess_' + token);
  return { ok: true };
}

/**
 * รันครั้งแรกจาก Apps Script editor เพื่อสร้างผู้ดูแลระบบ
 * ตั้ง Script Property ADMIN_INITIAL_PASSWORD ก่อนรัน แล้วลบทิ้งหลังรัน
 */
function createInitialAdmin() {
  const pw = PropertiesService.getScriptProperties().getProperty('ADMIN_INITIAL_PASSWORD');
  if (!pw || pw.length < 8) throw new Error('ตั้ง ADMIN_INITIAL_PASSWORD (อย่างน้อย 8 ตัวอักษร) ใน Script Properties ก่อน');
  const salt = newSalt_();
  sbInsert('app_users', {
    username: 'admin', full_name: 'ผู้ดูแลระบบ', role: 'admin',
    salt: salt, password_hash: hashPassword_(pw, salt)
  }, 'username');
  Logger.log('สร้างผู้ใช้ admin เรียบร้อย — ลบ ADMIN_INITIAL_PASSWORD ออกจาก Script Properties ได้แล้ว');
}

// ======================= API dispatcher =======================

/**
 * เรียกจากฝั่ง client: google.script.run.api(token, action, payload)
 * คืนค่า {ok, data} หรือ {ok:false, error, code}
 */
function api(token, action, payload) {
  try {
    const user = sessionUser_(token);
    if (!user) return { ok: false, code: 'AUTH', error: 'กรุณาเข้าสู่ระบบใหม่' };
    const def = ACTIONS[action];
    if (!def) return { ok: false, error: 'ไม่พบคำสั่ง ' + action };
    if (def.roles.indexOf(user.role) < 0) return { ok: false, error: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' };
    const data = def.fn(payload || {}, user);
    if (def.audit) audit_(user, action, payload && (payload.id || payload.period || ''));
    return { ok: true, data: data === undefined ? null : data };
  } catch (e) {
    console.error(action, e && e.stack);
    return { ok: false, error: e.message || String(e) };
  }
}

function audit_(user, action, entityId) {
  try {
    sbInsert('audit_logs', { username: user.username, action: action, entity_id: String(entityId || '') });
  } catch (e) { console.warn('audit failed', e); }
}
