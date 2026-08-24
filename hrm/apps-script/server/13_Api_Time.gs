/**
 * HRM :: 13_Api_Time.gs
 * โมดูล 05 Time Attendance — ลงเวลา / ตารางเวร / ขาด-ลา-มาสาย / ล่วงเวลา
 */

function routesTime() {
  return {

    /** ลงเวลาเข้า-ออก (ตรวจพิกัดกับที่ตั้งสถานบริการ) */
    'time.punch': {
      perm: null,
      fn: function (p, ctx) {
        if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        Util.requireFields(p, ['direction'], ['ประเภทการลงเวลา']);

        const emp = ctx.employee || DB.first('v_employee_current', {
          select: 'facility_id', filter: { employee_id: ctx.employeeId }
        });

        const now = new Date();
        const record = {
          org_id: ctx.orgId,
          employee_id: ctx.employeeId,
          facility_id: emp ? emp.facility_id : null,
          log_time: now.toISOString(),
          direction: p.direction,
          method: p.method || 'WEB',
          device_id: p.device_id || null,
          gps_lat: p.lat || null,
          gps_lng: p.lng || null,
          gps_accuracy_m: p.accuracy || null,
          photo_url: p.photo_url || null
        };

        // ตรวจระยะห่างจากพิกัดสถานบริการ
        if (p.lat && p.lng && emp && emp.facility_id) {
          const fac = DB.first('facilities', { select: 'geo,name_th', filter: { id: emp.facility_id } });
          const geo = (fac && fac.geo) || {};
          if (geo.lat && geo.lng) {
            const dist = haversineMeters(Number(p.lat), Number(p.lng), Number(geo.lat), Number(geo.lng));
            record.distance_m = Math.round(dist);
            record.is_outside_geo = dist > Number(geo.radius_m || 300);
          }
        }

        const saved = DB.insert('time_logs', record);
        const today = Util.isoDate(now);
        const attendance = DB.rpc('fn_recalc_attendance', {
          p_employee_id: ctx.employeeId, p_date: today
        });

        return { log: saved, attendance: attendance };
      }
    },

    /** สถานะการลงเวลาวันนี้ของฉัน */
    'time.myToday': {
      perm: null,
      fn: function (p, ctx) {
        if (!ctx.employeeId) return { logs: [], attendance: null, schedule: null };
        const date = p.date || Util.isoDate();

        return {
          date: date,
          logs: DB.select('time_logs', {
            select: 'id,log_time,direction,method,distance_m,is_outside_geo',
            filter: { employee_id: ctx.employeeId, log_date: date },
            order: 'log_time'
          }),
          attendance: DB.first('attendance_daily', {
            filter: { employee_id: ctx.employeeId, work_date: date }
          }),
          schedule: DB.first('work_schedules', {
            select: '*,work_shifts(code,name_th,start_time,end_time)',
            filter: { employee_id: ctx.employeeId, work_date: date }
          })
        };
      }
    },

    /** ตารางสรุปเวลารายวัน (ทั้งหน่วยงาน) */
    'time.attendanceList': {
      perm: 'time.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['from', 'to'], ['วันที่เริ่ม', 'วันที่สิ้นสุด']);

        const filter = Auth.scopeFilter(ctx, { module: 'time' });
        filter.work_date = [{ op: 'gte', value: p.from }, { op: 'lte', value: p.to }];
        if (p.facilityId) filter.facility_id = p.facilityId;
        if (p.status) filter.status = p.status;

        return DB.select('attendance_daily', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter,
          order: 'work_date.desc,employee_id',
          limit: p.limit || 500
        });
      }
    },

    /** สรุปรายเดือนรายคน */
    'time.monthlySummary': {
      perm: 'time.read',
      fn: function (p, ctx) {
        const filter = Auth.scopeFilter(ctx, { module: 'time' });
        if (p.monthStart) filter.month_start = p.monthStart;
        if (p.facilityId) filter.facility_id = p.facilityId;
        return DB.select('v_attendance_monthly', {
          filter: filter, order: 'emp_code', limit: p.limit || 500
        });
      }
    },

    /** คำนวณสรุปเวลาใหม่ (ใช้หลังแก้ไขข้อมูลย้อนหลัง) */
    'time.recalc': {
      perm: 'time.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['from', 'to'], ['วันที่เริ่ม', 'วันที่สิ้นสุด']);
        if (Util.daysBetween(p.from, p.to) > 62) {
          throw new Error('คำนวณย้อนหลังได้ครั้งละไม่เกิน 62 วัน');
        }
        if (p.employeeId) {
          Auth.requireEmployee(ctx, p.employeeId);
          let d = p.from, n = 0;
          while (d <= p.to) {
            DB.rpc('fn_recalc_attendance', { p_employee_id: p.employeeId, p_date: d });
            d = Util.addDays(d, 1); n++;
          }
          return { recalculated: n };
        }
        const count = DB.rpc('fn_recalc_attendance_range', {
          p_org_id: ctx.orgId, p_from: p.from, p_to: p.to,
          p_facility_id: p.facilityId || null
        });
        return { recalculated: count };
      }
    },

    // ------------------------------------------------------------ ตารางเวร
    'time.scheduleList': {
      perm: 'time.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['from', 'to'], ['วันที่เริ่ม', 'วันที่สิ้นสุด']);
        const filter = {
          org_id: ctx.orgId,
          work_date: [{ op: 'gte', value: p.from }, { op: 'lte', value: p.to }]
        };
        if (p.facilityId) filter.facility_id = p.facilityId;
        if (p.employeeId) filter.employee_id = p.employeeId;

        return DB.select('work_schedules', {
          select: '*,work_shifts(code,name_th,start_time,end_time,color),' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: filter,
          order: 'work_date,employee_id',
          limit: 2000
        });
      }
    },

    /** บันทึกตารางเวรทีละหลายรายการ */
    'time.scheduleSave': {
      perm: 'time.write',
      fn: function (p, ctx) {
        const items = p.items || (p.item ? [p.item] : []);
        if (!items.length) throw new Error('ไม่มีรายการตารางเวรที่จะบันทึก');

        const rows = items.map(function (it) {
          Util.requireFields(it, ['employee_id', 'work_date'], ['บุคลากร', 'วันที่']);
          return {
            org_id: ctx.orgId,
            facility_id: it.facility_id || null,
            employee_id: it.employee_id,
            work_date: it.work_date,
            shift_id: it.shift_id || null,
            is_day_off: !!it.is_day_off,
            note: it.note || null
          };
        });
        return DB.insert('work_schedules', rows, { upsertOn: 'employee_id,work_date' });
      }
    },

    // ------------------------------------------------------ คำขอแก้ไขเวลา
    'time.adjustmentList': {
      perm: 'time.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.mine && ctx.employeeId) filter.employee_id = ctx.employeeId;
        return DB.select('time_adjustments', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'created_at.desc', limit: p.limit || 100
        });
      }
    },

    'time.adjustmentSave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['work_date', 'adjust_type', 'reason'],
                              ['วันที่', 'ประเภทการแก้ไข', 'เหตุผล']);
        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) Auth.require('time.write');

        const saved = DB.insert('time_adjustments', {
          org_id: ctx.orgId,
          employee_id: employeeId,
          work_date: p.work_date,
          adjust_type: p.adjust_type,
          requested_time: p.requested_time || null,
          reason: p.reason,
          evidence_url: p.evidence_url || null
        });

        // แจ้งผู้บังคับบัญชา
        const emp = DB.first('v_employee_current', {
          select: 'supervisor_id,full_name_th', filter: { employee_id: employeeId }
        });
        if (emp && emp.supervisor_id) {
          Util.notify(ctx, {
            employeeId: emp.supervisor_id,
            userId: Util.userIdOfEmployee(emp.supervisor_id),
            title: 'คำขอแก้ไขเวลารออนุมัติ',
            body: emp.full_name_th + ' ขอแก้ไขเวลาวันที่ ' + Util.thaiDate(p.work_date),
            entityType: 'time_adjustments', entityId: saved.id
          });
        }
        return saved;
      }
    },

    'time.adjustmentAct': {
      perm: 'time.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'action'], ['คำขอ', 'การดำเนินการ']);
        if (['APPROVED', 'REJECTED'].indexOf(p.action) < 0) {
          throw new Error('การดำเนินการไม่ถูกต้อง');
        }

        const req = DB.first('time_adjustments', { filter: { id: p.id, org_id: ctx.orgId } });
        if (!req) throw new Error('ไม่พบคำขอ');
        if (req.status !== 'PENDING') throw new Error('คำขอนี้ถูกดำเนินการไปแล้ว');

        DB.updateById('time_adjustments', p.id, {
          status: p.action,
          approved_by: ctx.employeeId || null,
          approved_at: new Date().toISOString(),
          approver_note: p.note || null
        });

        // อนุมัติแล้วให้เพิ่ม/แก้ time_log แล้วคำนวณใหม่
        if (p.action === 'APPROVED' && req.requested_time) {
          const dir = (req.adjust_type === 'ADD_IN' || req.adjust_type === 'EDIT_IN') ? 'IN' : 'OUT';
          DB.insert('time_logs', {
            org_id: req.org_id,
            employee_id: req.employee_id,
            log_time: req.requested_time,
            direction: dir,
            method: 'MANUAL',
            is_manual: true,
            manual_reason: req.reason,
            approved_by: ctx.userId
          });
          DB.rpc('fn_recalc_attendance', {
            p_employee_id: req.employee_id, p_date: req.work_date
          });
        }

        Util.notify(ctx, {
          employeeId: req.employee_id,
          userId: Util.userIdOfEmployee(req.employee_id),
          title: 'ผลการพิจารณาคำขอแก้ไขเวลา',
          body: (p.action === 'APPROVED' ? 'อนุมัติ' : 'ไม่อนุมัติ') +
                ' คำขอแก้ไขเวลาวันที่ ' + Util.thaiDate(req.work_date) +
                (p.note ? ' (' + p.note + ')' : ''),
          entityType: 'time_adjustments', entityId: p.id
        });

        return { id: p.id, status: p.action };
      }
    },

    // ------------------------------------------------------------ ล่วงเวลา
    'time.otList': {
      perm: 'time.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.mine && ctx.employeeId) filter.employee_id = ctx.employeeId;
        const range = [];
        if (p.from) range.push({ op: 'gte', value: p.from });
        if (p.to)   range.push({ op: 'lte', value: p.to });
        if (range.length) filter.work_date = range;

        return DB.select('overtime_requests', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'work_date.desc', limit: p.limit || 200
        });
      }
    },

    'time.otSave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['work_date', 'start_time', 'end_time', 'reason'],
                              ['วันที่', 'เวลาเริ่ม', 'เวลาสิ้นสุด', 'เหตุผล']);
        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) Auth.require('time.write');
        if (new Date(p.end_time) <= new Date(p.start_time)) {
          throw new Error('เวลาสิ้นสุดต้องหลังเวลาเริ่ม');
        }

        const data = {
          org_id: ctx.orgId, employee_id: employeeId,
          work_date: p.work_date, start_time: p.start_time, end_time: p.end_time,
          ot_rate: p.ot_rate || 1.5, reason: p.reason,
          status: p.submit ? 'PENDING' : 'DRAFT'
        };
        if (!p.id) {
          data.request_no = Util.nextDocNo(ctx.orgId, 'OT', 'OT', Util.fiscalYear(p.work_date).toString(), 4);
        }
        return p.id ? DB.updateById('overtime_requests', p.id, data)
                    : DB.insert('overtime_requests', data);
      }
    },

    'time.otAct': {
      perm: 'time.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'action'], ['คำขอ', 'การดำเนินการ']);
        if (['APPROVED', 'REJECTED', 'CANCELLED'].indexOf(p.action) < 0) {
          throw new Error('การดำเนินการไม่ถูกต้อง');
        }
        const patch = {
          status: p.action,
          approved_by: ctx.employeeId || null,
          approved_at: new Date().toISOString()
        };
        if (p.actual_minutes !== undefined) patch.actual_minutes = p.actual_minutes;
        return DB.update('overtime_requests', { id: p.id, org_id: ctx.orgId }, patch);
      }
    },

    // ------------------------------------------------------- วันหยุด/กะ
    'time.holidayList': {
      perm: 'time.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.year) {
          filter.holiday_date = [
            { op: 'gte', value: p.year + '-01-01' },
            { op: 'lte', value: p.year + '-12-31' }
          ];
        }
        return DB.select('holidays', { filter: filter, order: 'holiday_date' });
      }
    },

    'time.holidaySave': {
      perm: 'time.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['holiday_date', 'name_th'], ['วันที่', 'ชื่อวันหยุด']);
        const data = Util.pick(p, ['facility_id','holiday_date','name_th','holiday_type','is_paid']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('holidays', p.id, data)
                    : DB.insert('holidays', data, { upsertOn: 'org_id,facility_id,holiday_date' });
      }
    },

    'time.shiftSave': {
      perm: 'time.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสกะ', 'ชื่อกะ']);
        const data = Util.pick(p, ['code','name_th','shift_type','start_time','end_time',
                                   'cross_midnight','break_minutes','work_minutes',
                                   'late_grace_min','early_grace_min','color',
                                   'is_ot_eligible','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('work_shifts', p.id, data) : DB.insert('work_shifts', data);
      }
    }
  };
}

/** ระยะห่างระหว่างพิกัด (เมตร) */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
