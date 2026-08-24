/**
 * HRM :: 17_Api_Performance.gs
 * โมดูล 09 Performance — รอบประเมิน / KPI / ใบประเมิน / เลื่อนขั้น
 */

function routesPerformance() {
  return {

    'performance.cycleList': {
      perm: 'performance.read',
      fn: function (p, ctx) {
        return DB.select('appraisal_cycles', {
          filter: { org_id: ctx.orgId }, order: 'fiscal_year.desc,round_no.desc'
        });
      }
    },

    'performance.cycleSave': {
      perm: 'performance.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code','name_th','fiscal_year','start_date','end_date'],
                              ['รหัสรอบ','ชื่อรอบ','ปีงบประมาณ','วันเริ่ม','วันสิ้นสุด']);
        const data = Util.pick(p, ['code','name_th','fiscal_year','round_no','start_date',
                                   'end_date','self_eval_due','supervisor_due','calibration_due',
                                   'status','quota_config']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('appraisal_cycles', p.id, data)
                    : DB.insert('appraisal_cycles', data);
      }
    },

    /** เปิดรอบประเมิน: สร้างใบประเมินให้บุคลากรทุกคนที่เข้าเงื่อนไข */
    'performance.openCycle': {
      perm: 'performance.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['cycle_id'], ['รอบประเมิน']);
        const cycle = DB.first('appraisal_cycles', {
          filter: { id: p.cycle_id, org_id: ctx.orgId }
        });
        if (!cycle) throw new Error('ไม่พบรอบประเมิน');
        if (['CLOSED', 'CANCELLED'].indexOf(cycle.status) >= 0) {
          throw new Error('รอบนี้ปิดแล้ว');
        }

        const filter = { org_id: ctx.orgId, employment_status: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] };
        if (p.facility_id) filter.facility_id = p.facility_id;

        const employees = DB.select('v_employee_current', {
          select: 'employee_id,facility_id,department_id,position_id,supervisor_id',
          filter: filter, limit: 2000
        });
        if (!employees.length) throw new Error('ไม่มีบุคลากรที่เข้าเงื่อนไข');

        const existing = DB.select('appraisals', {
          select: 'employee_id', filter: { cycle_id: p.cycle_id }
        }).reduce(function (m, r) { m[r.employee_id] = true; return m; }, {});

        const rows = employees
          .filter(function (e) { return !existing[e.employee_id]; })
          .map(function (e) {
            return {
              org_id: ctx.orgId, cycle_id: p.cycle_id, employee_id: e.employee_id,
              form_id: p.form_id || null,
              facility_id: e.facility_id, department_id: e.department_id,
              position_id: e.position_id, appraiser_id: e.supervisor_id,
              status: 'DRAFT'
            };
          });

        if (rows.length) DB.insert('appraisals', rows);
        DB.updateById('appraisal_cycles', p.cycle_id, { status: 'SELF_EVAL' });

        return { created: rows.length, skipped: employees.length - rows.length };
      }
    },

    'performance.list': {
      perm: null,
      fn: function (p, ctx) {
        const filter = {};
        if (p.mine || !Auth.can(ctx, 'performance.read')) {
          if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
          filter.employee_id = ctx.employeeId;
        } else {
          filter.org_id = ctx.orgId;
          if (p.cycleId) filter.cycle_id = p.cycleId;
          if (p.status) filter.status = p.status;
          if (p.asAppraiser && ctx.employeeId) filter.appraiser_id = ctx.employeeId;
          if (p.facilityId) filter.facility_id = p.facilityId;
        }
        return DB.select('appraisals', {
          select: '*,appraisal_cycles(code,name_th,fiscal_year),' +
                  'employees(emp_code,first_name_th,last_name_th),' +
                  'positions(name_th),departments(name_th)',
          filter: filter, order: 'total_score.desc.nullslast', limit: p.limit || 200
        });
      }
    },

    'performance.get': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบประเมิน']);
        const ap = DB.first('appraisals', {
          select: '*,appraisal_cycles(*),appraisal_forms(*),' +
                  'employees(emp_code,title_th,first_name_th,last_name_th)',
          filter: { id: p.id }
        });
        if (!ap) throw new Error('ไม่พบใบประเมิน');
        if (ap.employee_id !== ctx.employeeId && ap.appraiser_id !== ctx.employeeId) {
          Auth.require('performance.read');
          Auth.requireEmployee(ctx, ap.employee_id);
        }

        ap.scores = DB.select('appraisal_scores', {
          filter: { appraisal_id: p.id }, order: 'section,sort_order'
        });
        ap.kpis = DB.select('employee_kpis', {
          filter: { cycle_id: ap.cycle_id, employee_id: ap.employee_id }, order: 'kpi_no'
        });

        // ยังไม่มีหัวข้อคะแนน -> สร้างจากแบบฟอร์ม
        if (!ap.scores.length && ap.form_id) {
          const items = DB.select('appraisal_form_items', {
            filter: { form_id: ap.form_id }, order: 'section,item_no'
          });
          if (items.length) {
            ap.scores = DB.insert('appraisal_scores', items.map(function (it, i) {
              return {
                appraisal_id: p.id, form_item_id: it.id, section: it.section,
                item_title: it.title, weight_percent: it.weight_percent,
                max_score: it.max_score, sort_order: i
              };
            }));
          }
        }
        return ap;
      }
    },

    /** บันทึกคะแนน (ประเมินตนเอง / ผู้ประเมิน) */
    'performance.saveScores': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'mode'], ['ใบประเมิน', 'โหมด']);
        const ap = DB.first('appraisals', {
          select: 'id,employee_id,appraiser_id,status,cycle_id', filter: { id: p.id }
        });
        if (!ap) throw new Error('ไม่พบใบประเมิน');

        if (p.mode === 'SELF') {
          if (ap.employee_id !== ctx.employeeId) throw new Error('ประเมินตนเองแทนผู้อื่นไม่ได้');
          if (['DRAFT', 'SELF_SUBMITTED'].indexOf(ap.status) < 0) {
            throw new Error('ใบประเมินสถานะ ' + ap.status + ' แก้ไขส่วนประเมินตนเองไม่ได้');
          }
        } else if (p.mode === 'APPRAISER') {
          if (ap.appraiser_id !== ctx.employeeId) Auth.require('performance.write');
          if (['APPROVED', 'ACKNOWLEDGED', 'CLOSED'].indexOf(ap.status) >= 0) {
            throw new Error('ใบประเมินปิดแล้ว');
          }
        } else {
          throw new Error('โหมดไม่ถูกต้อง');
        }

        (p.scores || []).forEach(function (s) {
          if (!s.id) return;
          const patch = p.mode === 'SELF'
            ? { self_score: s.score }
            : { appraiser_score: s.score, final_score: s.score, comment: s.comment || null };
          DB.updateById('appraisal_scores', s.id, patch);
        });

        const patch = {};
        if (p.mode === 'SELF') {
          patch.self_comment = p.comment || null;
          if (p.submit) { patch.status = 'SELF_SUBMITTED'; patch.self_submitted_at = new Date().toISOString(); }
        } else {
          patch.appraiser_comment = p.comment || null;
          patch.strengths = p.strengths || null;
          patch.improvements = p.improvements || null;
          patch.development_note = p.development_note || null;
          if (p.submit) { patch.status = 'APPRAISED'; patch.appraised_at = new Date().toISOString(); }
        }
        DB.updateById('appraisals', p.id, patch);

        return DB.rpc('fn_calc_appraisal_score', { p_appraisal_id: p.id });
      }
    },

    'performance.approve': {
      perm: 'performance.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบประเมิน']);
        const ap = DB.first('appraisals', {
          select: 'id,employee_id,status,total_score,rating_label',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!ap) throw new Error('ไม่พบใบประเมิน');
        if (['APPRAISED', 'REVIEWED'].indexOf(ap.status) < 0) {
          throw new Error('ใบประเมินต้องผ่านการประเมินก่อน (สถานะปัจจุบัน: ' + ap.status + ')');
        }

        const out = DB.updateById('appraisals', p.id, {
          status: 'APPROVED', approver_id: ctx.employeeId || null,
          approved_at: new Date().toISOString(),
          reviewer_comment: p.comment || null
        });

        Util.notify(ctx, {
          employeeId: ap.employee_id,
          userId: Util.userIdOfEmployee(ap.employee_id),
          title: 'ผลการประเมินได้รับการอนุมัติ',
          body: 'คะแนนรวม ' + (ap.total_score || '-') + ' (' + (ap.rating_label || '-') +
                ') กรุณาเข้าระบบเพื่อรับทราบผล',
          entityType: 'appraisals', entityId: p.id
        });
        return out;
      }
    },

    /** บุคลากรรับทราบผลประเมิน */
    'performance.acknowledge': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบประเมิน']);
        const ap = DB.first('appraisals', { select: 'id,employee_id,status', filter: { id: p.id } });
        if (!ap) throw new Error('ไม่พบใบประเมิน');
        if (ap.employee_id !== ctx.employeeId) throw new Error('รับทราบผลแทนผู้อื่นไม่ได้');
        if (ap.status !== 'APPROVED') throw new Error('ผลประเมินยังไม่ได้รับอนุมัติ');

        return DB.updateById('appraisals', p.id, {
          status: 'ACKNOWLEDGED',
          acknowledged_at: new Date().toISOString(),
          acknowledge_note: p.note || null
        });
      }
    },

    'performance.appeal': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'reason'], ['ใบประเมิน', 'เหตุผลการอุทธรณ์']);
        const ap = DB.first('appraisals', { select: 'id,employee_id,status', filter: { id: p.id } });
        if (!ap) throw new Error('ไม่พบใบประเมิน');
        if (ap.employee_id !== ctx.employeeId) throw new Error('อุทธรณ์แทนผู้อื่นไม่ได้');

        DB.updateById('appraisals', p.id, { status: 'APPEALED' });
        return DB.insert('appraisal_appeals', {
          appraisal_id: p.id, reason: p.reason, requested_by: ctx.employeeId
        });
      }
    },

    // ------------------------------------------------------------- KPI
    'performance.kpiSave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['cycle_id', 'employee_id', 'title'], ['รอบประเมิน', 'บุคลากร', 'ชื่อตัวชี้วัด']);
        if (p.employee_id !== ctx.employeeId) {
          Auth.require('performance.write');
          Auth.requireEmployee(ctx, p.employee_id);
        }
        const data = Util.pick(p, ['cycle_id','employee_id','kpi_no','title','description',
                                   'target_value','measure_unit','weight_percent','actual_value',
                                   'achievement_percent','score','evidence']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('employee_kpis', p.id, data)
                    : DB.insert('employee_kpis', data, { upsertOn: 'cycle_id,employee_id,kpi_no' });
      }
    },

    // ------------------------------------------------------- เลื่อนขั้น
    'performance.meritList': {
      perm: 'performance.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.cycleId) filter.cycle_id = p.cycleId;
        return DB.select('merit_increases', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'effective_date.desc', limit: p.limit || 500
        });
      }
    },

    /** เสนอเลื่อนเงินเดือนจากผลประเมินทั้งรอบ */
    'performance.meritPropose': {
      perm: 'performance.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['cycle_id', 'effective_date'], ['รอบประเมิน', 'วันที่มีผล']);
        const rateByRating = p.rate_by_rating || { A: 4, B: 3, C: 2.5, D: 2, E: 0 };

        const appraisals = DB.select('appraisals', {
          select: 'employee_id,rating_code,total_score',
          filter: { cycle_id: p.cycle_id, org_id: ctx.orgId,
                    status: ['APPROVED', 'ACKNOWLEDGED', 'CLOSED'] },
          limit: 2000
        });
        if (!appraisals.length) throw new Error('ยังไม่มีผลประเมินที่อนุมัติแล้วในรอบนี้');

        const salaries = {};
        DB.select('v_employee_current', {
          select: 'employee_id,base_salary', filter: { org_id: ctx.orgId }, limit: 2000
        }).forEach(function (e) { salaries[e.employee_id] = Number(e.base_salary || 0); });

        const rows = appraisals.map(function (a) {
          const pct = Number(rateByRating[a.rating_code] || 0);
          const oldSalary = salaries[a.employee_id] || 0;
          const inc = Math.round(oldSalary * pct / 100 * 100) / 100;
          return {
            org_id: ctx.orgId, cycle_id: p.cycle_id, employee_id: a.employee_id,
            effective_date: p.effective_date, rating_code: a.rating_code,
            increase_percent: pct, increase_amount: inc,
            old_salary: oldSalary, new_salary: Math.round((oldSalary + inc) * 100) / 100,
            status: 'PROPOSED'
          };
        });

        DB.insert('merit_increases', rows, { upsertOn: 'cycle_id,employee_id' });
        return { proposed: rows.length };
      }
    },

    /** อนุมัติและนำไปใช้จริง (ปรับเงินเดือน + บันทึกประวัติ) */
    'performance.meritApply': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['cycle_id'], ['รอบประเมิน']);
        const rows = DB.select('merit_increases', {
          filter: { cycle_id: p.cycle_id, org_id: ctx.orgId, status: ['PROPOSED', 'APPROVED'] },
          limit: 2000
        });
        if (!rows.length) throw new Error('ไม่มีรายการที่รอนำไปใช้');

        let applied = 0;
        rows.forEach(function (m) {
          if (!m.new_salary || Number(m.new_salary) <= 0) return;

          const current = DB.first('employment_assignments', {
            select: 'id', filter: { employee_id: m.employee_id,
                                    assignment_type: 'PRIMARY', effective_to: null }
          });

          const hist = DB.insert('salary_histories', {
            org_id: ctx.orgId, employee_id: m.employee_id,
            effective_date: m.effective_date,
            old_salary: m.old_salary, new_salary: m.new_salary,
            change_percent: m.increase_percent,
            change_type: 'ANNUAL',
            reason: 'เลื่อนเงินเดือนตามผลประเมิน (' + (m.rating_code || '-') + ')',
            order_no: m.order_no || null,
            approved_by: ctx.employeeId || null
          });

          if (current) DB.updateById('employment_assignments', current.id, { base_salary: m.new_salary });

          DB.insert('employment_events', {
            org_id: ctx.orgId, employee_id: m.employee_id, event_type: 'SALARY_ADJUST',
            event_date: m.effective_date, title: 'เลื่อนเงินเดือนประจำปี',
            from_value: { salary: m.old_salary }, to_value: { salary: m.new_salary },
            source_table: 'salary_histories', source_id: hist.id
          });

          DB.updateById('merit_increases', m.id, {
            status: 'APPLIED', approved_by: ctx.employeeId || null,
            approved_at: new Date().toISOString()
          });
          applied++;
        });
        return { applied: applied };
      }
    },

    'performance.formList': {
      perm: 'performance.read',
      fn: function (p, ctx) {
        const forms = DB.select('appraisal_forms', {
          filter: { org_id: ctx.orgId }, order: 'code'
        });
        forms.forEach(function (f) {
          f.items = DB.select('appraisal_form_items', {
            filter: { form_id: f.id }, order: 'section,item_no'
          });
        });
        return forms;
      }
    }
  };
}
