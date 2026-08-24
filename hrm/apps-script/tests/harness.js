/**
 * HRM :: harness.js
 * รันโค้ดฝั่ง server (.gs) ใน Node เพื่อทดสอบตรรกะโดยไม่ต้อง deploy ขึ้น Apps Script
 * โดยจำลอง (stub) บริการของ Google และ Supabase REST
 *
 *   node hrm/apps-script/tests/harness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER_DIR = path.join(__dirname, '..', 'server');

// ---------------------------------------------------------------- ข้อมูลจำลอง
const ORG = '22222222-0000-0000-0000-000000000001';
const FAC = '33333333-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000001';
const EMP = 'cccccccc-0000-0000-0000-000000000009';

const fixtures = {
  app_users: [{
    id: USER, org_id: ORG, email: 'hr@example.com', google_email: 'hr@example.com',
    display_name: 'เจ้าหน้าที่บุคคล', employee_id: EMP, status: 'ACTIVE',
    is_superadmin: false, preferences: {}
  }],
  v_user_permissions: [
    'dashboard.read','employee.read','employee.read_all','employee.write',
    'leave.read','leave.write','leave.approve','leave.manage',
    'payroll.read','payroll.write','payroll.calculate','payroll.approve',
    'time.read','time.write','report.read','report.export','audit.read'
  ].map(function (code) {
    return { user_id: USER, org_id: ORG, facility_id: FAC, department_id: null,
             permission_code: code, role_code: 'HR_OFFICER' };
  }),
  v_employee_current: [{
    employee_id: EMP, org_id: ORG, emp_code: 'EMP0001', full_name_th: 'นางสาวสมหญิง ใจดี',
    photo_url: null, position_name: 'พยาบาลวิชาชีพ', department_name: 'กลุ่มการพยาบาล',
    facility_id: FAC, facility_name: 'โรงพยาบาลชุมชนตัวอย่าง', department_id: null,
    employment_status: 'ACTIVE', supervisor_id: null, base_salary: 24000,
    hire_date: '2020-10-01', age_years: 31, gender: 'F', employment_type: 'CIVIL_SERVANT'
  }],
  organizations: [{ id: ORG, code: 'CUP001', name_th: 'เครือข่ายบริการสุขภาพอำเภอตัวอย่าง',
                    settings: {}, logo_url: null }],
  facilities: [{ id: FAC, code: '10999', name_th: 'โรงพยาบาลชุมชนตัวอย่าง',
                 facility_type: 'HOSPITAL', org_id: ORG, is_active: true,
                 geo: { lat: 13.7563, lng: 100.5018, radius_m: 300 } }],
  contribution_rates: [{
    id: 'r1', org_id: ORG, fund_type: 'SSO', effective_from: '2024-01-01', effective_to: null,
    employee_percent: 5, employer_percent: 5, min_base: 1650, max_base: 15000,
    employee_cap: 750, employer_cap: 750
  }],
  tax_brackets: [
    { org_id: null, tax_year: 2026, income_from: 0,       income_to: 150000,  rate_percent: 0 },
    { org_id: null, tax_year: 2026, income_from: 150000,  income_to: 300000,  rate_percent: 5 },
    { org_id: null, tax_year: 2026, income_from: 300000,  income_to: 500000,  rate_percent: 10 },
    { org_id: null, tax_year: 2026, income_from: 500000,  income_to: 750000,  rate_percent: 15 },
    { org_id: null, tax_year: 2026, income_from: 750000,  income_to: 1000000, rate_percent: 20 },
    { org_id: null, tax_year: 2026, income_from: 1000000, income_to: null,    rate_percent: 25 }
  ],
  notifications: [], login_logs: [], data_access_logs: [],
  leave_requests: [], employees: [], appraisals: [], document_requests: [],
  v_headcount_by_unit: [], v_compliance_alerts: [], v_workforce_demographics: [],
  v_leave_balance: [], departments: [], positions: [], job_grades: [],
  work_shifts: [], leave_types: []
};

// ------------------------------------------------------- Supabase REST จำลอง
const rpcHandlers = {
  fn_set_context: () => null,
  fn_dashboard_summary: () => ({ headcount: { total: 1, active: 1 }, pending: {} }),
  fn_next_document_no: (a) => (a.p_prefix || '') + '0001'
};

function parseUrl(url) {
  const [base, qs] = url.split('?');
  const table = base.split('/').pop();
  const params = {};
  (qs || '').split('&').filter(Boolean).forEach(function (kv) {
    const i = kv.indexOf('=');
    const k = decodeURIComponent(kv.slice(0, i));
    const v = decodeURIComponent(kv.slice(i + 1));
    (params[k] = params[k] || []).push(v);
  });
  return { table, params };
}

function matches(row, params) {
  return Object.keys(params).every(function (col) {
    if (['select', 'order', 'limit', 'offset', 'or'].indexOf(col) >= 0) return true;
    return params[col].every(function (expr) {
      const dot = expr.indexOf('.');
      const op = expr.slice(0, dot);
      const val = expr.slice(dot + 1);
      const cell = row[col];
      switch (op) {
        case 'eq':  return String(cell) === val;
        case 'neq': return String(cell) !== val;
        case 'is':  return val === 'null' ? (cell === null || cell === undefined) : true;
        case 'in':  return val.replace(/^\(|\)$/g, '').split(',').indexOf(String(cell)) >= 0;
        case 'gte': return cell >= val;
        case 'lte': return cell <= val;
        case 'gt':  return cell > val;
        case 'lt':  return cell < val;
        case 'ilike': return String(cell || '').toLowerCase()
                        .indexOf(val.replace(/\*/g, '').toLowerCase()) >= 0;
        default: return true;
      }
    });
  });
}

