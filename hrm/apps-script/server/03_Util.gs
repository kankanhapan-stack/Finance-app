/**
 * HRM :: 03_Util.gs
 * เครื่องมือกลาง: วันที่ไทย, ตัวเลข, ตรวจข้อมูล, แจ้งเตือน, ห่อหุ้มผลลัพธ์ API
 */

const Util = {

  /** ห่อผลลัพธ์ให้ฝั่ง client อ่านรูปแบบเดียวกันเสมอ */
  ok: function (data, meta) {
    return { ok: true, data: data === undefined ? null : data, meta: meta || null };
  },

  fail: function (error, code) {
    const message = (error && error.message) ? error.message : String(error);
    if (CFG.DEBUG && error && error.stack) console.error(error.stack);
    return { ok: false, error: message, code: code || 'ERROR' };
  },

  /**
   * ห่อ handler ของ API ทุกตัว: จับ error, log, คืนรูปแบบมาตรฐาน
   *   return Util.handle('leave.list', function () { ... });
   */
  handle: function (name, fn) {
    const t0 = Date.now();
    try {
      const out = fn();
      if (CFG.DEBUG) console.log('[API] ' + name + ' ' + (Date.now() - t0) + 'ms');
      return this.ok(out);
    } catch (e) {
      console.error('[API] ' + name + ' ล้มเหลว: ' + e.message);
      return this.fail(e);
    }
  },

  // ------------------------------------------------------------------ วันที่
  TH_MONTHS: ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
              'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'],
  TH_MONTHS_SHORT: ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                    'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'],

  /** 'YYYY-MM-DD' ตามเขตเวลาไทย */
  isoDate: function (d) {
    return Utilities.formatDate(d || new Date(), CFG.TZ, 'yyyy-MM-dd');
  },

  isoDateTime: function (d) {
    return (d || new Date()).toISOString();
  },

  /** '24 สิงหาคม 2569' */
  thaiDate: function (value, short) {
    if (!value) return '';
    const d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const months = short ? this.TH_MONTHS_SHORT : this.TH_MONTHS;
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  },

  /** ปีงบประมาณไทย (1 ต.ค. - 30 ก.ย.) */
  fiscalYear: function (value) {
    const d = value ? new Date(value) : new Date();
    return d.getMonth() >= 9 ? d.getFullYear() + 544 : d.getFullYear() + 543;
  },

  /** ช่วงวันที่ของปีงบประมาณ */
  fiscalRange: function (fy) {
    const startYear = fy - 544;
    return {
      start: startYear + '-10-01',
      end: (startYear + 1) + '-09-30'
    };
  },

  addDays: function (value, n) {
    const d = new Date(value);
    d.setDate(d.getDate() + n);
    return this.isoDate(d);
  },

  daysBetween: function (from, to) {
    const a = new Date(from), b = new Date(to);
    return Math.round((b - a) / 86400000);
  },

  // ------------------------------------------------------------------ ตัวเลข
  money: function (n, digits) {
    const v = Number(n || 0);
    return v.toLocaleString('th-TH', {
      minimumFractionDigits: digits === undefined ? 2 : digits,
      maximumFractionDigits: digits === undefined ? 2 : digits
    });
  },

  minutesToText: function (min) {
    const m = Math.max(0, Math.round(Number(min || 0)));
    const h = Math.floor(m / 60);
    return (h ? h + ' ชม. ' : '') + (m % 60) + ' นาที';
  },

  /** อ่านจำนวนเงินเป็นตัวหนังสือไทย (ใช้ในหนังสือรับรอง) */
  bahtText: function (amount) {
    const num = ['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
    const pos = ['','สิบ','ร้อย','พัน','หมื่น','แสน','ล้าน'];

    function readInt(s) {
      s = String(s).replace(/^0+/, '');
      if (!s) return '';
      let out = '';
      const len = s.length;
      for (let i = 0; i < len; i++) {
        const digit = Number(s[i]);
        const place = len - i - 1;
        if (digit === 0) continue;
        if (place === 0 && digit === 1 && len > 1) out += 'เอ็ด';
        else if (place === 1 && digit === 1) out += '';
        else if (place === 1 && digit === 2) out += 'ยี่';
        else out += num[digit];
        out += pos[place % 7];
        if (place === 6) out += readInt(s.slice(i + 1)) ? '' : '';
      }
      return out;
    }

    const v = Math.abs(Number(amount || 0));
    const baht = Math.floor(v);
    const satang = Math.round((v - baht) * 100);
    let text = (baht === 0 ? 'ศูนย์' : readInt(String(baht))) + 'บาท';
    text += satang === 0 ? 'ถ้วน' : readInt(String(satang)) + 'สตางค์';
    return (Number(amount) < 0 ? 'ลบ' : '') + text;
  },

  // ---------------------------------------------------------------- ตรวจข้อมูล
  /** ตรวจเลขประจำตัวประชาชน 13 หลัก */
  validThaiId: function (id) {
    if (!id) return true;   // ไม่บังคับกรอก
    const s = String(id).replace(/\D/g, '');
    if (s.length !== 13) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
    return ((11 - (sum % 11)) % 10) === Number(s[12]);
  },

  /** โยน error ถ้าฟิลด์ที่บังคับยังว่าง */
  requireFields: function (obj, fields, labels) {
    const missing = [];
    (fields || []).forEach(function (f, i) {
      const v = obj ? obj[f] : undefined;
      if (v === undefined || v === null || String(v).trim() === '') {
        missing.push((labels && labels[i]) || f);
      }
    });
    if (missing.length) throw new Error('กรุณากรอกข้อมูล: ' + missing.join(', '));
  },

  /** เก็บเฉพาะคีย์ที่อนุญาต — กันการเขียนทับคอลัมน์ระบบจากฝั่ง client */
  pick: function (obj, allowed) {
    const out = {};
    (allowed || []).forEach(function (k) {
      if (obj && obj[k] !== undefined) out[k] = obj[k] === '' ? null : obj[k];
    });
    return out;
  },

  // ----------------------------------------------------------------- แจ้งเตือน
  /** เข้าคิวแจ้งเตือน (trigger จะส่งจริงภายหลัง) */
  notify: function (ctx, payload) {
    try {
      return DB.insert('notifications', {
        org_id: ctx.orgId,
        user_id: payload.userId || null,
        employee_id: payload.employeeId || null,
        channel: payload.channel || 'INAPP',
        title: payload.title,
        body: payload.body || null,
        link_url: payload.linkUrl || null,
        entity_type: payload.entityType || null,
        entity_id: payload.entityId || null
      });
    } catch (e) {
      console.warn('notify: ' + e.message);
      return null;
    }
  },

  /** หา user_id ของบุคลากร (ใช้ส่งแจ้งเตือนถึงผู้อนุมัติ) */
  userIdOfEmployee: function (employeeId) {
    if (!employeeId) return null;
    const u = DB.first('app_users', { select: 'id', filter: { employee_id: employeeId } });
    return u ? u.id : null;
  },

  /** เลขที่เอกสารถัดไป */
  nextDocNo: function (orgId, key, prefix, periodKey, pad) {
    return DB.rpc('fn_next_document_no', {
      p_org_id: orgId, p_seq_key: key, p_prefix: prefix || '',
      p_period_key: periodKey || '', p_pad: pad || 4
    });
  }
};
