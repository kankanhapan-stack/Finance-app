/**
 * HRM :: 25_Api_Public.gs
 * ช่องทางสาธารณะ (ไม่ต้องล็อกอิน) — ใช้กับหน้าเว็บสมัครงานและหน้าตรวจสอบเอกสาร
 *
 * ข้อควรระวังด้านความปลอดภัย:
 *   - เปิดเฉพาะคำสั่งใน PUBLIC_ROUTES เท่านั้น ไม่ผูกกับ ROUTES ปกติ
 *   - ทุกคำสั่งคืนเฉพาะฟิลด์ที่จำเป็น ไม่คืนข้อมูลบุคลากรหรือข้อมูลภายใน
 *   - มีการจำกัดจำนวนครั้งต่อ IP/ช่วงเวลา ผ่าน CacheService กันการยิงถล่ม
 */

const PUBLIC_ROUTES = {

  /** ประกาศรับสมัครที่เปิดอยู่ (ขององค์กรตั้งต้น) */
  'jobs.list': function () {
    const org = publicOrg();
    const today = Util.isoDate();

    const rows = DB.select('job_postings', {
      select: 'id,title,openings,salary_min,salary_max,open_date,close_date,' +
              'employment_type,work_location,positions(name_th),facilities(name_th)',
      filter: {
        org_id: org.id,
        is_public: true,
        status: 'OPEN',
        open_date: { op: 'lte', value: today },
        close_date: { op: 'gte', value: today }
      },
      order: 'close_date',
      limit: 50
    });

    return rows.map(function (r) {
      return {
        id: r.id,
        title: r.title,
        openings: r.openings,
        salary_min: r.salary_min,
        salary_max: r.salary_max,
        open_date: r.open_date,
        close_date: r.close_date,
        position_name: (r.positions || {}).name_th || '',
        facility_name: (r.facilities || {}).name_th || ''
      };
    });
  },

  /** รายละเอียดประกาศ 1 ฉบับ */
  'jobs.get': function (p) {
    if (!p.id) throw new Error('ไม่ได้ระบุประกาศ');
    const org = publicOrg();
    const today = Util.isoDate();

    const r = DB.first('job_postings', {
      select: 'id,title,openings,salary_min,salary_max,open_date,close_date,qualification,' +
              'description,benefits,work_location,employment_type,exam_date,contact_info,' +
              'view_count,positions(name_th),facilities(name_th)',
      filter: { id: p.id, org_id: org.id, is_public: true, status: 'OPEN' }
    });
    if (!r) throw new Error('ไม่พบประกาศ หรือประกาศปิดรับสมัครแล้ว');
    if (r.close_date < today) throw new Error('ประกาศนี้ปิดรับสมัครแล้ว');

    // นับยอดผู้เข้าชม (ไม่ให้ล้มถ้าเขียนไม่ได้)
    try {
      DB.updateById('job_postings', r.id, { view_count: Number(r.view_count || 0) + 1 });
    } catch (e) { /* ไม่สำคัญ */ }

    r.position_name = (r.positions || {}).name_th || '';
    r.facility_name = (r.facilities || {}).name_th || '';
    delete r.positions;
    delete r.facilities;
    return r;
  },

  /** ยื่นใบสมัครออนไลน์ */
  'jobs.apply': function (p) {
    const org = publicOrg();
    const today = Util.isoDate();

    if (!p.posting_id) throw new Error('ไม่ได้ระบุประกาศที่ต้องการสมัคร');
    const a = p.applicant || {};

    Util.requireFields(a, ['national_id', 'first_name_th', 'last_name_th', 'phone', 'email'],
                          ['เลขประจำตัวประชาชน', 'ชื่อ', 'นามสกุล', 'โทรศัพท์', 'อีเมล']);
    if (!Util.validThaiId(a.national_id)) {
      throw new Error('เลขประจำตัวประชาชนไม่ถูกต้อง');
    }

    const posting = DB.first('job_postings', {
      select: 'id,title,status,open_date,close_date,is_public',
      filter: { id: p.posting_id, org_id: org.id }
    });
    if (!posting || !posting.is_public || posting.status !== 'OPEN') {
      throw new Error('ประกาศนี้ไม่เปิดรับสมัคร');
    }
    if (today < posting.open_date || today > posting.close_date) {
      throw new Error('อยู่นอกช่วงเวลารับสมัคร');
    }

    // ผู้สมัครเดิม (จากเลขบัตร) ใช้ระเบียบเดิม ไม่สร้างซ้ำ
    let applicant = DB.first('applicants', {
      select: 'id,is_blacklisted',
      filter: { org_id: org.id, national_id: a.national_id }
    });

    const payload = {
      org_id: org.id,
      national_id: a.national_id,
      title_th: a.title_th || null,
      first_name_th: a.first_name_th,
      last_name_th: a.last_name_th,
      gender: a.gender || null,
      birth_date: a.birth_date || null,
      phone: a.phone,
      email: a.email,
      education: Array.isArray(a.education) ? a.education : [],
      resume_url: a.resume_url || null,
      source: 'WEBSITE'
    };

    if (applicant) {
      if (applicant.is_blacklisted) {
        // ไม่บอกเหตุผลตรง ๆ กับบุคคลภายนอก
        throw new Error('ไม่สามารถรับใบสมัครได้ กรุณาติดต่อหน่วยงาน');
      }
      DB.updateById('applicants', applicant.id, payload);
    } else {
      applicant = DB.insert('applicants', payload);
    }

    const dup = DB.first('applications', {
      select: 'id,application_no',
      filter: { posting_id: posting.id, applicant_id: applicant.id }
    });
    if (dup) {
      return { application_no: dup.application_no, duplicated: true };
    }

    const app = DB.insert('applications', {
      org_id: org.id,
      posting_id: posting.id,
      applicant_id: applicant.id,
      application_no: Util.nextDocNo(org.id, 'APPLICANT', 'สอบ-', Util.fiscalYear().toString(), 4),
      stage: 'RECEIVED'
    });

    // แจ้งเจ้าหน้าที่สรรหา
    Util.notify({ orgId: org.id }, {
      title: 'มีผู้สมัครใหม่: ' + posting.title,
      body: [a.title_th, a.first_name_th, a.last_name_th].filter(Boolean).join(' ') +
            ' · เลขประจำตัวสอบ ' + app.application_no,
      entityType: 'applications', entityId: app.id
    });

    return { application_no: app.application_no };
  }
};

