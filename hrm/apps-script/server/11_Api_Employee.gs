/**
 * HRM :: 11_Api_Employee.gs
 * โมดูล 03 Employee — ทะเบียนประวัติบุคลากร
 */

/** คอลัมน์ที่อนุญาตให้เขียนจากฝั่ง client (กันการยัดคอลัมน์ระบบ) */
const EMPLOYEE_WRITABLE = [
  'emp_code','national_id','passport_no',
  'title_th','first_name_th','middle_name_th','last_name_th',
  'title_en','first_name_en','last_name_en','nickname','former_name',
  'gender','birth_date','birth_province','nationality','ethnicity','religion',
  'marital_status','blood_type','height_cm','weight_kg','military_status',
  'phone','phone_emergency','email','email_work','line_id',
  'address_current','address_register',
  'employment_status','hire_date','probation_end_date','gov_service_date',
  'photo_url','signature_url','bank_account','tax_id','sso_no','pvd_member_no',
  'note','extra'
];

function routesEmployee() {
  return {

    /** รายการบุคลากร (แบ่งหน้า + ค้นหา + กรองตามขอบเขตสิทธิ) */
    'employee.list': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        const filter = Auth.scopeFilter(ctx, { module: 'employee' });

        if (p.facilityId)   filter.facility_id = p.facilityId;
        if (p.departmentId) filter.department_id = p.departmentId;
        if (p.positionId)   filter.position_id = p.positionId;
        if (p.employmentType) filter.employment_type = p.employmentType;
        filter.employment_status = p.status
          ? p.status
          : { op: 'in', value: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] };

        const opts = {
          select: 'employee_id,emp_code,full_name_th,photo_url,gender,age_years,' +
                  'position_name,department_name,facility_name,facility_id,department_id,' +
                  'employment_type,employment_status,hire_date,service_length_text,' +
                  'phone,email,retirement_date',
          filter: filter,
          order: p.order || 'emp_code',
          limit: p.limit || 50,
          offset: p.offset || 0
        };

        // ค้นหาจากรหัส/ชื่อ/สกุล/เบอร์โทร
        if (p.q) {
          const q = String(p.q).trim().replace(/[(),]/g, '');
          opts.or = 'emp_code.ilike.*' + q + '*,full_name_th.ilike.*' + q + '*,phone.ilike.*' + q + '*';
        }

        const out = DB.selectPaged('v_employee_current', opts);
        Auth.logAccess(ctx, { module: 'employee', action: 'SEARCH', purpose: p.q || 'list' });
        return out;
      }
    },

    /** ประวัติเต็มของบุคลากร 1 คน */
    'employee.get': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['รหัสบุคลากร']);
        Auth.requireEmployee(ctx, p.id);

        const employee = DB.first('employees', { filter: { id: p.id, org_id: ctx.orgId } });
        if (!employee) throw new Error('ไม่พบข้อมูลบุคลากร');

        const current = DB.first('v_employee_current', { filter: { employee_id: p.id } });

        const result = {
          employee: employee,
          current: current,
          assignments: DB.select('employment_assignments', {
            select: '*,facilities(name_th),departments(name_th),positions(name_th),job_grades(name_th)',
            filter: { employee_id: p.id }, order: 'effective_from.desc'
          }),
          events: DB.select('employment_events', {
            filter: { employee_id: p.id }, order: 'event_date.desc,id.desc', limit: 100
          }),
          educations: DB.select('employee_educations', {
            filter: { employee_id: p.id }, order: 'graduate_year.desc'
          }),
          licenses: DB.select('employee_licenses', {
            filter: { employee_id: p.id }, order: 'expire_date.desc'
          }),
          families: DB.select('employee_families', { filter: { employee_id: p.id } }),
          experiences: DB.select('employee_experiences', {
            filter: { employee_id: p.id }, order: 'start_date.desc'
          }),
          awards: DB.select('employee_awards', {
            filter: { employee_id: p.id }, order: 'granted_date.desc'
          })
        };

        // เอกสารลับต้องมีสิทธิเฉพาะ
        result.files = DB.select('employee_files', {
          filter: Auth.can(ctx, 'employee.read_confidential')
                    ? { employee_id: p.id }
                    : { employee_id: p.id, is_confidential: false },
          order: 'uploaded_at.desc'
        });

        if (Auth.can(ctx, 'payroll.read')) {
          result.salaryHistory = DB.select('salary_histories', {
            filter: { employee_id: p.id }, order: 'effective_date.desc'
          });
        }

        Auth.logAccess(ctx, {
          module: 'employee', action: 'VIEW', employeeId: p.id,
          entityType: 'employees', entityId: p.id
        });
        return result;
      }
    },

    /** เพิ่ม/แก้ไขข้อมูลบุคลากร */
    'employee.save': {
      perm: 'employee.write',
      fn: function (p, ctx) {
        const data = Util.pick(p, EMPLOYEE_WRITABLE);

        Util.requireFields(data, ['emp_code', 'first_name_th', 'last_name_th'],
                                 ['รหัสบุคลากร', 'ชื่อ', 'นามสกุล']);

        if (data.national_id && !Util.validThaiId(data.national_id)) {
          throw new Error('เลขประจำตัวประชาชนไม่ถูกต้อง');
        }

        data.org_id = ctx.orgId;

        if (p.id) {
          Auth.requireEmployee(ctx, p.id);
          const existing = DB.first('employees', { select: 'id', filter: { id: p.id, org_id: ctx.orgId } });
          if (!existing) throw new Error('ไม่พบข้อมูลบุคลากรที่ต้องการแก้ไข');
          return DB.updateById('employees', p.id, data);
        }

        // ตรวจรหัสซ้ำก่อน เพื่อให้ข้อความผิดพลาดอ่านเข้าใจ
        const dup = DB.first('employees', {
          select: 'id', filter: { org_id: ctx.orgId, emp_code: data.emp_code }
        });
        if (dup) throw new Error('รหัสบุคลากร ' + data.emp_code + ' ถูกใช้แล้ว');

        const created = DB.insert('employees', data);

        // สร้างการดำรงตำแหน่งแรกให้ทันทีถ้าส่งข้อมูลมาด้วย
        if (p.assignment && p.assignment.effective_from) {
          const a = Util.pick(p.assignment, [
            'facility_id','department_id','position_id','job_grade_id','supervisor_id',
            'employment_type','assignment_type','position_no','effective_from',
            'reason','order_no','order_date','base_salary','work_shift_id']);
          a.org_id = ctx.orgId;
          a.employee_id = created.id;
          DB.insert('employment_assignments', a);

          DB.insert('employment_events', {
            org_id: ctx.orgId, employee_id: created.id, event_type: 'HIRE',
            event_date: a.effective_from, title: 'บรรจุ/เริ่มปฏิบัติงาน',
            detail: a.reason || null, order_no: a.order_no || null
          });
        }

        return created;
      }
    },

    /** ประวัติการดำรงตำแหน่ง: เพิ่มแถวใหม่ (ปิดแถวเดิมให้อัตโนมัติ) */
    'employee.assignmentSave': {
      perm: 'employee.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'effective_from'], ['บุคลากร', 'มีผลตั้งแต่วันที่']);
        Auth.requireEmployee(ctx, p.employee_id);

        const data = Util.pick(p, [
          'employee_id','facility_id','department_id','position_id','job_grade_id',
          'supervisor_id','employment_type','assignment_type','position_no',
          'effective_from','effective_to','reason','order_no','order_date',
          'base_salary','work_shift_id']);
        data.org_id = ctx.orgId;

        if (p.id) return DB.updateById('employment_assignments', p.id, data);

        // ปิดแถวปัจจุบันก่อนเปิดแถวใหม่ (เฉพาะประเภทหลัก)
        if ((data.assignment_type || 'PRIMARY') === 'PRIMARY') {
          const current = DB.first('employment_assignments', {
            select: 'id,effective_from',
            filter: { employee_id: p.employee_id, assignment_type: 'PRIMARY', effective_to: null }
          });
          if (current) {
            if (current.effective_from >= data.effective_from) {
              throw new Error('วันที่มีผลต้องหลังจากการดำรงตำแหน่งปัจจุบัน (' + current.effective_from + ')');
            }
            DB.updateById('employment_assignments', current.id, {
              effective_to: Util.addDays(data.effective_from, -1)
            });
          }
        }
        return DB.insert('employment_assignments', data);
      }
    },

    /** ตารางลูก: การศึกษา / ใบประกอบวิชาชีพ / ครอบครัว / ประสบการณ์ / รางวัล */
    'employee.subSave': {
      perm: 'employee.write',
      fn: function (p, ctx) {
        const TABLES = {
          education:  { table: 'employee_educations',  cols: ['level','degree_name','major','institute','country','start_year','graduate_year','gpa','is_highest','attachment_url'] },
          license:    { table: 'employee_licenses',    cols: ['license_type','license_no','issuer','issue_date','expire_date','status','attachment_url'] },
          family:     { table: 'employee_families',    cols: ['relation','full_name','national_id','birth_date','occupation','phone','is_alive','is_dependent','is_beneficiary','note'] },
          experience: { table: 'employee_experiences', cols: ['organization','position_name','start_date','end_date','salary','duty','leave_reason','is_internal'] },
          contact:    { table: 'employee_contacts',    cols: ['contact_type','full_name','relation','phone','address'] },
          award:      { table: 'employee_awards',      cols: ['award_type','award_name','award_level','granted_date','announce_ref','granting_body','reward_amount','certificate_url','note'] }
        };

        Util.requireFields(p, ['kind', 'employee_id'], ['ประเภทข้อมูล', 'บุคลากร']);
        const def = TABLES[p.kind];
        if (!def) throw new Error('ประเภทข้อมูลไม่ถูกต้อง: ' + p.kind);
        Auth.requireEmployee(ctx, p.employee_id);

        const data = Util.pick(p.data || {}, def.cols);
        data.employee_id = p.employee_id;
        if (def.table === 'employee_awards') data.org_id = ctx.orgId;

        return p.id ? DB.updateById(def.table, p.id, data) : DB.insert(def.table, data);
      }
    },

    'employee.subDelete': {
      perm: 'employee.write',
      fn: function (p, ctx) {
        const TABLES = {
          education: 'employee_educations', license: 'employee_licenses',
          family: 'employee_families', experience: 'employee_experiences',
          contact: 'employee_contacts', award: 'employee_awards'
        };
        Util.requireFields(p, ['kind', 'id'], ['ประเภทข้อมูล', 'รายการ']);
        const table = TABLES[p.kind];
        if (!table) throw new Error('ประเภทข้อมูลไม่ถูกต้อง');

        const row = DB.first(table, { select: 'employee_id', filter: { id: p.id } });
        if (!row) throw new Error('ไม่พบรายการที่ต้องการลบ');
        Auth.requireEmployee(ctx, row.employee_id);

        return DB.remove(table, { id: p.id });
      }
    },

    /** อัปโหลดแฟ้มเอกสารบุคลากร (client ส่ง base64) */
    'employee.fileUpload': {
      perm: 'employee.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'file_name', 'content_base64'],
                              ['บุคลากร', 'ชื่อไฟล์', 'ไฟล์']);
        Auth.requireEmployee(ctx, p.employee_id);

        const bytes = Utilities.base64Decode(p.content_base64);
        const blob = Utilities.newBlob(bytes, p.mime_type || 'application/octet-stream', p.file_name);

        const path = ctx.orgId + '/' + p.employee_id + '/' +
                     Date.now() + '_' + p.file_name.replace(/[^\w.\-]/g, '_');
        DB.uploadFile('employee-files', path, blob, p.mime_type);

        return DB.insert('employee_files', {
          org_id: ctx.orgId,
          employee_id: p.employee_id,
          category: p.category || 'OTHER',
          file_name: p.file_name,
          storage_provider: 'SUPABASE',
          storage_path: 'employee-files/' + path,
          mime_type: p.mime_type || null,
          size_bytes: bytes.length,
          is_confidential: !!p.is_confidential,
          expire_date: p.expire_date || null,
          uploaded_by: ctx.userId
        });
      }
    },

    'employee.fileUrl': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['ไฟล์']);
        const f = DB.first('employee_files', { filter: { id: p.id } });
        if (!f) throw new Error('ไม่พบไฟล์');
        Auth.requireEmployee(ctx, f.employee_id);
        if (f.is_confidential && !Auth.can(ctx, 'employee.read_confidential')) {
          throw new Error('ไม่มีสิทธิเข้าถึงเอกสารลับ');
        }

        Auth.logAccess(ctx, {
          module: 'employee', action: 'DOWNLOAD', employeeId: f.employee_id,
          entityType: 'employee_files', entityId: f.id
        });

        const parts = String(f.storage_path).split('/');
        return { url: DB.signedUrl(parts.shift(), parts.join('/'), 600), file: f };
      }
    },

    /** ประวัติการแก้ไขข้อมูล (audit) ของบุคลากรรายนี้ */
    'employee.history': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['บุคลากร']);
        Auth.requireEmployee(ctx, p.id);
        return DB.rpc('fn_record_history', {
          p_table: 'employees', p_record_id: p.id, p_limit: p.limit || 50
        });
      }
    },

    /** ตัวเลือกสำหรับ dropdown ทั่วระบบ */
    'employee.options': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        return {
          facilities: DB.select('facilities', {
            select: 'id,code,name_th', filter: { org_id: ctx.orgId, is_active: true }, order: 'name_th' }),
          departments: DB.select('departments', {
            select: 'id,code,name_th,facility_id', filter: { org_id: ctx.orgId, is_active: true }, order: 'sort_order,name_th' }),
          positions: DB.select('positions', {
            select: 'id,code,name_th,job_family,employment_type', filter: { org_id: ctx.orgId, is_active: true }, order: 'name_th' }),
          grades: DB.select('job_grades', {
            select: 'id,code,name_th,grade_level', filter: { org_id: ctx.orgId, is_active: true }, order: 'grade_level' }),
          shifts: DB.select('work_shifts', {
            select: 'id,code,name_th,start_time,end_time', filter: { org_id: ctx.orgId, is_active: true }, order: 'code' }),
          leaveTypes: DB.select('leave_types', {
            select: 'id,code,name_th,category,unit,require_attachment,default_quota,color',
            filter: { org_id: ctx.orgId, is_active: true }, order: 'sort_order' })
        };
      }
    },

    /** ค้นหาบุคลากรแบบเบา (ใช้กับช่องเลือกผู้บังคับบัญชา/ผู้ปฏิบัติงานแทน) */
    'employee.lookup': {
      perm: 'employee.read',
      fn: function (p, ctx) {
        const opts = {
          select: 'employee_id,emp_code,full_name_th,position_name,department_name',
          filter: { org_id: ctx.orgId, employment_status: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] },
          order: 'emp_code', limit: p.limit || 20
        };
        if (p.q) {
          const q = String(p.q).trim().replace(/[(),]/g, '');
          opts.or = 'emp_code.ilike.*' + q + '*,full_name_th.ilike.*' + q + '*';
        }
        return DB.select('v_employee_current', opts);
      }
    }
  };
}
