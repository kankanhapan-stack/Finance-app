/**
 * HRM :: 22_Api_Offboarding.gs
 * โมดูล 14 Offboarding — ลาออก / เกษียณ / พ้นสภาพ / เคลียร์ของ / สัมภาษณ์ก่อนลาออก
 */

/** รายการเคลียร์มาตรฐานก่อนพ้นสภาพ */
const CLEARANCE_DEFAULTS = [
  { category: 'ASSET',    item_name: 'คืนบัตรประจำตัวเจ้าหน้าที่' },
  { category: 'ASSET',    item_name: 'คืนเครื่องแบบ/ชุดปฏิบัติงาน' },
  { category: 'IT',       item_name: 'คืนคอมพิวเตอร์/อุปกรณ์ไอที' },
  { category: 'ACCESS',   item_name: 'ยกเลิกสิทธิเข้าใช้ระบบสารสนเทศ' },
  { category: 'KEY',      item_name: 'คืนกุญแจ/คีย์การ์ด' },
  { category: 'DOCUMENT', item_name: 'ส่งมอบงานและเอกสารในความรับผิดชอบ' },
  { category: 'FINANCE',  item_name: 'เคลียร์เงินยืม/เงินกู้สวัสดิการ' },
  { category: 'FINANCE',  item_name: 'ตรวจสอบสิทธิเงินชดเชย/บำเหน็จบำนาญ' }
];

