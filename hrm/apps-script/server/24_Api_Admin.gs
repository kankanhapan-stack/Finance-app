/**
 * HRM :: 24_Api_Admin.gs
 * จัดการผู้ใช้ระบบ บทบาท และการตั้งค่าองค์กร
 */

function routesAdmin() {
  return {

    'admin.userList': {
      perm: 'user.read',
      fn: function (p, ctx) {
        const users = DB.select('app_users', {
          select: 'id,email,google_email,display_name,employee_id,status,is_superadmin,last_login_at,' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: { org_id: ctx.orgId }, order: 'display_name', limit: p.limit || 500
        });

        const ids = users.map(function (u) { return u.id; });
        if (ids.length) {
          const roles = DB.select('user_roles', {
            select: 'user_id,role_id,facility_id,department_id,effective_from,effective_to,' +
                    'roles(code,name_th)',
            filter: { user_id: ids }
          });
          const byUser = {};
          roles.forEach(function (r) {
            (byUser[r.user_id] = byUser[r.user_id] || []).push(r);
          });
          users.forEach(function (u) { u.roles = byUser[u.id] || []; });
        }
        return users;
      }
    },

    'admin.userSave': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['email', 'display_name'], ['อีเมล', 'ชื่อที่แสดง']);
        const data = Util.pick(p, ['email','google_email','display_name','employee_id',
                                   'status','is_superadmin','preferences']);
        data.org_id = ctx.orgId;

        // เฉพาะ superadmin เท่านั้นที่ตั้ง superadmin คนอื่นได้
        if (data.is_superadmin && !ctx.isSuperadmin) {
          throw new Error('เฉพาะผู้ดูแลระบบสูงสุดเท่านั้นที่กำหนดสิทธินี้ได้');
        }

        if (p.id) {
          if (p.id === ctx.userId && data.status && data.status !== 'ACTIVE') {
            throw new Error('ระงับบัญชีของตนเองไม่ได้');
          }
          return DB.updateById('app_users', p.id, data);
        }

        const dup = DB.first('app_users', {
          select: 'id', filter: { email: String(data.email).toLowerCase() }
        });
        if (dup) throw new Error('อีเมล ' + data.email + ' ถูกใช้แล้ว');

        data.email = String(data.email).toLowerCase();
        if (data.google_email) data.google_email = String(data.google_email).toLowerCase();
        return DB.insert('app_users', data);
      }
    },

    /** สร้างบัญชีผู้ใช้จากข้อมูลบุคลากร (ทีละหลายคน) */
    'admin.userCreateFromEmployees': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_ids'], ['บุคลากร']);
        const roleId = p.role_id || DB.first('roles', {
          select: 'id', filter: { code: 'EMPLOYEE', is_system: true }
        }).id;

        const employees = DB.select('v_employee_current', {
          select: 'employee_id,emp_code,full_name_th,email,email_work,facility_id,department_id',
          filter: { employee_id: p.employee_ids }
        });

        const existing = DB.select('app_users', {
          select: 'employee_id', filter: { employee_id: p.employee_ids }
        }).reduce(function (m, r) { m[r.employee_id] = true; return m; }, {});

        const created = [], skipped = [];
        employees.forEach(function (e) {
          if (existing[e.employee_id]) { skipped.push(e.emp_code + ' (มีบัญชีแล้ว)'); return; }
          const email = e.email_work || e.email;
          if (!email) { skipped.push(e.emp_code + ' (ไม่มีอีเมล)'); return; }

          try {
            const u = DB.insert('app_users', {
              org_id: ctx.orgId,
              email: String(email).toLowerCase(),
              google_email: String(email).toLowerCase(),
              display_name: e.full_name_th,
              employee_id: e.employee_id,
              status: 'ACTIVE'
            });
            DB.insert('user_roles', {
              user_id: u.id, role_id: roleId, org_id: ctx.orgId,
              facility_id: e.facility_id || null, created_by: ctx.userId
            });
            created.push(e.emp_code);
          } catch (err) {
            skipped.push(e.emp_code + ' (' + err.message + ')');
          }
        });
        return { created: created, skipped: skipped };
      }
    },

    'admin.roleList': {
      perm: 'user.read',
      fn: function (p, ctx) {
        const roles = DB.select('roles', {
          select: 'id,code,name_th,description,is_system,org_id',
          filter: { org_id: [ctx.orgId] }, order: 'code'
        });
        // รวมบทบาทระบบ (org_id = null)
        const system = DB.select('roles', {
          select: 'id,code,name_th,description,is_system,org_id',
          filter: { org_id: null }, order: 'code'
        });
        const all = system.concat(roles);

        const perms = DB.select('role_permissions', {
          select: 'role_id,permission_code',
          filter: { role_id: all.map(function (r) { return r.id; }) }
        });
        const byRole = {};
        perms.forEach(function (r) { (byRole[r.role_id] = byRole[r.role_id] || []).push(r.permission_code); });
        all.forEach(function (r) { r.permissions = byRole[r.id] || []; });

        return { roles: all, permissions: DB.select('permissions', { order: 'module,code' }) };
      }
    },

    'admin.roleSave': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสบทบาท', 'ชื่อบทบาท']);
        const data = Util.pick(p, ['code', 'name_th', 'description']);
        data.org_id = ctx.orgId;

        let role;
        if (p.id) {
          const existing = DB.first('roles', { select: 'is_system,org_id', filter: { id: p.id } });
          if (existing && existing.is_system) throw new Error('บทบาทของระบบแก้ไขไม่ได้');
          role = DB.updateById('roles', p.id, data);
        } else {
          role = DB.insert('roles', data);
        }

        if (p.permissions) {
          DB.remove('role_permissions', { role_id: role.id });
          if (p.permissions.length) {
            DB.insert('role_permissions', p.permissions.map(function (code) {
              return { role_id: role.id, permission_code: code };
            }));
          }
        }
        Auth.clearCache();
        return role;
      }
    },

    'admin.assignRole': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['user_id', 'role_id'], ['ผู้ใช้', 'บทบาท']);
        const saved = DB.insert('user_roles', {
          user_id: p.user_id,
          role_id: p.role_id,
          org_id: ctx.orgId,
          facility_id: p.facility_id || null,
          department_id: p.department_id || null,
          effective_from: p.effective_from || Util.isoDate(),
          effective_to: p.effective_to || null,
          created_by: ctx.userId
        }, { upsertOn: 'user_id,role_id,org_id,facility_id,department_id' });
        Auth.clearCache();
        return saved;
      }
    },

    'admin.revokeRole': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['การให้สิทธิ']);
        const ur = DB.first('user_roles', {
          select: 'user_id,role_id,roles(code)', filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!ur) throw new Error('ไม่พบรายการสิทธิ');

        // กันการถอดสิทธิ superadmin คนสุดท้าย
        if (ur.roles && ur.roles.code === 'SUPERADMIN') {
          const count = DB.select('user_roles', {
            select: 'id', filter: { role_id: ur.role_id, org_id: ctx.orgId }
          }).length;
          if (count <= 1) throw new Error('ต้องมีผู้ดูแลระบบสูงสุดอย่างน้อย 1 คน');
        }

        const out = DB.remove('user_roles', { id: p.id, org_id: ctx.orgId });
        Auth.clearCache();
        return out;
      }
    },

    'admin.orgSettings': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        if (p.settings) {
          return DB.updateById('organizations', ctx.orgId, {
            settings: p.settings,
            name_th: p.name_th || undefined,
            logo_url: p.logo_url || undefined,
            address: p.address || undefined,
            contact: p.contact || undefined
          });
        }
        return DB.first('organizations', { filter: { id: ctx.orgId } });
      }
    },

    'admin.approvalFlowList': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        const flows = DB.select('approval_flows', {
          filter: { org_id: ctx.orgId }, order: 'entity_type,code'
        });
        flows.forEach(function (f) {
          f.steps = DB.select('approval_flow_steps', {
            select: '*,roles(code,name_th)',
            filter: { flow_id: f.id }, order: 'step_no'
          });
        });
        return flows;
      }
    },

    'admin.approvalFlowSave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th', 'entity_type'],
                              ['รหัส', 'ชื่อสายอนุมัติ', 'ประเภทเอกสาร']);
        const data = Util.pick(p, ['code','name_th','entity_type','condition','is_active']);
        data.org_id = ctx.orgId;

        const flow = p.id ? DB.updateById('approval_flows', p.id, data)
                          : DB.insert('approval_flows', data);

        if (p.steps) {
          DB.remove('approval_flow_steps', { flow_id: flow.id });
          if (p.steps.length) {
            DB.insert('approval_flow_steps', p.steps.map(function (s, i) {
              return {
                flow_id: flow.id,
                step_no: s.step_no || (i + 1),
                name_th: s.name_th,
                approver_type: s.approver_type,
                approver_role_id: s.approver_role_id || null,
                approver_user_id: s.approver_user_id || null,
                is_final: i === p.steps.length - 1,
                allow_delegate: s.allow_delegate !== false,
                sla_hours: s.sla_hours || null
              };
            }));
          }
        }
        return flow;
      }
    },

    /** ตรวจความพร้อมของระบบ (ใช้หลังติดตั้ง) */
    'admin.healthCheck': {
      perm: 'user.manage',
      fn: function (p, ctx) {
        const checks = [];
        function check(name, fn) {
          try { checks.push({ name: name, ok: true, detail: fn() }); }
          catch (e) { checks.push({ name: name, ok: false, detail: e.message }); }
        }

        check('เชื่อมต่อ Supabase', function () {
          return 'พบองค์กร ' + DB.select('organizations', { select: 'id', limit: 1 }).length + ' รายการ';
        });
        check('ตารางสิทธิ', function () {
          return DB.select('permissions', { select: 'code' }).length + ' สิทธิ';
        });
        check('บทบาทระบบ', function () {
          return DB.select('roles', { select: 'code', filter: { is_system: true } }).length + ' บทบาท';
        });
        check('ประเภทการลา', function () {
          const n = DB.select('leave_types', { select: 'id', filter: { org_id: ctx.orgId } }).length;
          if (!n) throw new Error('ยังไม่ได้ตั้งค่าประเภทการลา');
          return n + ' ประเภท';
        });
        check('สายอนุมัติใบลา', function () {
          const n = DB.select('approval_flows', {
            select: 'id', filter: { org_id: ctx.orgId, entity_type: 'LEAVE_REQUEST', is_active: true }
          }).length;
          if (!n) throw new Error('ยังไม่ได้ตั้งค่าสายอนุมัติใบลา');
          return n + ' สาย';
        });
        check('กะการทำงาน', function () {
          return DB.select('work_shifts', { select: 'id', filter: { org_id: ctx.orgId } }).length + ' กะ';
        });
        check('โฟลเดอร์ Drive สำหรับเอกสาร', function () {
          if (!CFG.DRIVE_FOLDER_ID) throw new Error('ยังไม่ได้ตั้ง DRIVE_FOLDER_ID');
          return DriveApp.getFolderById(CFG.DRIVE_FOLDER_ID).getName();
        });
        check('ทริกเกอร์อัตโนมัติ', function () {
          const t = ScriptApp.getProjectTriggers();
          if (!t.length) throw new Error('ยังไม่ได้ติดตั้ง — เรียก installTriggers() หนึ่งครั้ง');
          return t.length + ' ทริกเกอร์';
        });

        return { checks: checks, allOk: checks.every(function (c) { return c.ok; }) };
      }
    }
  };
}
