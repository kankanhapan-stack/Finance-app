/**
 * HRM :: 19_Api_Career.gs
 * โมดูล 11 Career — เส้นทางความก้าวหน้า / คำสั่งเลื่อน-ย้าย / แผนสืบทอดตำแหน่ง
 */

function routesCareer() {
  return {

    'career.pathList': {
      perm: 'career.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.fromPositionId) filter.from_position_id = p.fromPositionId;
        return DB.select('career_paths', {
          select: '*,from_position:positions!career_paths_from_position_id_fkey(code,name_th),' +
                  'to_position:positions!career_paths_to_position_id_fkey(code,name_th)',
          filter: filter
        });
      }
    },

    'career.pathSave': {
      perm: 'career.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['from_position_id', 'to_position_id'],
                              ['ตำแหน่งต้นทาง', 'ตำแหน่งปลายทาง']);
        if (p.from_position_id === p.to_position_id) {
          throw new Error('ตำแหน่งต้นทางและปลายทางต้องต่างกัน');
        }
        const data = Util.pick(p, ['from_position_id','to_position_id','path_type',
                                   'min_years_in_position','min_total_years','required_education',
                                   'required_training','required_rating','note']);
        data.org_id = ctx.orgId;
        return DB.insert('career_paths', data, { upsertOn: 'from_position_id,to_position_id' });
      }
    },

    'career.movementList': {
      perm: 'career.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
        if (p.movementType) filter.movement_type = p.movementType;
        return DB.select('career_movements', {
          select: '*,employees(emp_code,title_th,first_name_th,last_name_th),' +
                  'to_position:positions!career_movements_to_position_id_fkey(code,name_th),' +
                  'to_facility:facilities!career_movements_to_facility_id_fkey(name_th)',
          filter: filter, order: 'effective_date.desc', limit: p.limit || 200
        });
      }
    },

    /** ร่างคำสั่งเลื่อน/ย้าย — ดึงค่าปัจจุบันมาเป็น from_* ให้อัตโนมัติ */
    'career.movementSave': {
      perm: 'career.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'movement_type', 'effective_date'],
                              ['บุคลากร', 'ประเภทการเปลี่ยนแปลง', 'วันที่มีผล']);
        Auth.requireEmployee(ctx, p.employee_id);

        const data = Util.pick(p, ['employee_id','movement_type','effective_date',
                                   'to_facility_id','to_department_id','to_position_id',
                                   'to_grade_id','to_salary','to_supervisor_id',
                                   'reason','order_no','order_date','order_url','status']);
        data.org_id = ctx.orgId;

        if (!p.id) {
          const cur = DB.first('employment_assignments', {
            select: 'facility_id,department_id,position_id,job_grade_id,base_salary',
            filter: { employee_id: p.employee_id, assignment_type: 'PRIMARY', effective_to: null }
          });
          if (cur) {
            data.from_facility_id   = cur.facility_id;
            data.from_department_id = cur.department_id;
            data.from_position_id   = cur.position_id;
            data.from_grade_id      = cur.job_grade_id;
            data.from_salary        = cur.base_salary;
          }
          data.status = data.status || 'DRAFT';
          return DB.insert('career_movements', data);
        }

        const existing = DB.first('career_movements', { select: 'status', filter: { id: p.id } });
        if (existing && existing.status === 'APPLIED') {
          throw new Error('คำสั่งที่ดำเนินการแล้วแก้ไขไม่ได้');
        }
        return DB.updateById('career_movements', p.id, data);
      }
    },

    'career.movementApprove': {
      perm: 'career.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['คำสั่ง']);
        const mv = DB.first('career_movements', {
          select: 'id,status,employee_id', filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!mv) throw new Error('ไม่พบคำสั่ง');
        if (['DRAFT', 'PROPOSED'].indexOf(mv.status) < 0) {
          throw new Error('คำสั่งสถานะ ' + mv.status + ' อนุมัติไม่ได้');
        }
        return DB.updateById('career_movements', p.id, {
          status: 'APPROVED', approved_by: ctx.employeeId || null,
          approved_at: new Date().toISOString()
        });
      }
    },

    /** นำคำสั่งไปใช้จริง: ปิด assignment เดิม เปิดใหม่ บันทึก timeline */
    'career.movementApply': {
      perm: 'career.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['คำสั่ง']);
        const mv = DB.first('career_movements', {
          select: 'id,status,employee_id,effective_date,movement_type',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!mv) throw new Error('ไม่พบคำสั่ง');
        if (mv.status === 'APPLIED') throw new Error('คำสั่งนี้ดำเนินการไปแล้ว');

        const assignment = DB.rpc('fn_apply_career_movement', { p_movement_id: p.id });

        Util.notify(ctx, {
          employeeId: mv.employee_id,
          userId: Util.userIdOfEmployee(mv.employee_id),
          title: 'มีคำสั่งเปลี่ยนแปลงตำแหน่ง/สังกัด',
          body: 'มีผลตั้งแต่วันที่ ' + Util.thaiDate(mv.effective_date),
          entityType: 'career_movements', entityId: p.id
        });

        Auth.clearCache();   // ขอบเขตสิทธิอาจเปลี่ยน
        return assignment;
      }
    },

    'career.successionList': {
      perm: 'career.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.positionId) filter.position_id = p.positionId;
        return DB.select('succession_plans', {
          select: '*,positions(code,name_th),' +
                  'candidate:employees!succession_plans_candidate_id_fkey(emp_code,first_name_th,last_name_th),' +
                  'incumbent:employees!succession_plans_incumbent_id_fkey(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'priority'
        });
      }
    },

    'career.successionSave': {
      perm: 'career.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['position_id', 'candidate_id'], ['ตำแหน่ง', 'ผู้สืบทอด']);
        const data = Util.pick(p, ['position_id','facility_id','incumbent_id','candidate_id',
                                   'readiness','priority','gap_note','review_date']);
        data.org_id = ctx.orgId;
        return DB.insert('succession_plans', data, { upsertOn: 'position_id,candidate_id' });
      }
    },

    /** ผู้ที่มีคุณสมบัติเลื่อนไปตำแหน่งเป้าหมาย (ตรวจตามเงื่อนไข career_paths) */
    'career.eligibleCandidates': {
      perm: 'career.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['to_position_id'], ['ตำแหน่งเป้าหมาย']);
        const paths = DB.select('career_paths', {
          filter: { org_id: ctx.orgId, to_position_id: p.to_position_id }
        });
        if (!paths.length) return [];

        const fromIds = paths.map(function (x) { return x.from_position_id; });
        const rule = paths[0];

        const candidates = DB.select('v_employee_current', {
          select: 'employee_id,emp_code,full_name_th,position_id,position_name,' +
                  'hire_date,assignment_from,grade_name,facility_name',
          filter: { org_id: ctx.orgId, position_id: fromIds,
                    employment_status: ['ACTIVE', 'ON_LEAVE'] },
          limit: 500
        });

        const today = new Date();
        return candidates.map(function (c) {
          const yearsInPos = c.assignment_from
            ? (today - new Date(c.assignment_from)) / (365.25 * 86400000) : 0;
          const totalYears = c.hire_date
            ? (today - new Date(c.hire_date)) / (365.25 * 86400000) : 0;

          const reasons = [];
          if (rule.min_years_in_position && yearsInPos < Number(rule.min_years_in_position)) {
            reasons.push('ดำรงตำแหน่งปัจจุบัน ' + yearsInPos.toFixed(1) + ' ปี (ต้องการ ' +
                         rule.min_years_in_position + ' ปี)');
          }
          if (rule.min_total_years && totalYears < Number(rule.min_total_years)) {
            reasons.push('อายุงานรวม ' + totalYears.toFixed(1) + ' ปี (ต้องการ ' +
                         rule.min_total_years + ' ปี)');
          }
          c.years_in_position = Math.round(yearsInPos * 10) / 10;
          c.total_years = Math.round(totalYears * 10) / 10;
          c.eligible = reasons.length === 0;
          c.blocking_reasons = reasons;
          return c;
        }).sort(function (a, b) {
          if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
          return b.years_in_position - a.years_in_position;
        });
      }
    }
  };
}
