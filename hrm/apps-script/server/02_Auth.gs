/**
 * HRM :: 02_Auth.gs
 * ยืนยันตัวตนและบังคับสิทธิ
 *
 * เพราะ Apps Script คุย Supabase ด้วย service_role (ข้าม RLS)
 * ชั้นนี้จึงเป็น "ด่านเดียว" ที่ตัดสินว่าใครทำอะไรได้ — ทุก API ต้องผ่าน Auth.require()
 *
 * การยืนยันตัวตน: ใช้บัญชี Google ของผู้ใช้ (Session.getActiveUser)
 * เทียบกับคอลัมน์ app_users.google_email  หรือ  app_users.email
 */

const Auth = (function () {

  const cache = CacheService.getUserCache();
  const CACHE_KEY = 'hrm_ctx_v1';
  const CACHE_SEC = 300;   // 5 นาที

  function activeEmail() {
    let email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }
    if (!email) {
      try { email = Session.getEffectiveUser().getEmail() || ''; } catch (e) { email = ''; }
    }
    return String(email).toLowerCase();
  }

  /** โหลดผู้ใช้ + สิทธิ + ขอบเขต จากฐานข้อมูล */
  function loadContext(email) {
    const user = DB.first('app_users', {
      select: 'id,org_id,email,google_email,display_name,employee_id,status,is_superadmin,preferences',
      or: 'email.eq.' + email + ',google_email.eq.' + email
    });

    if (!user) {
      logLogin(null, email, 'FAIL_NOT_FOUND');
      throw new Error('ไม่พบบัญชีผู้ใช้ ' + email + ' ในระบบ — กรุณาติดต่อผู้ดูแลระบบ');
    }
    if (user.status !== 'ACTIVE') {
      logLogin(user.id, email, 'FAIL_DISABLED');
      throw new Error('บัญชีผู้ใช้ถูกระงับ (สถานะ: ' + user.status + ')');
    }

    // สิทธิและขอบเขตจาก v_user_permissions
    const rows = DB.select('v_user_permissions', {
      select: 'permission_code,role_code,org_id,facility_id,department_id',
      filter: { user_id: user.id }
    });

    const perms = {};
    const roles = {};
    const facilityIds = {};
    const departmentIds = {};
    let orgId = user.org_id;

    rows.forEach(function (r) {
      perms[r.permission_code] = true;
      roles[r.role_code] = true;
      if (r.facility_id) facilityIds[r.facility_id] = true;
      if (r.department_id) departmentIds[r.department_id] = true;
      if (!orgId) orgId = r.org_id;
    });

    if (user.is_superadmin) perms['*'] = true;

    // ข้อมูลบุคลากรที่ผูกกับบัญชีนี้ (ใช้กับ self-service)
    let employee = null;
    if (user.employee_id) {
      employee = DB.first('v_employee_current', {
        select: 'employee_id,emp_code,full_name_th,photo_url,position_name,department_name,' +
                'facility_id,facility_name,department_id,employment_status,supervisor_id',
        filter: { employee_id: user.employee_id }
      });
    }

    const ctx = {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      isSuperadmin: !!user.is_superadmin,
      orgId: orgId,
      employeeId: user.employee_id || null,
      employee: employee,
      perms: perms,
      roles: Object.keys(roles),
      facilityIds: Object.keys(facilityIds),
      departmentIds: Object.keys(departmentIds),
      preferences: user.preferences || {}
    };

    return ctx;
  }

  function logLogin(userId, email, result) {
    try {
      DB.insert('login_logs', {
        user_id: userId, email: email, result: result, method: 'GOOGLE'
      });
    } catch (e) { /* log ล้มเหลวไม่ควรทำให้ระบบล่ม */ }
  }

  return {

    /** บริบทของผู้ใช้ปัจจุบัน (แคชไว้ 5 นาที) */
    context: function (forceReload) {
      if (!forceReload) {
        const cached = cache.get(CACHE_KEY);
        if (cached) {
          try { return JSON.parse(cached); } catch (e) { /* แคชเสีย - โหลดใหม่ */ }
        }
      }

      const email = activeEmail();
      if (!email) throw new Error('ไม่สามารถระบุตัวตนผู้ใช้ได้ — กรุณาเข้าสู่ระบบด้วยบัญชี Google');

      const ctx = loadContext(email);
      cache.put(CACHE_KEY, JSON.stringify(ctx), CACHE_SEC);

      // ตั้ง context ให้ trigger audit ฝั่ง DB
      DB.setContext(ctx.userId, ctx.orgId);
      return ctx;
    },

    /** ล้างแคชสิทธิ (เรียกหลังแก้ไขบทบาท/สิทธิของผู้ใช้) */
    clearCache: function () { cache.remove(CACHE_KEY); },

    /** มีสิทธินี้หรือไม่ */
    can: function (ctx, permission) {
      if (!ctx) return false;
      if (ctx.perms['*']) return true;
      return !!ctx.perms[permission];
    },

    /** มีสิทธิอย่างน้อยหนึ่งข้อในรายการ */
    canAny: function (ctx, permissions) {
      const self = this;
      return (permissions || []).some(function (p) { return self.can(ctx, p); });
    },

    /**
     * ด่านหลัก: คืน context ถ้ามีสิทธิ ไม่งั้นโยน error
     * ใช้ต้นทางของทุก API:  const ctx = Auth.require('leave.approve');
     */
    require: function (permission) {
      const ctx = this.context();
      if (permission && !this.can(ctx, permission)) {
        throw new Error('ไม่มีสิทธิใช้งานส่วนนี้ (ต้องการสิทธิ: ' + permission + ')');
      }
      DB.setContext(ctx.userId, ctx.orgId);
      return ctx;
    },

    /**
     * ตรวจว่าดูข้อมูลบุคลากรรายนี้ได้หรือไม่
     * กติกาเดียวกับฟังก์ชัน auth_can_see_employee() ใน RLS
     */
    canSeeEmployee: function (ctx, employeeId) {
      if (!employeeId) return false;
      if (this.can(ctx, '*') || this.can(ctx, 'employee.read_all')) return true;
      if (ctx.employeeId === employeeId) return true;

      const emp = DB.first('v_employee_current', {
        select: 'employee_id,facility_id,department_id,supervisor_id',
        filter: { employee_id: employeeId }
      });
      if (!emp) return false;

      if (emp.supervisor_id && emp.supervisor_id === ctx.employeeId) return true;
      if (this.can(ctx, 'employee.read_facility') &&
          ctx.facilityIds.indexOf(emp.facility_id) >= 0) return true;
      if (ctx.departmentIds.indexOf(emp.department_id) >= 0) return true;
      return false;
    },

    /** เหมือน canSeeEmployee แต่โยน error */
    requireEmployee: function (ctx, employeeId) {
      if (!this.canSeeEmployee(ctx, employeeId)) {
        throw new Error('ไม่มีสิทธิเข้าถึงข้อมูลบุคลากรรายนี้');
      }
      return true;
    },

    /**
     * สร้าง filter ขอบเขตข้อมูลตามสิทธิของผู้ใช้ (ใช้กับ query รายการ)
     * - เห็นทั้งองค์กร  -> { org_id }
     * - เห็นเฉพาะสถานบริการที่ดูแล -> { org_id, facility_id: [..] }
     * - เห็นเฉพาะตนเอง -> { employee_id }
     */
    scopeFilter: function (ctx, opts) {
      opts = opts || {};
      const f = {};
      const orgCol = opts.orgColumn || 'org_id';
      const facCol = opts.facilityColumn || 'facility_id';
      const empCol = opts.employeeColumn || 'employee_id';

      f[orgCol] = ctx.orgId;

      if (this.can(ctx, '*') || this.can(ctx, 'employee.read_all') ||
          this.can(ctx, (opts.module || '') + '.read_all')) {
        return f;
      }
      if (this.can(ctx, 'employee.read_facility') && ctx.facilityIds.length) {
        f[facCol] = ctx.facilityIds;
        return f;
      }
      // เห็นเฉพาะของตนเอง
      f[empCol] = ctx.employeeId || '00000000-0000-0000-0000-000000000000';
      return f;
    },

    /** บันทึกการเข้าถึงข้อมูลส่วนบุคคล (PDPA) */
    logAccess: function (ctx, info) {
      try {
        DB.insert('data_access_logs', {
          org_id: ctx.orgId,
          actor_user_id: ctx.userId,
          actor_email: ctx.email,
          subject_employee_id: info.employeeId || null,
          module: info.module,
          action: info.action || 'VIEW',
          entity_type: info.entityType || null,
          entity_id: info.entityId || null,
          purpose: info.purpose || null
        });
      } catch (e) { console.warn('logAccess: ' + e.message); }
    },

    /** เรียกตอนเข้าระบบสำเร็จ */
    recordLogin: function (ctx) {
      logLogin(ctx.userId, ctx.email, 'SUCCESS');
      try {
        DB.updateById('app_users', ctx.userId, {
          last_login_at: new Date().toISOString(), login_fail_count: 0
        });
      } catch (e) { /* ไม่สำคัญพอจะทำให้ล็อกอินล้ม */ }
    },

    /** เมนูที่ผู้ใช้รายนี้เห็น */
    visibleModules: function (ctx) {
      const self = this;
      return MODULES.filter(function (m) { return self.can(ctx, m.perm); });
    }
  };
})();