const calls = [];

function fakeFetch(url, options) {
  const method = (options.method || 'get').toLowerCase();
  calls.push({ method, url });

  if (url.indexOf('/rpc/') >= 0) {
    const fn = url.split('/rpc/')[1];
    const args = options.payload ? JSON.parse(options.payload) : {};
    const handler = rpcHandlers[fn];
    const out = handler ? handler(args) : null;
    return response(200, JSON.stringify(out));
  }

  const { table, params } = parseUrl(url);
  const rows = fixtures[table] || [];

  if (method === 'get') {
    const found = rows.filter(function (r) { return matches(r, params); });
    return response(200, JSON.stringify(found), {
      'content-range': '0-' + Math.max(0, found.length - 1) + '/' + found.length
    });
  }
  if (method === 'post') {
    const payload = JSON.parse(options.payload);
    const items = Array.isArray(payload) ? payload : [payload];
    items.forEach(function (it, i) {
      it.id = it.id || (table + '-' + (rows.length + i + 1));
      it.created_at = new Date().toISOString();
      rows.push(it);
    });
    fixtures[table] = rows;
    return response(201, JSON.stringify(items));
  }
  if (method === 'patch') {
    const patch = JSON.parse(options.payload);
    const hit = rows.filter(function (r) { return matches(r, params); });
    hit.forEach(function (r) { Object.assign(r, patch); });
    return response(200, JSON.stringify(hit));
  }
  if (method === 'delete') {
    const keep = [], removed = [];
    rows.forEach(function (r) { (matches(r, params) ? removed : keep).push(r); });
    fixtures[table] = keep;
    return response(200, JSON.stringify(removed));
  }
  return response(200, '[]');
}

function response(code, text, headers) {
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => headers || {}
  };
}

// ------------------------------------------------------ Google Services จำลอง
const scriptProps = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_KEY: 'test-service-key',
  SUPABASE_ANON_KEY: 'test-anon-key',
  DEFAULT_ORG_CODE: 'CUP001',
  DRIVE_FOLDER_ID: '',
  DEBUG: 'false'
};
const userCache = {};

const sandbox = {
  console: console,
  Logger: { log: function () {} },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
      setProperties: (o) => Object.assign(scriptProps, o)
    })
  },
  CacheService: {
    getUserCache: () => ({
      get: (k) => userCache[k] || null,
      put: (k, v) => { userCache[k] = v; },
      remove: (k) => { delete userCache[k]; }
    })
  },
  UrlFetchApp: { fetch: fakeFetch },
  Session: {
    getActiveUser: () => ({ getEmail: () => 'hr@example.com' }),
    getEffectiveUser: () => ({ getEmail: () => 'hr@example.com' }),
    getScriptTimeZone: () => 'Asia/Bangkok'
  },
  ScriptApp: {
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
    getProjectTriggers: () => []
  },
  Utilities: {
    getUuid: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
    formatDate: function (d, tz, fmt) {
      const iso = new Date(d).toISOString();
      if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
      if (fmt === 'HH:mm') return iso.slice(11, 16);
      return iso;
    },
    base64Decode: (s) => Buffer.from(s, 'base64'),
    newBlob: (bytes, type, name) => ({ getBytes: () => bytes, getContentType: () => type,
                                       getAs: () => ({ setName: () => ({}) }) })
  },
  MailApp: { sendEmail: function () {} },
  DriveApp: { getFolderById: () => { throw new Error('ไม่ได้ตั้ง Drive ในการทดสอบ'); } },
  SpreadsheetApp: {},
  DocumentApp: {},
  HtmlService: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// -------------------------------------------------------------- โหลดไฟล์ทั้งหมด
fs.readdirSync(SERVER_DIR).filter(f => f.endsWith('.gs')).sort().forEach(function (f) {
  const code = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f });
  } catch (e) {
    console.error('โหลด ' + f + ' ล้มเหลว: ' + e.message);
    process.exit(1);
  }
});

/*
 * ใน Apps Script ทุกไฟล์ .gs ใช้ scope เดียวกัน จึงเห็น const ข้ามไฟล์ได้
 * แต่ใน vm ของ Node ตัวแปร const/let อยู่ใน global lexical scope ซึ่งไม่ปรากฏ
 * เป็นคุณสมบัติของ sandbox — จึงคัดลอกออกมาให้เทสต์เข้าถึงได้
 */
vm.runInContext([
  'CFG', 'DB', 'Auth', 'Util', 'MODULES', 'ROUTES',
  'REPORT_DEFS', 'EMPLOYEE_WRITABLE', 'CLEARANCE_DEFAULTS'
].map(function (n) {
  return 'try { globalThis.' + n + ' = ' + n + '; } catch (e) {}';
}).join('\n'), sandbox, { filename: 'export-globals.js' });

module.exports = { sandbox, fixtures, calls, ORG, FAC, USER, EMP };
