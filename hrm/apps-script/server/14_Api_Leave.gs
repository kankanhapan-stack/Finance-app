/**
 * HRM :: 14_Api_Leave.gs
 * โมดูล 06 Leave — ระบบลาและการอนุมัติ
 *
 * ตรรกะสำคัญ (ตรวจสิทธิ, นับวัน, เดินสายอนุมัติ) อยู่ในฝั่งฐานข้อมูลเป็น RPC
 * เพื่อให้ทำงานใน transaction เดียวและใช้ซ้ำได้เมื่อเปิดช่องทางออนไลน์อื่น
 */

function routesLeave() {
  return {

    /** ยอดวันลาคงเหลือ */
    'leave.balance': {
      perm: null,
      fn: function (p, ctx) {
        const employeeId = p.employeeId || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('leave.read');
          Auth.requireEmployee(ctx, employeeId);
        }
        return DB.select('v_leave_balance', {
          filter: { employee_id: employeeId }, order: 'leave_type_code'
        });
      }
    },

    /** รายการใบลา */
    'leave.list': {
      perm: null,
      fn: function (p, ctx) {
        const filter = {};

        if (p.mine || !Auth.can(ctx, 'leave.read')) {
          if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
          filter.employee_id = ctx.employeeId;
        } else {
          filter.org_id = ctx.orgId;
          if (p.employeeId) {
            Auth.requireEmployee(ctx, p.employeeId);
            filter.employee_id = p.employeeId;
          } else if (p.pendingForMe && ctx.employeeId) {
            // เฉพาะใบลาของผู้ใต้บังคับบัญชา
            const subs = DB.select('v_employee_current', {
              select: 'employee_id', filter: { supervisor_id: ctx.employeeId }
            }).map(function (r) { return r.employee_id; });
            if (!subs.length) return { rows: [], total: 0 };
            filter.employee_id = subs;
            filter.status = 'PENDING';
          } else if (!Auth.can(ctx, 'employee.read_all') && ctx.facilityIds.length) {
            filter.facility_id = ctx.facilityIds;
          }
        }

        if (p.status) filter.status = p.status;
        if (p.leaveTypeId) filter.leave_type_id = p.leaveTypeId;
        if (p.periodYear) filter.period_year = p.periodYear;
        if (p.from && p.to) {
          filter.start_date = { op: 'lte', value: p.to };
          filter.end_date   = { op: 'gte', value: p.from };
        }

        return DB.selectPaged('leave_requests', {
          select: '*,leave_types(code,name_th,color),' +
                  'employees(emp_code,title_th,first_name_th,last_name_th)',
          filter: filter,
          order: p.order || 'start_date.desc',
          limit: p.limit || 50,
          offset: p.offset || 0
        });
      }
    },

    'leave.get': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบลา']);
        const lr = DB.first('leave_requests', {
          select: '*,leave_types(*),employees(emp_code,title_th,first_name_th,last_name_th,phone)',
          filter: { id: p.id }
        });
        if (!lr) throw new Error('ไม่พบใบลา');
        if (lr.employee_id !== ctx.employeeId) {
          Auth.require('leave.read');
          Auth.requireEmployee(ctx, lr.employee_id);
        }

        // ประวัติการพิจารณา
        if (lr.approval_request_id) {
          lr.approvalHistory = DB.select('approval_actions', {
            select: '*,app_users(display_name,email)',
            filter: { request_id: lr.approval_request_id }, order: 'acted_at'
          });
          lr.approvalRequest = DB.first('approval_requests', {
            select: '*,approval_flows(code,name_th)', filter: { id: lr.approval_request_id }
          });
        }
        return lr;
      }
    },

    /** บันทึกร่างใบลา (ยังไม่ส่งอนุมัติ) */
    'leave.save': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['leave_type_id', 'start_date', 'end_date', 'reason'],
                              ['ประเภทการลา', 'วันที่เริ่มลา', 'วันที่สิ้นสุด', 'เหตุผล']);

        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('leave.write');
          Auth.requireEmployee(ctx, employeeId);
        }
        if (p.end_date < p.start_date) throw new Error('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มลา');
        if (p.half_day && p.start_date !== p.end_date) {
          throw new Error('การลาครึ่งวันต้องเป็นวันเดียวกัน');
        }

        const emp = DB.first('v_employee_current', {
          select: 'facility_id', filter: { employee_id: employeeId }
        });

        const data = {
          org_id: ctx.orgId,
          facility_id: emp ? emp.facility_id : null,
          employee_id: employeeId,
          leave_type_id: p.leave_type_id,
          period_year: Util.fiscalYear(p.start_date),
          start_date: p.start_date,
          end_date: p.end_date,
          half_day: p.half_day || null,
          reason: p.reason,
          contact_address: p.contact_address || null,
          contact_phone: p.contact_phone || null,
          delegate_to: p.delegate_to || null,
          attachment_url: p.attachment_url || null
        };

        if (p.id) {
          const existing = DB.first('leave_requests', { select: 'status,employee_id', filter: { id: p.id } });
          if (!existing) throw new Error('ไม่พบใบลา');
          if (['DRAFT', 'RETURNED'].indexOf(existing.status) < 0) {
            throw new Error('ใบลาสถานะ ' + existing.status + ' แก้ไขไม่ได้');
          }
          return DB.updateById('leave_requests', p.id, data);
        }

        data.status = 'DRAFT';
        const saved = DB.insert('leave_requests', data);

        // บันทึกแล้วส่งอนุมัติทันทีถ้าสั่งมา
        if (p.submit) return submitLeave(saved.id, ctx);
        return saved;
      }
    },

    /** ส่งใบลาเข้าสายอนุมัติ */
    'leave.submit': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบลา']);
        const lr = DB.first('leave_requests', { select: 'employee_id', filter: { id: p.id } });
        if (!lr) throw new Error('ไม่พบใบลา');
        if (lr.employee_id !== ctx.employeeId) {
          Auth.require('leave.write');
          Auth.requireEmployee(ctx, lr.employee_id);
        }
        return submitLeave(p.id, ctx);
      }
    },

    /** อนุมัติ / ไม่อนุมัติ / ส่งกลับแก้ไข */
    'leave.act': {
      perm: 'leave.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'action'], ['ใบลา', 'การดำเนินการ']);
        if (['APPROVE', 'REJECT', 'RETURN'].indexOf(p.action) < 0) {
          throw new Error('การดำเนินการไม่ถูกต้อง');
        }

        const lr = DB.first('leave_requests', {
          select: 'id,employee_id,request_no,start_date,end_date,total_days,org_id',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!lr) throw new Error('ไม่พบใบลา');
        Auth.requireEmployee(ctx, lr.employee_id);

        if (p.action === 'REJECT' && !p.comment) {
          throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
        }

        const result = DB.rpc('fn_act_leave_request', {
          p_request_id: p.id,
          p_action: p.action,
          p_actor_user_id: ctx.userId,
          p_comment: p.comment || null
        });

        const labels = { APPROVED: 'อนุมัติแล้ว', REJECTED: 'ไม่อนุมัติ',
                         RETURNED: 'ส่งกลับให้แก้ไข', PENDING: 'ผ่านการพิจารณาขั้นหนึ่ง' };
        Util.notify(ctx, {
          employeeId: lr.employee_id,
          userId: Util.userIdOfEmployee(lr.employee_id),
          title: 'ผลการพิจารณาใบลา ' + (lr.request_no || ''),
          body: (labels[result.status] || result.status) +
                ' — ลา ' + lr.total_days + ' วัน (' + Util.thaiDate(lr.start_date, true) +
                ' ถึง ' + Util.thaiDate(lr.end_date, true) + ')' +
                (p.comment ? ' หมายเหตุ: ' + p.comment : ''),
          entityType: 'leave_requests', entityId: p.id
        });

        return result;
      }
    },

    /** ยกเลิกใบลา (เจ้าของใบลาหรือ HR) */
    'leave.cancel': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบลา']);
        const lr = DB.first('leave_requests', {
          select: 'id,employee_id,status,start_date', filter: { id: p.id }
        });
        if (!lr) throw new Error('ไม่พบใบลา');
        if (lr.employee_id !== ctx.employeeId) Auth.require('leave.manage');

        if (lr.status === 'DRAFT') {
          return DB.updateById('leave_requests', p.id, {
            status: 'CANCELLED', cancel_reason: p.reason || 'ยกเลิกโดยผู้ขอ',
            cancelled_at: new Date().toISOString()
          });
        }
        if (lr.status === 'PENDING') {
          return DB.rpc('fn_act_leave_request', {
            p_request_id: p.id, p_action: 'CANCEL',
            p_actor_user_id: ctx.userId, p_comment: p.reason || 'ยกเลิกโดยผู้ขอ'
          });
        }
        if (lr.status === 'APPROVED') {
          // ยกเลิกใบลาที่อนุมัติแล้วต้องเป็น HR และต้องยังไม่ถึงวันลา
          Auth.require('leave.manage');
          if (lr.start_date <= Util.isoDate()) {
            throw new Error('ยกเลิกใบลาที่เริ่มไปแล้วไม่ได้ — ให้บันทึกเป็นการลาย้อนหลังแทน');
          }
          const out = DB.updateById('leave_requests', p.id, {
            status: 'CANCELLED', cancel_reason: p.reason || null,
            cancelled_at: new Date().toISOString()
          });
          DB.rpc('fn_recalc_attendance', { p_employee_id: lr.employee_id, p_date: lr.start_date });
          return out;
        }
        throw new Error('ใบลาสถานะ ' + lr.status + ' ยกเลิกไม่ได้');
      }
    },

    /** ปฏิทินการลาของหน่วยงาน (ดูว่าใครลาช่วงไหน) */
    'leave.calendar': {
      perm: 'leave.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['from', 'to'], ['วันที่เริ่ม', 'วันที่สิ้นสุด']);
        const filter = {
          org_id: ctx.orgId,
          status: ['APPROVED', 'PENDING'],
          start_date: { op: 'lte', value: p.to },
          end_date: { op: 'gte', value: p.from }
        };
        if (p.facilityId) filter.facility_id = p.facilityId;

        return DB.select('leave_requests', {
          select: 'id,employee_id,start_date,end_date,half_day,total_days,status,' +
                  'leave_types(code,name_th,color),' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'start_date', limit: 500
        });
      }
    },

    // ------------------------------------------------------ ตั้งค่า (HR)
    'leave.typeList': {
      perm: 'leave.read',
      fn: function (p, ctx) {
        return DB.select('leave_types', { filter: { org_id: ctx.orgId }, order: 'sort_order' });
      }
    },

    'leave.typeSave': {
      perm: 'leave.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัส', 'ชื่อประเภทการลา']);
        const data = Util.pick(p, ['code','name_th','name_en','category','unit','is_paid',
                                   'default_quota','max_per_request','max_consecutive',
                                   'allow_carry_over','carry_over_max','min_service_months',
                                   'require_attachment','attachment_after_days',
                                   'advance_notice_days','allow_backdate','deduct_salary_rate',
                                   'color','sort_order','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('leave_types', p.id, data) : DB.insert('leave_types', data);
      }
    },

    'leave.entitlementList': {
      perm: 'leave.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId, period_year: p.periodYear || Util.fiscalYear() };
        if (p.employeeId) filter.employee_id = p.employeeId;
        return DB.select('leave_entitlements', {
          select: '*,leave_types(code,name_th),employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'employee_id', limit: p.limit || 500
        });
      }
    },

    'leave.entitlementAdjust': {
      perm: 'leave.manage',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'leave_type_id', 'period_year'],
                              ['บุคลากร', 'ประเภทการลา', 'ปี']);
        return DB.insert('leave_entitlements', {
          org_id: ctx.orgId,
          employee_id: p.employee_id,
          leave_type_id: p.leave_type_id,
          period_year: p.period_year,
          entitled_days: p.entitled_days || 0,
          carried_over_days: p.carried_over_days || 0,
          adjusted_days: p.adjusted_days || 0,
          note: p.note || null
        }, { upsertOn: 'employee_id,leave_type_id,period_year' });
      }
    },

    /** ตั้งสิทธิวันลาประจำปีให้ทั้งองค์กร (ยกยอดลาพักผ่อนอัตโนมัติ) */
    'leave.generateEntitlements': {
      perm: 'leave.manage',
      fn: function (p, ctx) {
        const year = p.periodYear || Util.fiscalYear();
        const count = DB.rpc('fn_generate_leave_entitlements', {
          p_org_id: ctx.orgId, p_period_year: year
        });
        return { periodYear: year, rows: count };
      }
    }
  };
}