function routesOffboarding() {
  return {

    'offboarding.list': {
      perm: 'offboarding.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.separationType) filter.separation_type = p.separationType;
        if (p.from && p.to) {
          filter.effective_date = [{ op: 'gte', value: p.from }, { op: 'lte', value: p.to }];
        }
        return DB.select('separation_requests', {
          select: '*,employees(emp_code,title_th,first_name_th,last_name_th)',
          filter: filter, order: 'effective_date.desc', limit: p.limit || 100
        });
      }
    },

    'offboarding.get': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['คำขอพ้นสภาพ']);
        const sep = DB.first('separation_requests', {
          select: '*,employees(emp_code,title_th,first_name_th,last_name_th,hire_date)',
          filter: { id: p.id }
        });
        if (!sep) throw new Error('ไม่พบคำขอ');
        if (sep.employee_id !== ctx.employeeId) {
          Auth.require('offboarding.read');
          Auth.requireEmployee(ctx, sep.employee_id);
        }

        sep.clearanceItems = DB.select('clearance_items', {
          filter: { separation_id: p.id }, order: 'sort_order,category'
        });
        sep.exitInterview = DB.first('exit_interviews', { filter: { separation_id: p.id } });
        return sep;
      }
    },

    /** ยื่นคำขอลาออก/แจ้งเกษียณ */
    'offboarding.request': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['separation_type', 'last_working_date', 'effective_date'],
                              ['ประเภทการพ้นสภาพ', 'วันทำงานวันสุดท้าย', 'วันพ้นสภาพ']);
        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('offboarding.write');
          Auth.requireEmployee(ctx, employeeId);
        }
        if (p.effective_date < p.last_working_date) {
          throw new Error('วันพ้นสภาพต้องไม่ก่อนวันทำงานวันสุดท้าย');
        }

        const open = DB.first('separation_requests', {
          select: 'id,status', filter: { employee_id: employeeId,
                                         status: ['DRAFT', 'PENDING', 'APPROVED'] }
        });
        if (open) throw new Error('มีคำขอพ้นสภาพที่ยังไม่ปิดอยู่แล้ว');

        const emp = DB.first('employees', {
          select: 'hire_date', filter: { id: employeeId }
        });
        const noticeDays = emp && emp.hire_date
          ? Util.daysBetween(Util.isoDate(), p.last_working_date) : null;

        const sep = DB.insert('separation_requests', {
          org_id: ctx.orgId,
          employee_id: employeeId,
          request_no: Util.nextDocNo(ctx.orgId, 'SEP', 'ลอ.', Util.fiscalYear().toString(), 4),
          separation_type: p.separation_type,
          requested_date: Util.isoDate(),
          last_working_date: p.last_working_date,
          effective_date: p.effective_date,
          reason_category: p.reason_category || null,
          reason_detail: p.reason_detail || null,
          new_employer: p.new_employer || null,
          notice_days: noticeDays,
          status: 'PENDING'
        });

        // สร้าง checklist เคลียร์ของ
        DB.insert('clearance_items', CLEARANCE_DEFAULTS.map(function (c, i) {
          return { separation_id: sep.id, category: c.category,
                   item_name: c.item_name, sort_order: i };
        }));

        const v = DB.first('v_employee_current', {
          select: 'supervisor_id,full_name_th', filter: { employee_id: employeeId }
        });
        if (v && v.supervisor_id) {
          Util.notify(ctx, {
            employeeId: v.supervisor_id,
            userId: Util.userIdOfEmployee(v.supervisor_id),
            channel: 'EMAIL',
            title: 'มีคำขอพ้นสภาพรอพิจารณา',
            body: v.full_name_th + ' ยื่นคำขอ' +
                  (p.separation_type === 'RETIRE' ? 'เกษียณอายุ' : 'ลาออก') +
                  ' มีผลวันที่ ' + Util.thaiDate(p.effective_date),
            entityType: 'separation_requests', entityId: sep.id
          });
        }
        return sep;
      }
    },

    'offboarding.act': {
      perm: 'offboarding.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'action'], ['คำขอ', 'การดำเนินการ']);
        const sep = DB.first('separation_requests', {
          select: 'id,status,employee_id,effective_date',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!sep) throw new Error('ไม่พบคำขอ');
        if (sep.status !== 'PENDING') throw new Error('คำขอสถานะ ' + sep.status + ' พิจารณาไม่ได้');

        const patch = {
          approved_by: ctx.employeeId || null,
          approved_at: new Date().toISOString()
        };
        if (p.action === 'APPROVE') {
          patch.status = 'APPROVED';
        } else if (p.action === 'REJECT') {
          if (!p.reason) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
          patch.status = 'REJECTED';
          patch.reject_reason = p.reason;
        } else {
          throw new Error('การดำเนินการไม่ถูกต้อง');
        }

        const out = DB.updateById('separation_requests', p.id, patch);
        Util.notify(ctx, {
          employeeId: sep.employee_id,
          userId: Util.userIdOfEmployee(sep.employee_id),
          title: 'ผลการพิจารณาคำขอพ้นสภาพ',
          body: patch.status === 'APPROVED'
            ? 'อนุมัติแล้ว มีผลวันที่ ' + Util.thaiDate(sep.effective_date) +
              ' กรุณาดำเนินการเคลียร์รายการคงค้างให้ครบ'
            : 'ไม่อนุมัติ: ' + p.reason,
          entityType: 'separation_requests', entityId: p.id
        });
        return out;
      }
    },

    'offboarding.clearanceUpdate': {
      perm: 'offboarding.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'status'], ['รายการ', 'สถานะ']);
        const patch = { status: p.status, note: p.note || null };
        if (p.status === 'CLEARED' || p.status === 'WAIVED') {
          patch.cleared_at = new Date().toISOString();
          patch.cleared_by = ctx.userId;
        }
        return DB.updateById('clearance_items', p.id, patch);
      }
    },

    'offboarding.clearanceAdd': {
      perm: 'offboarding.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['separation_id', 'item_name'], ['คำขอพ้นสภาพ', 'รายการ']);
        return DB.insert('clearance_items', {
          separation_id: p.separation_id,
          category: p.category || 'OTHER',
          item_name: p.item_name,
          responsible_dept_id: p.responsible_dept_id || null,
          amount: p.amount || null
        });
      }
    },

    /** ดำเนินการพ้นสภาพจริง (ต้องเคลียร์ครบก่อน — บังคับที่ฝั่ง DB) */
    'offboarding.complete': {
      perm: 'offboarding.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['คำขอพ้นสภาพ']);
        const sep = DB.first('separation_requests', {
          select: 'id,employee_id,status', filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!sep) throw new Error('ไม่พบคำขอ');

        const employee = DB.rpc('fn_complete_separation', { p_separation_id: p.id });
        Auth.clearCache();
        return employee;
      }
    },

    'offboarding.exitInterviewSave': {
      perm: 'offboarding.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['separation_id', 'employee_id'], ['คำขอพ้นสภาพ', 'บุคลากร']);
        const data = Util.pick(p, ['separation_id','employee_id','interview_date','interviewer_id',
                                   'primary_reason','satisfaction_scores','would_recommend',
                                   'would_return','feedback','suggestions','is_confidential']);
        data.interviewer_id = data.interviewer_id || ctx.employeeId || null;
        return DB.insert('exit_interviews', data, { upsertOn: 'separation_id' });
      }
    },

    /** ผู้ที่จะเกษียณใน 12 เดือน */
    'offboarding.upcomingRetirements': {
      perm: 'offboarding.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.facilityId) filter.facility_id = p.facilityId;
        return DB.select('v_upcoming_retirements', { filter: filter, limit: p.limit || 200 });
      }
    },

    /** สรุปเหตุผลการลาออก (ใช้วิเคราะห์ turnover) */
    'offboarding.exitAnalysis': {
      perm: 'offboarding.read',
      fn: function (p, ctx) {
        const fy = p.fiscalYear || Util.fiscalYear();
        const range = Util.fiscalRange(fy);
        const seps = DB.select('separation_requests', {
          select: 'separation_type,reason_category,effective_date,employee_id',
          filter: {
            org_id: ctx.orgId, status: 'COMPLETED',
            effective_date: [{ op: 'gte', value: range.start }, { op: 'lte', value: range.end }]
          }, limit: 1000
        });

        const byType = {}, byReason = {};
        seps.forEach(function (s) {
          byType[s.separation_type] = (byType[s.separation_type] || 0) + 1;
          const r = s.reason_category || 'ไม่ระบุ';
          byReason[r] = (byReason[r] || 0) + 1;
        });

        return {
          fiscalYear: fy, total: seps.length,
          byType: byType, byReason: byReason,
          turnover: DB.select('v_turnover_by_year', {
            filter: { org_id: ctx.orgId }, order: 'fiscal_year.desc', limit: 5
          })
        };
      }
    }
  };
}
