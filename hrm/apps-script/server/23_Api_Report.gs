/**
 * HRM :: 23_Api_Report.gs
 * โมดูล 15 Reports + Audit Log
 * รายงานมาตรฐานพร้อมส่งออก CSV/Google Sheets
 */

/** นิยามรายงานมาตรฐาน — เพิ่มรายงานใหม่ได้โดยเติมรายการในนี้ */
const REPORT_DEFS = {

  EMPLOYEE_ROSTER: {
    name: 'ทะเบียนบุคลากร',
    perm: 'employee.read',
    columns: [
      { key: 'emp_code',        label: 'รหัส' },
      { key: 'full_name_th',    label: 'ชื่อ-สกุล' },
      { key: 'position_name',   label: 'ตำแหน่ง' },
      { key: 'grade_name',      label: 'ระดับ' },
      { key: 'department_name', label: 'สังกัด' },
      { key: 'facility_name',   label: 'สถานบริการ' },
      { key: 'employment_type', label: 'ประเภทการจ้าง' },
      { key: 'hire_date',       label: 'วันเริ่มงาน', type: 'date' },
      { key: 'service_length_text', label: 'อายุงาน' },
      { key: 'age_years',       label: 'อายุ (ปี)' },
      { key: 'base_salary',     label: 'เงินเดือน', type: 'money' },
      { key: 'employment_status', label: 'สถานะ' }
    ],
    fetch: function (p, ctx) {
      const filter = Auth.scopeFilter(ctx, { module: 'employee' });
      if (p.facilityId) filter.facility_id = p.facilityId;
      if (p.status) filter.employment_status = p.status;
      else filter.employment_status = ['ACTIVE', 'PROBATION', 'ON_LEAVE'];
      return DB.select('v_employee_current', { filter: filter, order: 'emp_code', limit: 5000 });
    }
  },

  HEADCOUNT: {
    name: 'อัตรากำลัง (กรอบ/คนจริง/อัตราว่าง)',
    perm: 'report.read',
    columns: [
      { key: 'facility_name',   label: 'สถานบริการ' },
      { key: 'department_name', label: 'หน่วยงาน' },
      { key: 'position_name',   label: 'ตำแหน่ง' },
      { key: 'job_family',      label: 'สายงาน' },
      { key: 'planned_count',   label: 'กรอบ' },
      { key: 'actual_count',    label: 'คนจริง' },
      { key: 'vacant_count',    label: 'ว่าง' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.facilityId) filter.facility_id = p.facilityId;
      if (p.fiscalYear) filter.fiscal_year = p.fiscalYear;
      return DB.select('v_headcount_by_unit', {
        filter: filter, order: 'facility_name,department_name,position_name', limit: 5000
      });
    }
  },

  ATTENDANCE_MONTHLY: {
    name: 'สรุปการมาปฏิบัติงานรายเดือน',
    perm: 'time.read',
    columns: [
      { key: 'emp_code',        label: 'รหัส' },
      { key: 'full_name_th',    label: 'ชื่อ-สกุล' },
      { key: 'department_name', label: 'สังกัด' },
      { key: 'month_start',     label: 'เดือน', type: 'month' },
      { key: 'present_days',    label: 'มาปฏิบัติงาน' },
      { key: 'late_days',       label: 'สาย (วัน)' },
      { key: 'late_minutes',    label: 'สาย (นาที)' },
      { key: 'absent_days',     label: 'ขาด' },
      { key: 'leave_days',      label: 'ลา' },
      { key: 'ot_minutes',      label: 'ล่วงเวลา (นาที)' },
      { key: 'work_hours',      label: 'ชั่วโมงงาน' }
    ],
    fetch: function (p, ctx) {
      const filter = Auth.scopeFilter(ctx, { module: 'time' });
      if (p.monthStart) filter.month_start = p.monthStart;
      if (p.facilityId) filter.facility_id = p.facilityId;
      return DB.select('v_attendance_monthly', { filter: filter, order: 'emp_code', limit: 5000 });
    }
  },

  LEAVE_SUMMARY: {
    name: 'สรุปการลารายบุคคล',
    perm: 'leave.read',
    columns: [
      { key: 'emp_code',         label: 'รหัส' },
      { key: 'full_name_th',     label: 'ชื่อ-สกุล' },
      { key: 'department_name',  label: 'สังกัด' },
      { key: 'leave_type_name',  label: 'ประเภทการลา' },
      { key: 'period_year',      label: 'ปีงบประมาณ' },
      { key: 'approved_count',   label: 'ครั้ง' },
      { key: 'approved_days',    label: 'จำนวนวัน' },
      { key: 'pending_count',    label: 'รออนุมัติ' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId, period_year: p.periodYear || Util.fiscalYear() };
      if (p.employeeId) filter.employee_id = p.employeeId;
      return DB.select('v_leave_summary', { filter: filter, order: 'emp_code', limit: 5000 });
    }
  },

  LEAVE_BALANCE: {
    name: 'ยอดวันลาคงเหลือ',
    perm: 'leave.read',
    columns: [
      { key: 'emp_code',        label: 'รหัส' },
      { key: 'full_name_th',    label: 'ชื่อ-สกุล' },
      { key: 'leave_type_name', label: 'ประเภทการลา' },
      { key: 'total_days',      label: 'สิทธิรวม' },
      { key: 'used_days',       label: 'ใช้ไป' },
      { key: 'pending_days',    label: 'รออนุมัติ' },
      { key: 'remaining_days',  label: 'คงเหลือ' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.leaveTypeCode) filter.leave_type_code = p.leaveTypeCode;
      return DB.select('v_leave_balance', { filter: filter, order: 'emp_code', limit: 5000 });
    }
  },

  PAYROLL_COST: {
    name: 'ค่าใช้จ่ายบุคลากรรายงวด',
    perm: 'payroll.read',
    columns: [
      { key: 'period_code',    label: 'งวด' },
      { key: 'headcount',      label: 'จำนวนคน' },
      { key: 'total_earning',  label: 'เงินได้รวม', type: 'money' },
      { key: 'total_deduction',label: 'เงินหักรวม', type: 'money' },
      { key: 'total_net',      label: 'จ่ายสุทธิ', type: 'money' },
      { key: 'total_employer_cost', label: 'ภาระนายจ้าง', type: 'money' },
      { key: 'total_cost',     label: 'ต้นทุนรวม', type: 'money' },
      { key: 'status',         label: 'สถานะ' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.periodYear) filter.period_year = p.periodYear;
      return DB.select('v_payroll_cost', {
        filter: filter, order: 'period_year.desc,period_month.desc', limit: 500
      });
    }
  },

  TRAINING_SUMMARY: {
    name: 'สรุปการพัฒนาบุคลากร',
    perm: 'training.read',
    columns: [
      { key: 'emp_code',        label: 'รหัส' },
      { key: 'full_name_th',    label: 'ชื่อ-สกุล' },
      { key: 'department_name', label: 'สังกัด' },
      { key: 'fiscal_year',     label: 'ปีงบประมาณ' },
      { key: 'course_count',    label: 'จำนวนหลักสูตร' },
      { key: 'total_hours',     label: 'ชั่วโมงรวม' },
      { key: 'total_credits',   label: 'หน่วยคะแนน' },
      { key: 'total_cost',      label: 'ค่าใช้จ่าย', type: 'money' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.fiscalYear) filter.fiscal_year = p.fiscalYear;
      return DB.select('v_training_summary', { filter: filter, order: 'total_hours.desc', limit: 5000 });
    }
  },

  TURNOVER: {
    name: 'อัตราการเข้า-ออกรายปี',
    perm: 'report.read',
    columns: [
      { key: 'fiscal_year',      label: 'ปีงบประมาณ' },
      { key: 'headcount',        label: 'กำลังคน' },
      { key: 'hire_count',       label: 'เข้าใหม่' },
      { key: 'separation_count', label: 'พ้นสภาพ' },
      { key: 'turnover_percent', label: 'อัตราออก (%)' }
    ],
    fetch: function (p, ctx) {
      return DB.select('v_turnover_by_year', {
        filter: { org_id: ctx.orgId }, order: 'fiscal_year.desc', limit: 20
      });
    }
  },

  RETIREMENT: {
    name: 'ผู้ครบเกษียณอายุราชการ',
    perm: 'report.read',
    columns: [
      { key: 'emp_code',        label: 'รหัส' },
      { key: 'full_name_th',    label: 'ชื่อ-สกุล' },
      { key: 'position_name',   label: 'ตำแหน่ง' },
      { key: 'department_name', label: 'สังกัด' },
      { key: 'facility_name',   label: 'สถานบริการ' },
      { key: 'birth_date',      label: 'วันเกิด', type: 'date' },
      { key: 'retirement_date', label: 'วันเกษียณ', type: 'date' },
      { key: 'days_remaining',  label: 'เหลืออีก (วัน)' },
      { key: 'service_length_text', label: 'อายุราชการ' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.facilityId) filter.facility_id = p.facilityId;
      return DB.select('v_upcoming_retirements', { filter: filter, limit: 1000 });
    }
  },

  COMPLIANCE: {
    name: 'รายการที่ต้องติดตาม (ใบอนุญาต/ทดลองงาน/อบรม)',
    perm: 'report.read',
    columns: [
      { key: 'emp_code',       label: 'รหัส' },
      { key: 'full_name_th',   label: 'ชื่อ-สกุล' },
      { key: 'alert_type',     label: 'ประเภท' },
      { key: 'detail',         label: 'รายละเอียด' },
      { key: 'due_date',       label: 'ครบกำหนด', type: 'date' },
      { key: 'days_remaining', label: 'เหลืออีก (วัน)' },
      { key: 'severity',       label: 'ความเร่งด่วน' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.severity) filter.severity = p.severity;
      if (p.alertType) filter.alert_type = p.alertType;
      return DB.select('v_compliance_alerts', { filter: filter, order: 'due_date', limit: 2000 });
    }
  },

  DEMOGRAPHICS: {
    name: 'โครงสร้างกำลังคน',
    perm: 'report.read',
    columns: [
      { key: 'facility_name',   label: 'สถานบริการ' },
      { key: 'department_name', label: 'หน่วยงาน' },
      { key: 'employment_type', label: 'ประเภทการจ้าง' },
      { key: 'gender',          label: 'เพศ' },
      { key: 'age_band',        label: 'ช่วงอายุ' },
      { key: 'service_band',    label: 'ช่วงอายุงาน' },
      { key: 'headcount',       label: 'จำนวน' },
      { key: 'avg_salary',      label: 'เงินเดือนเฉลี่ย', type: 'money' }
    ],
    fetch: function (p, ctx) {
      const filter = { org_id: ctx.orgId };
      if (p.facilityId) filter.facility_id = p.facilityId;
      return DB.select('v_workforce_demographics', { filter: filter, limit: 5000 });
    }
  }
};