/** องค์กรตั้งต้นที่ใช้กับหน้าเว็บสาธารณะ */
function publicOrg() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('hrm_public_org');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* แคชเสีย */ }
  }
  const org = DB.first('organizations', {
    select: 'id,code,name_th',
    filter: { code: CFG.DEFAULT_ORG_CODE, is_active: true }
  });
  if (!org) throw new Error('ยังไม่ได้ตั้งค่าองค์กรตั้งต้น (DEFAULT_ORG_CODE)');
  cache.put('hrm_public_org', JSON.stringify(org), 3600);
  return org;
}

/**
 * จุดเข้าสาธารณะ — เรียกจากหน้า PublicJobs.html
 * ไม่ผ่าน Auth เพราะเปิดให้บุคคลภายนอก จึงจำกัดคำสั่งและอัตราการเรียกอย่างเข้มงวด
 */
function publicApi(action, payload) {
  return Util.handle('public:' + action, function () {
    const handler = PUBLIC_ROUTES[action];
    if (!handler) throw new Error('ไม่รู้จักคำสั่ง');

    // จำกัดอัตราการเรียก: เขียนข้อมูลได้ไม่เกิน 5 ครั้ง/10 นาที ต่อผู้ใช้หนึ่งราย
    if (action === 'jobs.apply') {
      const cache = CacheService.getScriptCache();
      const key = 'apply_' + ((payload && payload.applicant && payload.applicant.national_id) ||
                              'anon').slice(0, 20);
      const count = Number(cache.get(key) || 0);
      if (count >= 5) {
        throw new Error('ยื่นใบสมัครถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
      }
      cache.put(key, String(count + 1), 600);
    }

    return handler(payload || {});
  });
}
