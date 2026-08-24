/**
 * HRM :: 10_Api_Core.gs
 * โมดูล 01 Dashboard + โมดูล 02 Organization + bootstrap ของหน้าเว็บ
 */

function routesCore() {
  return {

    // ---------------------------------------------------------- bootstrap
    /** ข้อมูลตั้งต้นที่หน้าเว็บต้องใช้ทันทีหลังเปิด */
    'app.bootstrap': {
      perm: null,
      fn: function (p, ctx) {
        Auth.recordLogin(ctx);

        const org = DB.first('organizations', {
          select: 'id,code,name_th,logo_url,settings',
          filter: { id: ctx.orgId }
        });

        const facilities = DB.select('facilities', {
          select: 'id,code,name_th,facility_type',
          filter: { org_id: ctx.orgId, is_active: true },
          order: 'name_th'
        });

        return {
          user: {
            id: ctx.userId,
            email: ctx.email,
            displayName: ctx.displayName,
            employeeId: ctx.employeeId,
            employee: ctx.employee,
            roles: ctx.roles,
            isSuperadmin: ctx.isSuperadmin
          },
          org: org,
          facilities: facilities,
          modules: Auth.visibleModules(ctx),
          perms: Object.keys(ctx.perms),
          fiscalYear: Util.fiscalYear(),
          today: Util.isoDate(),
          appUrl: CFG.APP_URL
        };
      }
    },

    'app.refreshPermissions': {
      perm: null,
      fn: function (p, ctx) {
        Auth.clearCache();
        return { refreshed: true };
      }
    },

    // ---------------------------------------------------------- 01 Dashboard
    'dashboard.summary': {
      perm: 'dashboard.read',
      fn: function (p, ctx) {
        return DB.rpc('fn_dashboard_summary', {
          p_org_id: ctx.orgId,
          p_facility_id: p.facilityId || null
        });
      }
    },

    'dashboard.headcountTrend': {
      perm: 'dashboard.read',
      fn: function (p, ctx) {
        return DB.rpc('fn_headcount_trend', {
          p_org_id: ctx.orgId, p_months: p.months || 12
        });
      }
    },

    'dashboard.demographics': {
      perm: 'dashboard.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.facilityId) filter.facility_id = p.facilityId;
        return DB.select('v_workforce_demographics', { filter: filter });
      }
    },

    'dashboard.alerts': {
      perm: 'dashboard.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.severity) filter.severity = p.severity;
        return DB.select('v_compliance_alerts', {
          filter: filter, order: 'due_date', limit: p.limit || 50
        });
      }
    },

    /** งานที่รอฉันดำเนินการ (inbox รวมทุกโมดูล) */
    'dashboard.myTasks': {
      perm: null,
      fn: function (p, ctx) {
        const tasks = [];

        // ใบลาที่รอฉันอนุมัติ
        if (Auth.can(ctx, 'leave.approve') && ctx.employeeId) {
          const subs = DB.select('v_employee_current', {
            select: 'employee_id', filter: { supervisor_id: ctx.employeeId }
          }).map(function (r) { return r.employee_id; });

          if (subs.length) {
            DB.select('leave_requests', {
              select: 'id,request_no,employee_id,start_date,end_date,total_days,reason,submitted_at',
              filter: { status: 'PENDING', employee_id: subs },
              order: 'submitted_at'
            }).forEach(function (r) {
              tasks.push({
                type: 'LEAVE_APPROVAL', module: 'leave', id: r.id,
                title: 'ใบลาเลขที่ ' + (r.request_no || '-'),
                detail: r.total_days + ' วัน (' + r.start_date + ' ถึง ' + r.end_date + ')',
                since: r.submitted_at
              });
            });
          }
        }

        // ใบลาของฉันที่ถูกตีกลับ
        if (ctx.employeeId) {
          DB.select('leave_requests', {
            select: 'id,request_no,status,reject_reason,updated_at',
            filter: { employee_id: ctx.employeeId, status: ['RETURNED', 'REJECTED'] },
            order: 'updated_at.desc', limit: 5
          }).forEach(function (r) {
            tasks.push({
              type: 'LEAVE_RETURNED', module: 'leave', id: r.id,
              title: 'ใบลา ' + (r.request_no || '-') + ' ' +
                     (r.status === 'RETURNED' ? 'ถูกส่งกลับให้แก้ไข' : 'ไม่ได้รับอนุมัติ'),
              detail: r.reject_reason || '', since: r.updated_at
            });
          });
        }

        // ใบประเมินที่ยังไม่ประเมินตนเอง
        if (ctx.employeeId) {
          DB.select('appraisals', {
            select: 'id,cycle_id,status',
            filter: { employee_id: ctx.employeeId, status: 'DRAFT' }
          }).forEach(function (r) {
            tasks.push({
              type: 'SELF_APPRAISAL', module: 'performance', id: r.id,
              title: 'รอประเมินตนเอง', detail: '', since: null
            });
          });
        }

        // คำขอเอกสารที่รอออก
        if (Auth.can(ctx, 'document.write')) {
          DB.select('document_requests', {
            select: 'id,request_no,purpose,created_at',
            filter: { org_id: ctx.orgId, status: 'PENDING' },
            order: 'created_at', limit: 20
          }).forEach(function (r) {
            tasks.push({
              type: 'DOC_REQUEST', module: 'document', id: r.id,
              title: 'คำขอเอกสาร ' + (r.request_no || ''),
              detail: r.purpose, since: r.created_at
            });
          });
        }

        return tasks;
      }
    },

    'notification.list': {
      perm: null,
      fn: function (p, ctx) {
        return DB.select('notifications', {
          select: 'id,title,body,link_url,status,created_at,entity_type,entity_id',
          filter: { user_id: ctx.userId },
          order: 'created_at.desc', limit: p.limit || 30
        });
      }
    },

    'notification.markRead': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['รหัสแจ้งเตือน']);
        return DB.update('notifications', { id: p.id, user_id: ctx.userId }, { status: 'READ' });
      }
    },

    // ------------------------------------------------------- 02 Organization
    'org.tree': {
      perm: 'org.read',
      fn: function (p, ctx) {
        const facilities = DB.select('facilities', {
          select: 'id,code,name_th,facility_type,head_employee_id,is_active',
          filter: { org_id: ctx.orgId }, order: 'code'
        });
        const departments = DB.select('departments', {
          select: 'id,code,name_th,dept_level,parent_id,facility_id,head_employee_id,sort_order,is_active',
          filter: { org_id: ctx.orgId }, order: 'sort_order,code'
        });
        const headcount = DB.select('v_headcount_by_unit', {
          select: 'facility_id,department_id,planned_count,actual_count,vacant_count',
          filter: { org_id: ctx.orgId }
        });

        // รวมยอดต่อหน่วยงาน
        const byDept = {}, byFac = {};
        headcount.forEach(function (h) {
          if (h.department_id) {
            byDept[h.department_id] = byDept[h.department_id] ||
              { planned: 0, actual: 0, vacant: 0 };
            byDept[h.department_id].planned += Number(h.planned_count || 0);
            byDept[h.department_id].actual  += Number(h.actual_count || 0);
            byDept[h.department_id].vacant  += Math.max(0, Number(h.vacant_count || 0));
          }
          if (h.facility_id) {
            byFac[h.facility_id] = byFac[h.facility_id] || { planned: 0, actual: 0, vacant: 0 };
            byFac[h.facility_id].planned += Number(h.planned_count || 0);
            byFac[h.facility_id].actual  += Number(h.actual_count || 0);
            byFac[h.facility_id].vacant  += Math.max(0, Number(h.vacant_count || 0));
          }
        });

        facilities.forEach(function (f) { f.stats = byFac[f.id] || { planned: 0, actual: 0, vacant: 0 }; });
        departments.forEach(function (d) { d.stats = byDept[d.id] || { planned: 0, actual: 0, vacant: 0 }; });

        return { facilities: facilities, departments: departments };
      }
    },

    'org.facilitySave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสสถานบริการ', 'ชื่อสถานบริการ']);
        const data = Util.pick(p, ['code', 'name_th', 'name_en', 'facility_type', 'bed_size',
                                   'address', 'geo', 'contact', 'head_employee_id', 'is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('facilities', p.id, data) : DB.insert('facilities', data);
      }
    },

    'org.departmentSave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสหน่วยงาน', 'ชื่อหน่วยงาน']);
        const data = Util.pick(p, ['code', 'name_th', 'name_en', 'dept_level', 'parent_id',
                                   'facility_id', 'cost_center', 'head_employee_id',
                                   'sort_order', 'is_active']);
        data.org_id = ctx.orgId;
        if (p.id && data.parent_id === p.id) throw new Error('หน่วยงานเป็นหน่วยงานแม่ของตัวเองไม่ได้');
        return p.id ? DB.updateById('departments', p.id, data) : DB.insert('departments', data);
      }
    },

    'org.positionList': {
      perm: 'org.read',
      fn: function (p, ctx) {
        return DB.select('positions', {
          select: '*,job_grades(code,name_th,grade_level)',
          filter: { org_id: ctx.orgId },
          order: 'job_family,code'
        });
      }
    },

    'org.positionSave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสตำแหน่ง', 'ชื่อตำแหน่ง']);
        const data = Util.pick(p, ['code', 'name_th', 'name_en', 'job_family', 'job_grade_id',
                                   'employment_type', 'is_managerial', 'job_description',
                                   'required_competencies', 'is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('positions', p.id, data) : DB.insert('positions', data);
      }
    },

    'org.gradeList': {
      perm: 'org.read',
      fn: function (p, ctx) {
        return DB.select('job_grades', {
          filter: { org_id: ctx.orgId }, order: 'grade_level'
        });
      }
    },

    'org.gradeSave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสระดับ', 'ชื่อระดับ']);
        const data = Util.pick(p, ['code', 'name_th', 'grade_level', 'min_salary',
                                   'max_salary', 'is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('job_grades', p.id, data) : DB.insert('job_grades', data);
      }
    },

    /** กรอบอัตรากำลัง */
    'org.slotList': {
      perm: 'org.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.fiscalYear) filter.fiscal_year = p.fiscalYear;
        if (p.facilityId) filter.facility_id = p.facilityId;
        return DB.select('v_headcount_by_unit', { filter: filter, order: 'facility_name,position_name' });
      }
    },

    'org.slotSave': {
      perm: 'org.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['position_id', 'fiscal_year', 'planned_count'],
                              ['ตำแหน่ง', 'ปีงบประมาณ', 'จำนวนกรอบ']);
        const data = Util.pick(p, ['facility_id', 'department_id', 'position_id',
                                   'fiscal_year', 'planned_count', 'note']);
        data.org_id = ctx.orgId;
        return DB.insert('position_slots', data,
          { upsertOn: 'org_id,facility_id,department_id,position_id,fiscal_year' });
      }
    }
  };
}