function routesReport() {
  return {

    'report.catalog': {
      perm: 'report.read',
      fn: function (p, ctx) {
        return Object.keys(REPORT_DEFS)
          .filter(function (k) { return Auth.can(ctx, REPORT_DEFS[k].perm); })
          .map(function (k) {
            return { code: k, name: REPORT_DEFS[k].name,
                     columns: REPORT_DEFS[k].columns };
          });
      }
    },

    'report.run': {
      perm: 'report.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code'], ['รหัสรายงาน']);
        const def = REPORT_DEFS[p.code];
        if (!def) throw new Error('ไม่รู้จักรายงาน: ' + p.code);
        if (!Auth.can(ctx, def.perm)) {
          throw new Error('ไม่มีสิทธิดูรายงานนี้ (ต้องการ: ' + def.perm + ')');
        }

        const rows = def.fetch(p.params || {}, ctx);
        Auth.logAccess(ctx, {
          module: 'report', action: 'VIEW', entityType: 'report',
          purpose: def.name
        });

        return { code: p.code, name: def.name, columns: def.columns,
                 rows: rows, total: rows.length, generatedAt: new Date().toISOString() };
      }
    },

    /** ส่งออกเป็น CSV (client จะดาวน์โหลดเอง) */
    'report.exportCsv': {
      perm: 'report.export',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code'], ['รหัสรายงาน']);
        const def = REPORT_DEFS[p.code];
        if (!def) throw new Error('ไม่รู้จักรายงาน: ' + p.code);
        if (!Auth.can(ctx, def.perm)) throw new Error('ไม่มีสิทธิส่งออกรายงานนี้');

        const rows = def.fetch(p.params || {}, ctx);

        function esc(v) {
          if (v === null || v === undefined) return '';
          const s = String(v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }
        const lines = [def.columns.map(function (c) { return esc(c.label); }).join(',')];
        rows.forEach(function (r) {
          lines.push(def.columns.map(function (c) { return esc(r[c.key]); }).join(','));
        });

        Auth.logAccess(ctx, {
          module: 'report', action: 'EXPORT', entityType: 'report', purpose: def.name
        });

        return {
          filename: p.code.toLowerCase() + '_' + Util.isoDate() + '.csv',
          // BOM เพื่อให้ Excel อ่านภาษาไทยถูกต้อง
          csv: '﻿' + lines.join('\r\n'),
          rows: rows.length
        };
      }
    },

    /** ส่งออกเป็น Google Sheets (คืนลิงก์) */
    'report.exportSheet': {
      perm: 'report.export',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code'], ['รหัสรายงาน']);
        const def = REPORT_DEFS[p.code];
        if (!def) throw new Error('ไม่รู้จักรายงาน: ' + p.code);
        if (!Auth.can(ctx, def.perm)) throw new Error('ไม่มีสิทธิส่งออกรายงานนี้');

        const rows = def.fetch(p.params || {}, ctx);
        const ss = SpreadsheetApp.create(def.name + ' ' + Util.thaiDate(Util.isoDate()));
        const sheet = ss.getActiveSheet();

        const header = def.columns.map(function (c) { return c.label; });
        const data = rows.map(function (r) {
          return def.columns.map(function (c) {
            const v = r[c.key];
            return v === null || v === undefined ? '' : v;
          });
        });

        sheet.getRange(1, 1, 1, header.length).setValues([header])
             .setFontWeight('bold').setBackground('#1f6b47').setFontColor('#ffffff');
        if (data.length) sheet.getRange(2, 1, data.length, header.length).setValues(data);
        sheet.setFrozenRows(1);
        sheet.autoResizeColumns(1, header.length);

        if (CFG.DRIVE_FOLDER_ID) {
          try {
            DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(CFG.DRIVE_FOLDER_ID));
          } catch (e) { console.warn('ย้ายไฟล์ไม่สำเร็จ: ' + e.message); }
        }

        Auth.logAccess(ctx, {
          module: 'report', action: 'EXPORT', entityType: 'report', purpose: def.name
        });

        return { url: ss.getUrl(), rows: rows.length, name: def.name };
      }
    },

    // ----------------------------------------------------------- Audit
    'audit.list': {
      perm: 'audit.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.tableName) filter.table_name = p.tableName;
        if (p.recordId)  filter.record_id = p.recordId;
        if (p.action)    filter.action = p.action;
        if (p.actorUserId) filter.actor_user_id = p.actorUserId;
        if (p.from && p.to) {
          filter.occurred_at = [{ op: 'gte', value: p.from },
                                { op: 'lte', value: p.to + 'T23:59:59Z' }];
        }
        return DB.selectPaged('audit_logs', {
          select: 'id,table_name,record_id,action,changed_fields,actor_email,occurred_at,context',
          filter: filter, order: 'occurred_at.desc',
          limit: p.limit || 100, offset: p.offset || 0
        });
      }
    },

    'audit.detail': {
      perm: 'audit.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['รายการ']);
        return DB.first('audit_logs', { filter: { id: p.id, org_id: ctx.orgId } });
      }
    },

    'audit.recordHistory': {
      perm: 'audit.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['table', 'recordId'], ['ตาราง', 'ระเบียน']);
        return DB.rpc('fn_record_history', {
          p_table: p.table, p_record_id: p.recordId, p_limit: p.limit || 100
        });
      }
    },

    /** บันทึกการเข้าถึงข้อมูลส่วนบุคคล (PDPA) */
    'audit.accessLog': {
      perm: 'audit.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.subjectEmployeeId) filter.subject_employee_id = p.subjectEmployeeId;
        if (p.actorUserId) filter.actor_user_id = p.actorUserId;
        if (p.module) filter.module = p.module;
        if (p.from && p.to) {
          filter.occurred_at = [{ op: 'gte', value: p.from },
                                { op: 'lte', value: p.to + 'T23:59:59Z' }];
        }
        return DB.selectPaged('data_access_logs', {
          filter: filter, order: 'occurred_at.desc',
          limit: p.limit || 100, offset: p.offset || 0
        });
      }
    },

    /** ใครเปิดดูข้อมูลของฉันบ้าง (สิทธิของเจ้าของข้อมูลตาม PDPA) */
    'audit.myAccessLog': {
      perm: null,
      fn: function (p, ctx) {
        if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        return DB.select('data_access_logs', {
          select: 'actor_email,module,action,purpose,occurred_at',
          filter: { subject_employee_id: ctx.employeeId },
          order: 'occurred_at.desc', limit: p.limit || 100
        });
      }
    },

    'audit.loginLog': {
      perm: 'audit.read',
      fn: function (p, ctx) {
        const filter = {};
        if (p.email) filter.email = p.email;
        if (p.result) filter.result = p.result;
        return DB.select('login_logs', {
          filter: filter, order: 'occurred_at.desc', limit: p.limit || 200
        });
      }
    }
  };
}
