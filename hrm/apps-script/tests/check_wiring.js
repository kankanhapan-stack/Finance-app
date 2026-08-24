/**
 * HRM :: check_wiring.js
 * ตรวจความสอดคล้องระหว่างฝั่ง client กับ server
 *   1. ทุก action ที่ client เรียก ต้องมีเส้นทางจริงฝั่ง server
 *   2. ทุกไฟล์ที่ include() ใน template ต้องมีอยู่จริง
 *   3. ทุกโมดูลในเมนู (MODULES) ต้องมีหน้าจอ (VIEWS) รองรับ
 *   4. ทุกสิทธิที่โค้ดอ้างถึง ต้องมีอยู่ในตาราง permissions ของ seed
 *
 *   node hrm/apps-script/tests/check_wiring.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./harness');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const SERVER = path.join(ROOT, 'server');
const SEED = path.join(ROOT, '..', 'supabase', 'sql', '14_seed.sql');

let errors = 0;
function fail(msg) { console.log('  ✗ ' + msg); errors++; }
function ok(msg) { console.log('  ✓ ' + msg); }

const clientFiles = fs.readdirSync(CLIENT).filter(f => f.endsWith('.html'));
const clientSrc = clientFiles.map(f => fs.readFileSync(path.join(CLIENT, f), 'utf8')).join('\n');

/* ---- 1. action ที่ client เรียก ------------------------------------------ */
console.log('\n== 1. เส้นทาง API ที่หน้าเว็บเรียก ==');

const routes = sandbox.listRoutes();
const publicRoutes = Object.keys(
  require('vm').runInContext('PUBLIC_ROUTES', sandbox));

const called = new Set();
const rePrivate = /\bapi(?:Safe)?\(\s*'([^']+)'/g;
let m;
while ((m = rePrivate.exec(clientSrc))) called.add(m[1]);

const calledPublic = new Set();
const rePublic = /\bpublicApi\(\s*'([^']+)'/g;
while ((m = rePublic.exec(clientSrc))) calledPublic.add(m[1]);

let missing = 0;
called.forEach(function (a) {
  if (routes.indexOf(a) < 0) { fail('client เรียก "' + a + '" แต่ไม่มีเส้นทางฝั่ง server'); missing++; }
});
calledPublic.forEach(function (a) {
  if (publicRoutes.indexOf(a) < 0) { fail('หน้าสาธารณะเรียก "' + a + '" แต่ไม่มีใน PUBLIC_ROUTES'); missing++; }
});
if (!missing) ok('เส้นทางที่ client เรียกครบทั้ง ' + called.size + ' รายการ (+ สาธารณะ ' +
                 calledPublic.size + ' รายการ)');

/* ---- เส้นทางฝั่ง server ที่ยังไม่มีใครเรียก (เตือนอย่างเดียว) ---------------- */
const unused = routes.filter(function (r) {
  return !called.has(r) && r.indexOf('app.') !== 0;
});
if (unused.length) {
  console.log('  · เส้นทางที่ยังไม่ถูกเรียกจากหน้าเว็บ (' + unused.length + '): ' +
              unused.slice(0, 8).join(', ') + (unused.length > 8 ? ' …' : ''));
}

/* ---- 2. include() ------------------------------------------------------- */
console.log('\n== 2. ไฟล์ที่ template อ้างถึง ==');
const included = new Set();
const reInc = /include\(\s*'([^']+)'/g;
while ((m = reInc.exec(clientSrc + fs.readFileSync(path.join(SERVER, '04_Main.gs'), 'utf8')))) {
  included.add(m[1]);
}
let incMissing = 0;
included.forEach(function (p) {
  const f = path.join(ROOT, p + '.html');
  if (!fs.existsSync(f)) { fail('include("' + p + '") แต่ไม่พบไฟล์ ' + p + '.html'); incMissing++; }
});
if (!incMissing) ok('ไฟล์ที่ include ครบทั้ง ' + included.size + ' ไฟล์');

