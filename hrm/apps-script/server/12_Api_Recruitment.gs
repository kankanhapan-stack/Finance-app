/**
 * HRM :: 12_Api_Recruitment.gs
 * โมดูล 04 Recruitment — กรอบอัตรากำลัง -> ประกาศ -> ใบสมัคร -> คัดเลือก -> บรรจุ
 */

function routesRecruitment() {
  return {

    // ------------------------------------------------- คำขออัตรากำลัง
    'recruitment.manpowerList': {
      perm: 'recruitment.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.fiscalYear) filter.fiscal_year = p.fiscalYear;
        return DB.select('manpower_requests', {
          select: '*,positions(code,name_th),facilities(name_th),departments(name_th)',
          filter: filter, order: 'created_at.desc'
        });
      }
    },

    'recruitment.manpowerSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['position_id', 'fiscal_year', 'headcount'],
                              ['ตำแหน่ง', 'ปีงบประมาณ', 'จำนวน']);
        const data = Util.pick(p, ['facility_id','department_id','position_id','request_no',
                                   'fiscal_year','headcount','reason','justification',
                                   'needed_by','budget_source','budget_amount','status',
                                   'requested_by']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('manpower_requests', p.id, data)
                    : DB.insert('manpower_requests', data);
      }
    },

    // ------------------------------------------------- ประกาศรับสมัคร
    'recruitment.postingList': {
      perm: 'recruitment.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.status) filter.status = p.status;
        if (p.facilityId) filter.facility_id = p.facilityId;

        const postings = DB.select('job_postings', {
          select: '*,positions(code,name_th),facilities(name_th),departments(name_th)',
          filter: filter, order: 'open_date.desc', limit: p.limit || 50
        });

        // นับใบสมัครต่อประกาศ
        const ids = postings.map(function (x) { return x.id; });
        if (ids.length) {
          const apps = DB.select('applications', {
            select: 'posting_id,stage', filter: { posting_id: ids }
          });
          const count = {};
          apps.forEach(function (a) {
            count[a.posting_id] = count[a.posting_id] || { total: 0, hired: 0, active: 0 };
            count[a.posting_id].total++;
            if (a.stage === 'HIRED') count[a.posting_id].hired++;
            if (['RECEIVED','SCREENING','EXAM','INTERVIEW','SELECTED','OFFERED'].indexOf(a.stage) >= 0) {
              count[a.posting_id].active++;
            }
          });
          postings.forEach(function (x) {
            x.applicationStats = count[x.id] || { total: 0, hired: 0, active: 0 };
          });
        }
        return postings;
      }
    },

    'recruitment.postingSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['position_id', 'title', 'open_date', 'close_date'],
                              ['ตำแหน่ง', 'หัวข้อประกาศ', 'วันเปิดรับ', 'วันปิดรับ']);
        if (p.close_date < p.open_date) throw new Error('วันปิดรับต้องไม่ก่อนวันเปิดรับ');

        const data = Util.pick(p, ['facility_id','department_id','position_id','manpower_request_id',
                                   'posting_no','title','employment_type','openings','salary_min',
                                   'salary_max','qualification','description','benefits',
                                   'work_location','open_date','close_date','exam_date',
                                   'announce_date','contact_info','attachment_url','status',
                                   'is_public']);
        data.org_id = ctx.orgId;

        if (!p.id && data.is_public && !data.public_slug) {
          data.public_slug = Utilities.getUuid().slice(0, 8);
        }
        return p.id ? DB.updateById('job_postings', p.id, data)
                    : DB.insert('job_postings', data);
      }
    },

    // ------------------------------------------------- ใบสมัคร
    'recruitment.applicationList': {
      perm: 'recruitment.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.postingId) filter.posting_id = p.postingId;
        if (p.stage) filter.stage = p.stage;

        return DB.select('applications', {
          select: '*,applicants(id,title_th,first_name_th,last_name_th,phone,email,' +
                  'national_id,birth_date,education,resume_url,photo_url),' +
                  'job_postings(title,posting_no)',
          filter: filter,
          order: p.order || 'rank_no.asc.nullslast,total_score.desc.nullslast,applied_at',
          limit: p.limit || 100
        });
      }
    },

    'recruitment.applicationGet': {
      perm: 'recruitment.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ใบสมัคร']);
        const app = DB.first('applications', {
          select: '*,applicants(*),job_postings(*)',
          filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!app) throw new Error('ไม่พบใบสมัคร');

        app.assessments = DB.select('application_assessments', {
          select: '*', filter: { application_id: p.id }, order: 'assessment_type'
        });
        app.interviews = DB.select('interview_schedules', {
          filter: { application_id: p.id }, order: 'round_no'
        });
        app.offers = DB.select('job_offers', { filter: { application_id: p.id } });
        return app;
      }
    },

    /** รับสมัคร (ใช้ทั้งจากเจ้าหน้าที่และหน้าเว็บสาธารณะ) */
    'recruitment.applicationSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['posting_id'], ['ประกาศรับสมัคร']);

        const posting = DB.first('job_postings', {
          select: 'id,status,open_date,close_date',
          filter: { id: p.posting_id, org_id: ctx.orgId }
        });
        if (!posting) throw new Error('ไม่พบประกาศรับสมัคร');

        let applicantId = p.applicant_id;

        if (!applicantId) {
          const a = Util.pick(p.applicant || {}, [
            'national_id','title_th','first_name_th','last_name_th','gender','birth_date',
            'phone','email','address','education','experience','licenses','skills',
            'resume_url','photo_url','source','referred_by']);
          Util.requireFields(a, ['first_name_th', 'last_name_th'], ['ชื่อ', 'นามสกุล']);
          if (a.national_id && !Util.validThaiId(a.national_id)) {
            throw new Error('เลขประจำตัวประชาชนไม่ถูกต้อง');
          }
          a.org_id = ctx.orgId;

          // ผู้สมัครเดิม (จากเลขบัตร) ให้ใช้ระเบียนเดิม
          let existing = null;
          if (a.national_id) {
            existing = DB.first('applicants', {
              select: 'id,is_blacklisted', filter: { org_id: ctx.orgId, national_id: a.national_id }
            });
          }
          if (existing) {
            if (existing.is_blacklisted) throw new Error('ผู้สมัครรายนี้อยู่ในรายชื่อต้องห้าม');
            DB.updateById('applicants', existing.id, a);
            applicantId = existing.id;
          } else {
            applicantId = DB.insert('applicants', a).id;
          }
        }

        const dup = DB.first('applications', {
          select: 'id', filter: { posting_id: p.posting_id, applicant_id: applicantId }
        });
        if (dup) throw new Error('ผู้สมัครรายนี้ยื่นใบสมัครในประกาศนี้แล้ว');

        return DB.insert('applications', {
          org_id: ctx.orgId,
          posting_id: p.posting_id,
          applicant_id: applicantId,
          application_no: p.application_no ||
            Util.nextDocNo(ctx.orgId, 'APPLICANT', 'สอบ-', Util.fiscalYear().toString(), 4),
          stage: 'RECEIVED',
          documents: p.documents || []
        });
      }
    },

    /** เปลี่ยนขั้นตอนการคัดเลือก */
    'recruitment.applicationStage': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'stage'], ['ใบสมัคร', 'ขั้นตอน']);
        const patch = { stage: p.stage };
        if (p.screening_result) patch.screening_result = p.screening_result;
        if (p.screening_note)   patch.screening_note = p.screening_note;
        if (p.reject_reason)    patch.reject_reason = p.reject_reason;
        if (p.rank_no !== undefined) patch.rank_no = p.rank_no;
        if (p.is_reserve !== undefined) patch.is_reserve = p.is_reserve;
        return DB.update('applications', { id: p.id, org_id: ctx.orgId }, patch);
      }
    },

    /** บันทึกคะแนน + คำนวณคะแนนรวมถ่วงน้ำหนัก */
    'recruitment.assessmentSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['application_id', 'assessment_type'], ['ใบสมัคร', 'ประเภทการประเมิน']);
        const data = Util.pick(p, ['application_id','assessment_type','criteria','max_score',
                                   'score','weight_percent','assessor_id','comment']);
        data.assessed_at = new Date().toISOString();

        const saved = p.id ? DB.updateById('application_assessments', p.id, data)
                           : DB.insert('application_assessments', data);

        // คำนวณคะแนนรวมใหม่
        const rows = DB.select('application_assessments', {
          select: 'score,max_score,weight_percent',
          filter: { application_id: p.application_id }
        });
        let total = 0, weight = 0;
        rows.forEach(function (r) {
          if (r.score === null || r.score === undefined) return;
          const w = Number(r.weight_percent || 0);
          const max = Number(r.max_score || 100);
          if (max > 0) { total += Number(r.score) / max * w; weight += w; }
        });
        const finalScore = weight > 0 ? Math.round(total / weight * 100 * 100) / 100 : null;
        DB.updateById('applications', p.application_id, { total_score: finalScore });

        return { assessment: saved, total_score: finalScore };
      }
    },

    'recruitment.interviewSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['application_id', 'scheduled_at'], ['ใบสมัคร', 'วันเวลานัดหมาย']);
        const data = Util.pick(p, ['application_id','round_no','scheduled_at','duration_min',
                                   'location','meeting_url','panel','status','note']);
        const saved = p.id ? DB.updateById('interview_schedules', p.id, data)
                           : DB.insert('interview_schedules', data);

        // แจ้งกรรมการสัมภาษณ์
        (p.panel || []).forEach(function (m) {
          if (!m.employee_id) return;
          Util.notify(ctx, {
            employeeId: m.employee_id,
            userId: Util.userIdOfEmployee(m.employee_id),
            channel: 'EMAIL',
            title: 'นัดหมายสัมภาษณ์ผู้สมัคร',
            body: 'วันที่ ' + Util.thaiDate(p.scheduled_at) + ' เวลา ' +
                  Utilities.formatDate(new Date(p.scheduled_at), CFG.TZ, 'HH:mm') +
                  ' สถานที่ ' + (p.location || '-'),
            entityType: 'interview_schedules', entityId: saved.id
          });
        });
        return saved;
      }
    },

    'recruitment.offerSave': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['application_id'], ['ใบสมัคร']);
        const data = Util.pick(p, ['application_id','offer_no','position_id','facility_id',
                                   'department_id','offered_salary','employment_type','start_date',
                                   'contract_months','probation_months','offer_date','expire_date',
                                   'status','document_url','decline_reason']);
        data.org_id = ctx.orgId;
        if (!data.offer_no && !p.id) {
          data.offer_no = Util.nextDocNo(ctx.orgId, 'OFFER', 'จ.', Util.fiscalYear().toString(), 4);
        }
        const saved = p.id ? DB.updateById('job_offers', p.id, data) : DB.insert('job_offers', data);

        if (data.status === 'ACCEPTED') {
          DB.updateById('applications', data.application_id, { stage: 'OFFERED' });
        }
        return saved;
      }
    },

    /**
     * บรรจุผู้สมัครเป็นบุคลากร
     * เรียก RPC ฝั่ง DB เพื่อให้ทุกอย่างอยู่ใน transaction เดียว
     */
    'recruitment.hire': {
      perm: 'recruitment.hire',
      fn: function (p, ctx) {
        Util.requireFields(p, ['application_id', 'emp_code', 'hire_date'],
                              ['ใบสมัคร', 'รหัสบุคลากร', 'วันเริ่มปฏิบัติงาน']);

        const dup = DB.first('employees', {
          select: 'id', filter: { org_id: ctx.orgId, emp_code: p.emp_code }
        });
        if (dup) throw new Error('รหัสบุคลากร ' + p.emp_code + ' ถูกใช้แล้ว');

        const employeeId = DB.rpc('fn_hire_applicant', {
          p_application_id: p.application_id,
          p_emp_code: p.emp_code,
          p_hire_date: p.hire_date,
          p_facility_id: p.facility_id || null,
          p_department_id: p.department_id || null,
          p_position_id: p.position_id || null,
          p_job_grade_id: p.job_grade_id || null,
          p_base_salary: p.base_salary || null,
          p_supervisor_id: p.supervisor_id || null,
          p_employment_type: p.employment_type || null,
          p_probation_months: p.probation_months === undefined ? 4 : p.probation_months
        });

        // สร้าง checklist onboarding มาตรฐาน
        const defaults = [
          { task_name: 'ทำสัญญาจ้าง/คำสั่งบรรจุ',        category: 'DOCUMENT' },
          { task_name: 'ส่งเอกสารประกอบการบรรจุ',        category: 'DOCUMENT' },
          { task_name: 'ขึ้นทะเบียนประกันสังคม/กบข.',     category: 'DOCUMENT' },
          { task_name: 'เปิดบัญชีเงินเดือน',              category: 'FINANCE' },
          { task_name: 'สร้างบัญชีผู้ใช้ระบบสารสนเทศ',   category: 'IT' },
          { task_name: 'ทำบัตรประจำตัวเจ้าหน้าที่',       category: 'FACILITY' },
          { task_name: 'ตรวจสุขภาพก่อนเริ่มงาน',          category: 'HEALTH' },
          { task_name: 'ปฐมนิเทศบุคลากรใหม่',            category: 'ORIENTATION' }
        ];
        DB.insert('onboarding_tasks', defaults.map(function (t, i) {
          return {
            org_id: ctx.orgId, employee_id: employeeId, application_id: p.application_id,
            task_name: t.task_name, category: t.category,
            due_date: Util.addDays(p.hire_date, 14), sort_order: i
          };
        }));

        // ตั้งสิทธิวันลาให้บุคลากรใหม่
        try {
          DB.rpc('fn_generate_leave_entitlements', {
            p_org_id: ctx.orgId, p_period_year: Util.fiscalYear(p.hire_date)
          });
        } catch (e) { console.warn('ตั้งสิทธิวันลาไม่สำเร็จ: ' + e.message); }

        return { employee_id: employeeId };
      }
    },

    'recruitment.onboardingList': {
      perm: 'recruitment.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.employeeId) filter.employee_id = p.employeeId;
        if (p.status) filter.status = p.status;
        return DB.select('onboarding_tasks', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'due_date,sort_order'
        });
      }
    },

    'recruitment.onboardingUpdate': {
      perm: 'recruitment.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'status'], ['รายการ', 'สถานะ']);
        const patch = { status: p.status, note: p.note || null };
        if (p.status === 'DONE') {
          patch.completed_at = new Date().toISOString();
          patch.completed_by = ctx.userId;
        }
        return DB.updateById('onboarding_tasks', p.id, patch);
      }
    }
  };
}
