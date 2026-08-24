/**
 * HRM :: 21_Api_Discipline.gs
 * โมดูล 13 Discipline — เรื่องวินัย / การสอบสวน / โทษทางวินัย
 * ข้อมูลชุดนี้อ่อนไหวสูง: ต้องมีสิทธิเฉพาะ และทุกการเปิดดูถูกบันทึกลง data_access_logs
 */

function routesDiscipline() {
  return {

    'discipline.list': {
      perm: 'discipline.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
        if (p.caseType) filter.case_type = p.caseType;

        const rows = DB.select('discipline_cases', {
          select: '*,employees(emp_code,title_th,first_name_th,last_name_th)',
          filter: filter, order: 'reported_date.desc', limit: p.limit || 100
        });

        Auth.logAccess(ctx, { module: 'discipline', action: 'SEARCH',
                              employeeId: p.employeeId || null });
        return rows;
      }
    },

    'discipline.get': {
      perm: 'discipline.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['เรื่องวินัย']);
        const c = DB.first('discipline_cases', {
          select: '*,employees(emp_code,title_th,first_name_th,last_name_th)',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!c) throw new Error('ไม่พบเรื่องวินัย');
        Auth.requireEmployee(ctx, c.employee_id);

        c.actions = DB.select('discipline_actions', {
          filter: { case_id: p.id }, order: 'action_date'
        });

        Auth.logAccess(ctx, {
          module: 'discipline', action: 'VIEW', employeeId: c.employee_id,
          entityType: 'discipline_cases', entityId: p.id
        });
        return c;
      }
    },

    'discipline.save': {
      perm: 'discipline.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'description'], ['บุคลากร', 'รายละเอียดเรื่อง']);
        Auth.requireEmployee(ctx, p.employee_id);

        const data = Util.pick(p, ['facility_id','employee_id','case_type','offense_category',
                                   'incident_date','reported_date','reported_by','description',
                                   'evidence','investigator_ids','investigation_start',
                                   'investigation_end','finding','status','is_confidential']);
        data.org_id = ctx.orgId;
        if (!p.id) {
          data.case_no = Util.nextDocNo(ctx.orgId, 'DISC', 'วน.', Util.fiscalYear().toString(), 4);
          data.reported_by = data.reported_by || ctx.employeeId || null;
        }
        if (data.status === 'CLOSED') data.closed_at = new Date().toISOString();

        return p.id ? DB.updateById('discipline_cases', p.id, data)
                    : DB.insert('discipline_cases', data);
      }
    },

    /** บันทึกโทษทางวินัย + ผลกระทบต่อสถานะบุคลากร */
    'discipline.actionSave': {
      perm: 'discipline.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['case_id', 'action_type'], ['เรื่องวินัย', 'ประเภทโทษ']);

        const c = DB.first('discipline_cases', {
          select: 'id,employee_id,org_id,case_no', filter: { id: p.case_id, org_id: ctx.orgId }
        });
        if (!c) throw new Error('ไม่พบเรื่องวินัย');
        Auth.requireEmployee(ctx, c.employee_id);

        const data = Util.pick(p, ['case_id','action_type','action_date','effective_from',
                                   'effective_to','penalty_amount','penalty_percent',
                                   'suspend_days','order_no','order_date','order_url',
                                   'appeal_deadline','note']);
        data.employee_id = c.employee_id;
        data.decided_by = ctx.employeeId || null;

        const saved = p.id ? DB.updateById('discipline_actions', p.id, data)
                           : DB.insert('discipline_actions', data);

        // พักราชการ -> ปรับสถานะบุคลากร
        if (data.action_type === 'SUSPENSION') {
          DB.updateById('employees', c.employee_id, { employment_status: 'SUSPENDED' });
        }
        // ไล่ออก/ปลดออก -> สร้างคำขอพ้นสภาพให้อัตโนมัติ
        if (['DISMISSAL', 'EXPULSION'].indexOf(data.action_type) >= 0 && data.effective_from) {
          DB.insert('separation_requests', {
            org_id: ctx.orgId,
            employee_id: c.employee_id,
            separation_type: 'DISMISS',
            requested_date: Util.isoDate(),
            last_working_date: data.effective_from,
            effective_date: data.effective_from,
            reason_category: 'DISCIPLINE',
            reason_detail: 'ตามคำสั่งลงโทษทางวินัย เรื่องเลขที่ ' + (c.case_no || '-'),
            is_rehirable: false,
            status: 'APPROVED'
          });
        }

        DB.insert('employment_events', {
          org_id: ctx.orgId, employee_id: c.employee_id, event_type: 'DISCIPLINE',
          event_date: data.action_date || Util.isoDate(),
          title: 'ดำเนินการทางวินัย: ' + data.action_type,
          detail: data.note || null, order_no: data.order_no || null,
          source_table: 'discipline_actions', source_id: saved.id
        });

        return saved;
      }
    },

    /** ล้างประวัติวินัยเมื่อครบกำหนดตามระเบียบ */
    'discipline.expunge': {
      perm: 'discipline.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['รายการโทษ']);
        return DB.updateById('discipline_actions', p.id, {
          is_expunged: true, expunged_date: Util.isoDate(),
          note: (p.note || '') + ' [ล้างประวัติเมื่อ ' + Util.thaiDate(Util.isoDate()) + ']'
        });
      }
    },

    /** ประวัติวินัยของบุคลากร (ใช้ประกอบการพิจารณาเลื่อนตำแหน่ง) */
    'discipline.employeeHistory': {
      perm: 'discipline.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id'], ['บุคลากร']);
        Auth.requireEmployee(ctx, p.employee_id);
        Auth.logAccess(ctx, {
          module: 'discipline', action: 'VIEW', employeeId: p.employee_id,
          purpose: p.purpose || 'ประวัติวินัย'
        });
        return DB.select('discipline_actions', {
          select: '*,discipline_cases(case_no,case_type,offense_category)',
          filter: { employee_id: p.employee_id, is_expunged: false },
          order: 'action_date.desc'
        });
      }
    }
  };
}
