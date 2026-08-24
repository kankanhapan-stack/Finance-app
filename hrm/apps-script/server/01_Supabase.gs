/**
 * HRM :: 01_Supabase.gs
 * ตัวเชื่อม Supabase PostgREST — เป็นชั้นเดียวในระบบที่คุยกับฐานข้อมูลโดยตรง
 *
 * ใช้ service_role key จึงข้าม RLS  ->  การบังคับสิทธิทำที่ 02_Auth.gs
 * ทุกคำสั่งจะส่ง context ของผู้ใช้ปัจจุบันไปด้วย เพื่อให้ trigger audit บันทึกได้ว่าใครทำ
 */

const DB = (function () {

  function headers(extra) {
    const h = {
      'apikey': CFG.SERVICE_KEY,
      'Authorization': 'Bearer ' + CFG.SERVICE_KEY,
      'Content-Type': 'application/json',
      'Accept-Profile': 'public',
      'Content-Profile': 'public'
    };
    return Object.assign(h, extra || {});
  }

  function request(method, url, payload, extraHeaders) {
    const missing = CFG.validate();
    if (missing.length) {
      throw new Error('ยังไม่ได้ตั้งค่า Script Properties: ' + missing.join(', '));
    }

    const options = {
      method: method,
      headers: headers(extraHeaders),
      muteHttpExceptions: true,
      followRedirects: true
    };
    if (payload !== undefined && payload !== null) {
      options.payload = JSON.stringify(payload);
    }

    const res  = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const text = res.getContentText();

    if (code >= 400) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.message || j.error_description || j.error || j.hint || text;
        if (j.details) msg += ' (' + j.details + ')';
      } catch (e) { /* ใช้ข้อความดิบ */ }
      if (CFG.DEBUG) console.error('[DB] ' + method + ' ' + url + ' -> ' + code + ' ' + text);
      throw new Error(msg);
    }

    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  /** แปลง object filter เป็น query string ของ PostgREST */
  function buildQuery(opts) {
    opts = opts || {};
    const parts = [];

    if (opts.select) parts.push('select=' + encodeURIComponent(opts.select));

    /*
     * filter รองรับ 4 รูปแบบ (ทุกเงื่อนไขเชื่อมกันด้วย AND):
     *   { col: 'x' }                          -> col=eq.x
     *   { col: null }                         -> col=is.null
     *   { col: ['a','b'] }                    -> col=in.(a,b)
     *   { col: {op:'gte', value:'2569-10-01'} }
     *   { col: [{op:'gte',value:a},{op:'lte',value:b}] }  -> ช่วงค่า (AND กัน)
     * op ที่ใช้ได้: eq, neq, gt, gte, lt, lte, like, ilike, is, in, cs, cd, ov, fts
     */
    function condition(col, v) {
      if (v === undefined) return;
      if (v === null) {
        parts.push(encodeURIComponent(col) + '=is.null');
        return;
      }
      if (Array.isArray(v)) {
        // อาเรย์ของเงื่อนไข -> ใส่ทีละข้อ (PostgREST เชื่อมด้วย AND)
        if (v.length && v[0] && typeof v[0] === 'object' && v[0].op) {
          v.forEach(function (c) { condition(col, c); });
        } else {
          parts.push(encodeURIComponent(col) + '=in.(' +
            v.map(function (x) { return encodeURIComponent(x); }).join(',') + ')');
        }
        return;
      }
      if (typeof v === 'object' && v.op) {
        const val = Array.isArray(v.value) ? '(' + v.value.join(',') + ')' : v.value;
        parts.push(encodeURIComponent(col) + '=' + v.op + '.' + encodeURIComponent(val));
        return;
      }
      parts.push(encodeURIComponent(col) + '=eq.' + encodeURIComponent(v));
    }

    const f = opts.filter || {};
    Object.keys(f).forEach(function (col) { condition(col, f[col]); });

    // เงื่อนไข or: 'status.eq.PENDING,status.eq.DRAFT'
    if (opts.or) parts.push('or=(' + encodeURIComponent(opts.or) + ')');

    if (opts.order)  parts.push('order=' + encodeURIComponent(opts.order));
    if (opts.limit)  parts.push('limit=' + Number(opts.limit));
    if (opts.offset) parts.push('offset=' + Number(opts.offset));

    return parts.length ? '?' + parts.join('&') : '';
  }

  return {
    /** SELECT — คืน array */
    select: function (table, opts) {
      const url = CFG.REST + '/' + table + buildQuery(opts);
      const extra = {};
      if (opts && opts.count) extra['Prefer'] = 'count=' + opts.count;
      return request('get', url, null, extra) || [];
    },

    /** SELECT พร้อมจำนวนรวม — คืน {rows, total} สำหรับตารางแบ่งหน้า */
    selectPaged: function (table, opts) {
      opts = opts || {};
      const url = CFG.REST + '/' + table + buildQuery(opts);
      const options = {
        method: 'get',
        headers: headers({ 'Prefer': 'count=exact', 'Range-Unit': 'items' }),
        muteHttpExceptions: true
      };
      const res  = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const text = res.getContentText();
      if (code >= 400) throw new Error(text);

      const range = res.getHeaders()['content-range'] || res.getHeaders()['Content-Range'] || '';
      const total = Number(String(range).split('/')[1] || 0);
      return { rows: text ? JSON.parse(text) : [], total: total };
    },

    /** SELECT แถวเดียว — คืน object หรือ null */
    first: function (table, opts) {
      const rows = this.select(table, Object.assign({}, opts, { limit: 1 }));
      return rows.length ? rows[0] : null;
    },

    /** INSERT — payload เป็น object หรือ array; คืนแถวที่สร้าง */
    insert: function (table, payload, opts) {
      opts = opts || {};
      const q = opts.select ? '?select=' + encodeURIComponent(opts.select) : '?select=*';
      const prefer = ['return=representation'];
      if (opts.upsertOn) prefer.push('resolution=merge-duplicates');
      const url = CFG.REST + '/' + table + q
                + (opts.upsertOn ? '&on_conflict=' + encodeURIComponent(opts.upsertOn) : '');
      const out = request('post', url, payload, { 'Prefer': prefer.join(',') });
      return Array.isArray(payload) ? out : (out && out[0]) || null;
    },

    /** UPDATE ตาม filter — คืน array ของแถวที่ถูกแก้ */
    update: function (table, filter, patch) {
      const url = CFG.REST + '/' + table + buildQuery({ filter: filter, select: '*' });
      return request('patch', url, patch, { 'Prefer': 'return=representation' }) || [];
    },

    /** UPDATE ตาม id — คืนแถวเดียว */
    updateById: function (table, id, patch) {
      const rows = this.update(table, { id: id }, patch);
      return rows.length ? rows[0] : null;
    },

    /** DELETE ตาม filter (ระบบนี้เลี่ยงการลบจริง ใช้ is_active=false เป็นหลัก) */
    remove: function (table, filter) {
      if (!filter || !Object.keys(filter).length) {
        throw new Error('ปฏิเสธการลบแบบไม่มีเงื่อนไข');
      }
      const url = CFG.REST + '/' + table + buildQuery({ filter: filter, select: '*' });
      return request('delete', url, null, { 'Prefer': 'return=representation' }) || [];
    },

    /** เรียก RPC (stored function) */
    rpc: function (fnName, args) {
      const url = CFG.RPC + '/' + fnName;
      return request('post', url, args || {});
    },

    /** ตั้ง context ผู้ใช้ให้ trigger audit รู้ว่าใครทำ (เรียกก่อนคำสั่งเขียนทุกครั้ง) */
    setContext: function (userId, orgId) {
      try {
        this.rpc('fn_set_context', { p_user_id: userId || null, p_org_id: orgId || null });
      } catch (e) {
        // ไม่ให้ล้มทั้ง request เพราะ context เป็นข้อมูลเสริม
        console.warn('setContext ล้มเหลว: ' + e.message);
      }
    },

    /** อัปโหลดไฟล์ขึ้น Supabase Storage — คืน path ที่เก็บ */
    uploadFile: function (bucket, path, blob, contentType) {
      const url = CFG.STORAGE + '/object/' + bucket + '/' + path;
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: {
          'apikey': CFG.SERVICE_KEY,
          'Authorization': 'Bearer ' + CFG.SERVICE_KEY,
          'Content-Type': contentType || blob.getContentType(),
          'x-upsert': 'true'
        },
        payload: blob.getBytes(),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() >= 400) throw new Error(res.getContentText());
      return bucket + '/' + path;
    },

    /** สร้างลิงก์ดาวน์โหลดชั่วคราว (signed URL) */
    signedUrl: function (bucket, path, expiresSec) {
      const out = request('post', CFG.STORAGE + '/object/sign/' + bucket + '/' + path,
                          { expiresIn: expiresSec || 3600 });
      return CFG.STORAGE + (out.signedURL || out.signedUrl || '');
    }
  };
})();
