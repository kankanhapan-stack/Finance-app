/**
 * Supabase REST client (PostgREST + Storage) สำหรับ Google Apps Script
 * ต้องตั้ง Script Properties: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

function sbConfig_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('SUPABASE_URL');
  const key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY ใน Script Properties');
  return { url: url.replace(/\/+$/, ''), key: key };
}

function sbFetch_(method, path, body, headers) {
  const cfg = sbConfig_();
  const opts = {
    method: method,
    muteHttpExceptions: true,
    headers: Object.assign({ apikey: cfg.key, Authorization: 'Bearer ' + cfg.key }, headers || {})
  };
  if (body !== undefined && body !== null) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(cfg.url + path, opts);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.error || text; } catch (e) {}
    throw new Error('Supabase ' + code + ': ' + msg);
  }
  return { code: code, text: text, headers: res.getAllHeaders() };
}

/** encode ค่าสำหรับ PostgREST filter */
function q_(v) { return encodeURIComponent(v); }

/** SELECT: query เช่น 'select=*&moo=eq.1&order=first_name' */
function sbSelect(table, query) {
  const r = sbFetch_('get', '/rest/v1/' + table + (query ? '?' + query : ''));
  return r.text ? JSON.parse(r.text) : [];
}

/** SELECT พร้อมนับจำนวนทั้งหมด (สำหรับแบ่งหน้า) */
function sbSelectPaged(table, query, offset, limit) {
  const r = sbFetch_('get', '/rest/v1/' + table + '?' + query, null, {
    Prefer: 'count=exact',
    'Range-Unit': 'items',
    Range: offset + '-' + (offset + limit - 1)
  });
  const range = r.headers['Content-Range'] || r.headers['content-range'] || '';
  const total = Number(String(range).split('/')[1]) || 0;
  return { rows: r.text ? JSON.parse(r.text) : [], total: total };
}

function sbOne(table, id, select) {
  const rows = sbSelect(table, 'select=' + (select || '*') + '&id=eq.' + q_(id));
  return rows[0] || null;
}

function sbInsert(table, rows, upsertOn) {
  const headers = { Prefer: 'return=representation' };
  let path = '/rest/v1/' + table;
  if (upsertOn) {
    headers.Prefer += ',resolution=merge-duplicates';
    path += '?on_conflict=' + upsertOn;
  }
  const r = sbFetch_('post', path, rows, headers);
  return r.text ? JSON.parse(r.text) : [];
}

function sbUpdate(table, filter, patch) {
  const r = sbFetch_('patch', '/rest/v1/' + table + '?' + filter, patch, { Prefer: 'return=representation' });
  return r.text ? JSON.parse(r.text) : [];
}

function sbDelete(table, filter) {
  sbFetch_('delete', '/rest/v1/' + table + '?' + filter);
  return true;
}

function sbRpc(fn, args) {
  const r = sbFetch_('post', '/rest/v1/rpc/' + fn, args || {});
  return r.text ? JSON.parse(r.text) : null;
}

/** insert หรือ update ตาม id */
function sbSave(table, row) {
  const data = Object.assign({}, row);
  const id = data.id;
  delete data.id;
  Object.keys(data).forEach(function (k) { if (data[k] === '') data[k] = null; });
  if (id) return sbUpdate(table, 'id=eq.' + q_(id), data)[0];
  return sbInsert(table, data)[0];
}

// ---------------- Storage ----------------
const PHOTO_BUCKET = 'visit-photos';

function sbUpload(path, bytes, contentType) {
  const cfg = sbConfig_();
  const res = UrlFetchApp.fetch(cfg.url + '/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: contentType,
    payload: bytes,
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'x-upsert': 'true' }
  });
  if (res.getResponseCode() >= 300) throw new Error('อัปโหลดรูปไม่สำเร็จ: ' + res.getContentText());
  return path;
}

/** สร้าง signed URL หลายไฟล์ (bucket เป็น private) */
function sbSignedUrls(paths, expiresIn) {
  if (!paths.length) return {};
  const cfg = sbConfig_();
  const r = sbFetch_('post', '/storage/v1/object/sign/' + PHOTO_BUCKET, { expiresIn: expiresIn || 3600, paths: paths });
  const out = {};
  JSON.parse(r.text).forEach(function (o) {
    if (o.signedURL) out[o.path] = cfg.url + '/storage/v1' + o.signedURL;
  });
  return out;
}

function sbRemoveFiles(paths) {
  paths.forEach(function (p) {
    try { sbFetch_('delete', '/storage/v1/object/' + PHOTO_BUCKET + '/' + p); } catch (e) { console.warn(e); }
  });
}