/* ---- 3. โมดูลในเมนูต้องมีหน้าจอ ------------------------------------------ */
console.log('\n== 3. โมดูลในเมนูกับหน้าจอ ==');
const modules = sandbox.MODULES;
const viewIds = new Set();
const reView = /VIEWS\.(\w+)\s*=\s*\{/g;
while ((m = reView.exec(clientSrc))) viewIds.add(m[1]);

let viewMissing = 0;
modules.forEach(function (mod) {
  if (!viewIds.has(mod.id)) { fail('โมดูล ' + mod.no + ' ' + mod.name + ' (' + mod.id +
                                   ') ไม่มี VIEWS.' + mod.id); viewMissing++; }
});
if (!viewMissing) ok('ครบทุกโมดูล ' + modules.length + ' รายการมีหน้าจอรองรับ');

viewIds.forEach(function (v) {
  if (!modules.some(function (mod) { return mod.id === v; })) {
    console.log('  · VIEWS.' + v + ' ไม่มีอยู่ในเมนู MODULES');
  }
});

/* ---- 4. สิทธิที่โค้ดอ้าง ต้องมีใน seed ------------------------------------- */
console.log('\n== 4. รหัสสิทธิที่โค้ดอ้างถึง ==');
const seedSql = fs.readFileSync(SEED, 'utf8');
const seedPerms = new Set();
const rePerm = /^\s*\('([a-z*][a-z_.]*)',\s*'[a-z]+',\s*'[a-z]+',/gm;
while ((m = rePerm.exec(seedSql))) seedPerms.add(m[1]);

const serverSrc = fs.readdirSync(SERVER).filter(f => f.endsWith('.gs'))
  .map(f => fs.readFileSync(path.join(SERVER, f), 'utf8')).join('\n');

const usedPerms = new Set();
[/perm:\s*'([^']+)'/g,
 /Auth\.require\(\s*'([^']+)'/g,
 /Auth\.can\([^,]+,\s*'([^']+)'/g,
 /Store\.can\(\s*'([^']+)'/g].forEach(function (re) {
  let x;
  while ((x = re.exec(serverSrc + '\n' + clientSrc))) usedPerms.add(x[1]);
});

let permMissing = 0;
usedPerms.forEach(function (p) {
  if (p === '*' || p === 'null') return;
  if (!seedPerms.has(p)) { fail('โค้ดอ้างสิทธิ "' + p + '" แต่ไม่มีใน 14_seed.sql'); permMissing++; }
});
if (!permMissing) ok('รหัสสิทธิที่ใช้ครบทั้ง ' + usedPerms.size + ' รายการ (seed มี ' +
                     seedPerms.size + ' รายการ)');

/* ---- 5. RPC ที่โค้ดเรียก ต้องมีใน SQL ------------------------------------- */
console.log('\n== 5. ฟังก์ชัน RPC ที่โค้ดเรียก ==');
const sqlDir = path.join(ROOT, '..', 'supabase', 'sql');
const sqlSrc = fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql'))
  .map(f => fs.readFileSync(path.join(sqlDir, f), 'utf8')).join('\n');

const definedFns = new Set();
const reFn = /create\s+or\s+replace\s+function\s+(\w+)/gi;
while ((m = reFn.exec(sqlSrc))) definedFns.add(m[1].toLowerCase());

const calledFns = new Set();
const reRpc = /DB\.rpc\(\s*'([^']+)'/g;
while ((m = reRpc.exec(serverSrc))) calledFns.add(m[1].toLowerCase());

let rpcMissing = 0;
calledFns.forEach(function (f) {
  if (!definedFns.has(f)) { fail('เรียก RPC "' + f + '" แต่ไม่พบใน SQL'); rpcMissing++; }
});
if (!rpcMissing) ok('RPC ที่เรียกครบทั้ง ' + calledFns.size + ' ฟังก์ชัน');

/* ---- 6. ตาราง/view ที่โค้ดอ้าง ต้องมีใน SQL ------------------------------- */
console.log('\n== 6. ตารางและ view ที่โค้ดอ้างถึง ==');
const definedRels = new Set();
[/create\s+table\s+if\s+not\s+exists\s+(\w+)/gi,
 /create\s+or\s+replace\s+view\s+(\w+)/gi].forEach(function (re) {
  let x;
  while ((x = re.exec(sqlSrc))) definedRels.add(x[1].toLowerCase());
});

const usedRels = new Set();
[/DB\.(?:select|selectPaged|first|insert|update|remove)\(\s*'([a-z_]+)'/g,
 /DB\.updateById\(\s*'([a-z_]+)'/g].forEach(function (re) {
  let x;
  while ((x = re.exec(serverSrc))) usedRels.add(x[1]);
});

let relMissing = 0;
usedRels.forEach(function (t) {
  if (!definedRels.has(t)) { fail('โค้ดอ้างตาราง/view "' + t + '" แต่ไม่พบใน SQL'); relMissing++; }
});
if (!relMissing) ok('ตาราง/view ที่ใช้ครบทั้ง ' + usedRels.size + ' รายการ');

console.log('\n=================================');
console.log(errors ? ('พบปัญหา ' + errors + ' รายการ') : 'เชื่อมต่อกันครบถ้วนทุกจุด');
console.log('=================================\n');
process.exit(errors ? 1 : 0);
