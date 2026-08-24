/**
 * HRM :: 18_Api_Training.gs
 * โมดูล 10 Training — หลักสูตร / รุ่นอบรม / ลงทะเบียน / IDP / สมรรถนะ
 */

function routesTraining() {
  return {

    'training.courseList': {
      perm: 'training.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.category) filter.category = p.category;
        if (p.activeOnly !== false) filter.is_active = true;
        return DB.select('training_courses', { filter: filter, order: 'category,name_th' });
      }
    },

    'training.courseSave': {
      perm: 'training.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th'], ['รหัสหลักสูตร', 'ชื่อหลักสูตร']);
        const data = Util.pick(p, ['code','name_th','name_en','category','delivery_mode',
                                   'provider_type','provider_name','duration_hours','cpe_credits',
                                   'cost_per_person','objective','content_outline','target_group',
                                   'competency_ids','is_mandatory','validity_months','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('training_courses', p.id, data)
                    : DB.insert('training_courses', data);
      }
    },

    'training.sessionList': {
      perm: 'training.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.courseId) filter.course_id = p.courseId;
        if (p.from && p.to) {
          filter.start_date = [{ op: 'gte', value: p.from }, { op: 'lte', value: p.to }];
        }
        return DB.select('training_sessions', {
          select: '*,training_courses(code,name_th,category,duration_hours,cpe_credits)',
          filter: filter, order: 'start_date.desc', limit: p.limit || 100
        });
      }
    },

    'training.sessionSave': {
      perm: 'training.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['course_id', 'start_date', 'end_date'],
                              ['หลักสูตร', 'วันเริ่ม', 'วันสิ้นสุด']);
        if (p.end_date < p.start_date) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
        const data = Util.pick(p, ['course_id','plan_id','session_code','title','start_date',
                                   'end_date','start_time','end_time','venue','meeting_url',
                                   'trainer','trainer_employee_id','max_seats','budget_amount',
                                   'actual_cost','status','register_open','register_close']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('training_sessions', p.id, data)
                    : DB.insert('training_sessions', data);
      }
    },

    /** ลงทะเบียนอบรม (ตนเองหรือ HR ลงให้) */
    'training.register': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['session_id'], ['รุ่นการอบรม']);
        const employeeIds = p.employee_ids || [p.employee_id || ctx.employeeId];
        if (!employeeIds.length || !employeeIds[0]) {
          throw new Error('ไม่ได้ระบุผู้เข้าอบรม');
        }
        const isSelfOnly = employeeIds.length === 1 && employeeIds[0] === ctx.employeeId;
        if (!isSelfOnly) Auth.require('training.write');

        const session = DB.first('training_sessions', {
          select: 'id,status,max_seats,registered_count,register_close,start_date',
          filter: { id: p.session_id, org_id: ctx.orgId }
        });
        if (!session) throw new Error('ไม่พบรุ่นการอบรม');
        if (['CANCELLED', 'COMPLETED'].indexOf(session.status) >= 0) {
          throw new Error('รุ่นนี้ปิดรับลงทะเบียนแล้ว');
        }
        if (session.register_close && session.register_close < Util.isoDate()) {
          throw new Error('เลยกำหนดปิดรับลงทะเบียน (' + Util.thaiDate(session.register_close) + ')');
        }

        const existing = DB.select('training_registrations', {
          select: 'employee_id', filter: { session_id: p.session_id }
        }).reduce(function (m, r) { m[r.employee_id] = true; return m; }, {});

        const toAdd = employeeIds.filter(function (id) { return id && !existing[id]; });
        if (!toAdd.length) throw new Error('ผู้เข้าอบรมที่เลือกลงทะเบียนไว้แล้วทั้งหมด');

        const seatsLeft = session.max_seats
          ? Number(session.max_seats) - Number(session.registered_count || 0)
          : Infinity;

        const rows = toAdd.map(function (id, i) {
          return {
            org_id: ctx.orgId, session_id: p.session_id, employee_id: id,
            registered_by: ctx.userId,
            status: (i < seatsLeft) ? 'REGISTERED' : 'WAITLIST'
          };
        });
        const saved = DB.insert('training_registrations', rows);

        const newCount = Number(session.registered_count || 0) +
                         rows.filter(function (r) { return r.status === 'REGISTERED'; }).length;
        DB.updateById('training_sessions', p.session_id, {
          registered_count: newCount,
          status: (session.max_seats && newCount >= session.max_seats) ? 'FULL' : session.status
        });

        return { registered: rows.length, rows: saved };
      }
    },

    'training.registrationList': {
      perm: null,
      fn: function (p, ctx) {
        const filter = {};
        if (p.mine || !Auth.can(ctx, 'training.read')) {
          if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
          filter.employee_id = ctx.employeeId;
        } else {
          filter.org_id = ctx.orgId;
          if (p.sessionId) filter.session_id = p.sessionId;
          if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
          if (p.status) filter.status = p.status;
        }
        return DB.select('training_registrations', {
          select: '*,training_sessions(session_code,title,start_date,end_date,venue,' +
                  'training_courses(code,name_th,duration_hours,cpe_credits)),' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'registered_at.desc', limit: p.limit || 200
        });
      }
    },

    /** บันทึกผลการอบรม (เข้าอบรม/คะแนน/วุฒิบัตร) */
    'training.recordResult': {
      perm: 'training.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'status'], ['การลงทะเบียน', 'สถานะ']);

        const reg = DB.first('training_registrations', {
          select: '*,training_sessions(start_date,end_date,' +
                  'training_courses(name_th,provider_name,duration_hours,cpe_credits,validity_months))',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!reg) throw new Error('ไม่พบการลงทะเบียน');

        const patch = Util.pick(p, ['status','attendance_percent','pre_test_score',
                                    'post_test_score','evaluation_score','feedback',
                                    'certificate_no','certificate_url','cost']);
        const session = reg.training_sessions || {};
        const course = session.training_courses || {};

        if (p.status === 'COMPLETED' || p.status === 'ATTENDED') {
          patch.completed_date = p.completed_date || session.end_date || Util.isoDate();
          if (course.validity_months) {
            const d = new Date(patch.completed_date);
            d.setMonth(d.getMonth() + Number(course.validity_months));
            patch.expire_date = Util.isoDate(d);
          }
        }
        const saved = DB.updateById('training_registrations', p.id, patch);

        // บันทึกลงประวัติการอบรมของบุคลากร
        if (p.status === 'COMPLETED' || p.status === 'ATTENDED') {
          DB.insert('training_records', {
            org_id: ctx.orgId,
            employee_id: reg.employee_id,
            registration_id: reg.id,
            course_name: course.name_th || 'อบรม',
            provider: course.provider_name || null,
            start_date: session.start_date || null,
            end_date: session.end_date || null,
            hours: course.duration_hours || null,
            cpe_credits: course.cpe_credits || null,
            cost: patch.cost || null,
            certificate_no: patch.certificate_no || null,
            certificate_url: patch.certificate_url || null,
            expire_date: patch.expire_date || null
          });

          DB.insert('employment_events', {
            org_id: ctx.orgId, employee_id: reg.employee_id, event_type: 'TRAINING',
            event_date: patch.completed_date,
            title: 'ผ่านการอบรม: ' + (course.name_th || '-'),
            detail: course.duration_hours ? course.duration_hours + ' ชั่วโมง' : null,
            source_table: 'training_registrations', source_id: reg.id
          });
        }
        return saved;
      }
    },

    'training.recordList': {
      perm: null,
      fn: function (p, ctx) {
        const employeeId = p.employeeId || ctx.employeeId;
        if (!employeeId) throw new Error('ไม่ได้ระบุบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('training.read');
          Auth.requireEmployee(ctx, employeeId);
        }
        return DB.select('training_records', {
          filter: { employee_id: employeeId }, order: 'start_date.desc', limit: p.limit || 200
        });
      }
    },

    'training.planSave': {
      perm: 'training.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['fiscal_year', 'name_th'], ['ปีงบประมาณ', 'ชื่อแผน']);
        const data = Util.pick(p, ['facility_id','fiscal_year','name_th','total_budget',
                                   'used_budget','target_headcount','status']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('training_plans', p.id, data)
                    : DB.insert('training_plans', data);
      }
    },

    'training.summary': {
      perm: 'training.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.fiscalYear) filter.fiscal_year = p.fiscalYear;
        if (p.employeeId) filter.employee_id = p.employeeId;
        return DB.select('v_training_summary', {
          filter: filter, order: 'total_hours.desc', limit: p.limit || 500
        });
      }
    },

    // ------------------------------------------------ สมรรถนะ + IDP
    'training.competencyList': {
      perm: 'training.read',
      fn: function (p, ctx) {
        return DB.select('competencies', {
          filter: { org_id: ctx.orgId, is_active: true }, order: 'competency_type,code'
        });
      }
    },

    'training.competencyGap': {
      perm: null,
      fn: function (p, ctx) {
        const employeeId = p.employeeId || ctx.employeeId;
        if (!employeeId) throw new Error('ไม่ได้ระบุบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('training.read');
          Auth.requireEmployee(ctx, employeeId);
        }
        return DB.select('v_competency_gap', {
          filter: { employee_id: employeeId }, order: 'gap_level.desc'
        });
      }
    },

    'training.competencyAssess': {
      perm: 'performance.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'items'], ['บุคลากร', 'รายการประเมิน']);
        Auth.requireEmployee(ctx, p.employee_id);
        const rows = (p.items || []).map(function (it) {
          return {
            org_id: ctx.orgId,
            employee_id: p.employee_id,
            competency_id: it.competency_id,
            cycle_id: p.cycle_id || null,
            assessed_level: it.level,
            assessed_date: p.assessed_date || Util.isoDate(),
            assessed_by: ctx.employeeId || null,
            evidence: it.evidence || null
          };
        });
        if (!rows.length) throw new Error('ไม่มีรายการประเมิน');
        return DB.insert('employee_competencies', rows,
                         { upsertOn: 'employee_id,competency_id,cycle_id' });
      }
    },

    /** แผนพัฒนารายบุคคล (IDP) */
    'training.idpGet': {
      perm: null,
      fn: function (p, ctx) {
        const employeeId = p.employeeId || ctx.employeeId;
        const fy = p.fiscalYear || Util.fiscalYear();
        if (!employeeId) throw new Error('ไม่ได้ระบุบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('training.read');
          Auth.requireEmployee(ctx, employeeId);
        }

        const plan = DB.first('development_plans', {
          select: '*,positions(name_th)',
          filter: { employee_id: employeeId, fiscal_year: fy }
        });
        if (!plan) return { plan: null, activities: [], gaps: DB.select('v_competency_gap', {
          filter: { employee_id: employeeId }, order: 'gap_level.desc' }) };

        plan.activities = DB.select('development_activities', {
          select: '*,competencies(code,name_th),training_courses(code,name_th)',
          filter: { plan_id: plan.id }, order: 'activity_no'
        });
        plan.gaps = DB.select('v_competency_gap', {
          filter: { employee_id: employeeId }, order: 'gap_level.desc'
        });
        return plan;
      }
    },

    'training.idpSave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'fiscal_year'], ['บุคลากร', 'ปีงบประมาณ']);
        if (p.employee_id !== ctx.employeeId) {
          Auth.require('training.write');
          Auth.requireEmployee(ctx, p.employee_id);
        }
        const data = Util.pick(p, ['employee_id','cycle_id','fiscal_year','career_goal',
                                   'target_position_id','summary','status','progress_percent']);
        data.org_id = ctx.orgId;
        return DB.insert('development_plans', data, { upsertOn: 'employee_id,fiscal_year' });
      }
    },

    'training.idpActivitySave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['plan_id', 'title'], ['แผนพัฒนา', 'ชื่อกิจกรรม']);
        const plan = DB.first('development_plans', {
          select: 'id,employee_id', filter: { id: p.plan_id }
        });
        if (!plan) throw new Error('ไม่พบแผนพัฒนา');
        if (plan.employee_id !== ctx.employeeId) {
          Auth.require('training.write');
          Auth.requireEmployee(ctx, plan.employee_id);
        }

        const data = Util.pick(p, ['plan_id','competency_id','activity_no','method','title',
                                   'description','current_level','target_level','target_date',
                                   'budget','course_id','status','completed_date','result_note',
                                   'evidence_url']);
        const saved = p.id ? DB.updateById('development_activities', p.id, data)
                           : DB.insert('development_activities', data);

        // ปรับ % ความคืบหน้าของแผน
        const acts = DB.select('development_activities', {
          select: 'status', filter: { plan_id: p.plan_id }
        });
        const done = acts.filter(function (a) { return a.status === 'COMPLETED'; }).length;
        DB.updateById('development_plans', p.plan_id, {
          progress_percent: acts.length ? Math.round(done / acts.length * 10000) / 100 : 0
        });

        return saved;
      }
    }
  };
}