/** ส่งใบลาเข้าสายอนุมัติ + แจ้งผู้อนุมัติขั้นแรก */
function submitLeave(leaveId, ctx) {
  const result = DB.rpc('fn_submit_leave_request', { p_request_id: leaveId });

  const emp = DB.first('v_employee_current', {
    select: 'supervisor_id,full_name_th,department_name',
    filter: { employee_id: result.employee_id }
  });
  const lt = DB.first('leave_types', { select: 'name_th', filter: { id: result.leave_type_id } });

  if (emp && emp.supervisor_id) {
    Util.notify(ctx, {
      employeeId: emp.supervisor_id,
      userId: Util.userIdOfEmployee(emp.supervisor_id),
      channel: 'EMAIL',
      title: 'มีใบลารออนุมัติ: ' + emp.full_name_th,
      body: emp.full_name_th + ' ขอ' + (lt ? lt.name_th : 'ลา') + ' ' +
            result.total_days + ' วัน ตั้งแต่ ' + Util.thaiDate(result.start_date) +
            ' ถึง ' + Util.thaiDate(result.end_date) + '\n' +
            'เหตุผล: ' + (result.reason || '-'),
      linkUrl: CFG.APP_URL + '?page=app#leave/' + leaveId,
      entityType: 'leave_requests', entityId: leaveId
    });
  }
  return result;
}
