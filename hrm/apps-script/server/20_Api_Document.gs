/**
 * HRM :: 20_Api_Document.gs
 * โมดูล 12 Document — แม่แบบเอกสาร / คำขอ / การออกเอกสาร / ตรวจสอบด้วย QR
 */

function routesDocument() {
  return {

    'document.templateList': {
      perm: 'document.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.selfServiceOnly) filter.is_self_service = true;
        if (p.activeOnly !== false) filter.is_active = true;
        return DB.select('document_templates', { filter: filter, order: 'doc_type,name_th' });
      }
    },

    'document.templateSave': {
      perm: 'document.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th', 'doc_type'], ['รหัส', 'ชื่อเอกสาร', 'ประเภท']);
        const data = Util.pick(p, ['code','name_th','doc_type','engine','template_ref','body_html',
                                   'merge_fields','number_seq_key','number_prefix',
                                   'requires_approval','signer_position','is_self_service','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('document_templates', p.id, data)
                    : DB.insert('document_templates', data);
      }
    },

    /** ขอเอกสาร (self-service) */
    'document.request': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['template_id', 'purpose'], ['ประเภทเอกสาร', 'วัตถุประสงค์']);
        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('document.write');
          Auth.requireEmployee(ctx, employeeId);
        }

        const tpl = DB.first('document_templates', {
          select: 'id,name_th,is_self_service,requires_approval',
          filter: { id: p.template_id, org_id: ctx.orgId, is_active: true }
        });
        if (!tpl) throw new Error('ไม่พบแม่แบบเอกสาร');
        if (!tpl.is_self_service && employeeId === ctx.employeeId &&
            !Auth.can(ctx, 'document.write')) {
          throw new Error('เอกสารประเภทนี้ต้องให้เจ้าหน้าที่บุคคลเป็นผู้ออก');
        }

        const req = DB.insert('document_requests', {
          org_id: ctx.orgId,
          employee_id: employeeId,
          template_id: p.template_id,
          request_no: Util.nextDocNo(ctx.orgId, 'DOCREQ', 'ขอ', Util.fiscalYear().toString(), 4),
          purpose: p.purpose,
          language: p.language || 'TH',
          copies: p.copies || 1,
          parameters: p.parameters || {},
          status: tpl.requires_approval ? 'PENDING' : 'APPROVED'
        });

        if (tpl.requires_approval) {
          Util.notify(ctx, {
            title: 'มีคำขอเอกสารรอดำเนินการ',
            body: tpl.name_th + ' — ' + p.purpose,
            entityType: 'document_requests', entityId: req.id
          });
        }
        return req;
      }
    },

    'document.requestList': {
      perm: null,
      fn: function (p, ctx) {
        const filter = {};
        if (p.mine || !Auth.can(ctx, 'document.read')) {
          if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
          filter.employee_id = ctx.employeeId;
        } else {
          filter.org_id = ctx.orgId;
          if (p.status) filter.status = p.status;
        }
        return DB.select('document_requests', {
          select: '*,document_templates(code,name_th,doc_type),' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'created_at.desc', limit: p.limit || 100
        });
      }
    },

    /**
     * ออกเอกสารจริง: รวมข้อมูล -> merge เข้าแม่แบบ -> สร้าง PDF ใน Drive -> ลงทะเบียน
     */
    'document.issue': {
      perm: 'document.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['request_id'], ['คำขอเอกสาร']);

        const req = DB.first('document_requests', {
          select: '*,document_templates(*)', filter: { id: p.request_id, org_id: ctx.orgId }
        });
        if (!req) throw new Error('ไม่พบคำขอเอกสาร');
        if (req.status === 'ISSUED') throw new Error('เอกสารนี้ออกไปแล้ว');
        if (req.status === 'REJECTED' || req.status === 'CANCELLED') {
          throw new Error('คำขอสถานะ ' + req.status + ' ออกเอกสารไม่ได้');
        }

        const tpl = req.document_templates;
        const data = buildDocumentData(ctx, req.employee_id, req);

        const docNo = Util.nextDocNo(ctx.orgId, tpl.number_seq_key || 'CERT',
                                     tpl.number_prefix || '', Util.fiscalYear().toString(), 4);
        data.document_no = docNo;
        data.issue_date_th = Util.thaiDate(Util.isoDate());

        const verifyCode = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
        data.verify_url = CFG.APP_URL + '?page=verify&code=' + verifyCode;

        let fileUrl = null;
        try {
          fileUrl = renderDocumentToDrive(tpl, data, docNo);
        } catch (e) {
          console.warn('สร้างไฟล์เอกสารไม่สำเร็จ: ' + e.message);
        }

        const issued = DB.insert('issued_documents', {
          org_id: ctx.orgId,
          facility_id: data.facility_id || null,
          employee_id: req.employee_id,
          template_id: tpl.id,
          request_id: req.id,
          document_no: docNo,
          doc_type: tpl.doc_type,
          title: tpl.name_th,
          issue_date: Util.isoDate(),
          content_snapshot: data,
          file_url: fileUrl,
          file_provider: 'DRIVE',
          verify_code: verifyCode,
          signed_by: p.signed_by || null,
          status: 'ISSUED'
        });

        DB.updateById('document_requests', req.id, {
          status: 'ISSUED', approved_by: ctx.userId, approved_at: new Date().toISOString()
        });

        Util.notify(ctx, {
          employeeId: req.employee_id,
          userId: Util.userIdOfEmployee(req.employee_id),
          title: 'เอกสารของคุณพร้อมแล้ว',
          body: tpl.name_th + ' เลขที่ ' + docNo,
          linkUrl: fileUrl,
          entityType: 'issued_documents', entityId: issued.id
        });

        Auth.logAccess(ctx, {
          module: 'document', action: 'PRINT', employeeId: req.employee_id,
          entityType: 'issued_documents', entityId: issued.id, purpose: req.purpose
        });

        return issued;
      }
    },

    'document.requestReject': {
      perm: 'document.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['request_id', 'reason'], ['คำขอ', 'เหตุผล']);
        return DB.update('document_requests', { id: p.request_id, org_id: ctx.orgId }, {
          status: 'REJECTED', reject_reason: p.reason,
          approved_by: ctx.userId, approved_at: new Date().toISOString()
        });
      }
    },

    'document.issuedList': {
      perm: 'document.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
        if (p.docType) filter.doc_type = p.docType;
        if (p.from && p.to) {
          filter.issue_date = [{ op: 'gte', value: p.from }, { op: 'lte', value: p.to }];
        }
        return DB.select('issued_documents', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'issue_date.desc', limit: p.limit || 100
        });
      }
    },

    'document.revoke': {
      perm: 'document.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'reason'], ['เอกสาร', 'เหตุผลการยกเลิก']);
        return DB.update('issued_documents', { id: p.id, org_id: ctx.orgId }, {
          status: 'REVOKED', revoke_reason: p.reason
        });
      }
    },

    /** ทะเบียนคำสั่งกลาง */
    'document.orderList': {
      perm: 'document.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.orderType) filter.order_type = p.orderType;
        if (p.year) {
          filter.order_date = [{ op: 'gte', value: p.year + '-01-01' },
                               { op: 'lte', value: p.year + '-12-31' }];
        }
        return DB.select('personnel_orders', {
          filter: filter, order: 'order_date.desc', limit: p.limit || 200
        });
      }
    },

    'document.orderSave': {
      perm: 'document.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['order_type', 'subject'], ['ประเภทคำสั่ง', 'เรื่อง']);
        const data = Util.pick(p, ['facility_id','order_no','order_date','order_type','subject',
                                   'detail','effective_date','employee_ids','reference_table',
                                   'reference_id','signed_by','file_url','status']);
        data.org_id = ctx.orgId;
        if (!data.order_no && !p.id) {
          data.order_no = Util.nextDocNo(ctx.orgId, 'ORDER', 'คส.', Util.fiscalYear().toString(), 4);
        }
        return p.id ? DB.updateById('personnel_orders', p.id, data)
                    : DB.insert('personnel_orders', data);
      }
    }
  };
}

/** รวบรวมข้อมูลสำหรับ merge ลงเอกสาร */
function buildDocumentData(ctx, employeeId, request) {
  const v = DB.first('v_employee_current', { filter: { employee_id: employeeId } });
  if (!v) throw new Error('ไม่พบข้อมูลบุคลากร');

  const org = DB.first('organizations', {
    select: 'name_th,address,contact,logo_url', filter: { id: ctx.orgId }
  });

  const data = {
    org_name: org ? org.name_th : '',
    org_logo: org ? org.logo_url : '',
    facility_id: v.facility_id,
    facility_name: v.facility_name || '',
    emp_code: v.emp_code,
    full_name: v.full_name_th,
    national_id: v.national_id || '',
    position_name: v.position_name || '',
    grade_name: v.grade_name || '',
    department_name: v.department_name || '',
    employment_type: v.employment_type || '',
    hire_date: v.hire_date || '',
    hire_date_th: Util.thaiDate(v.hire_date),
    service_length: v.service_length_text || '',
    purpose: request ? request.purpose : '',
    today_th: Util.thaiDate(Util.isoDate())
  };

  // เงินเดือนใส่เฉพาะหนังสือรับรองเงินเดือน
  const tplType = request && request.document_templates ? request.document_templates.doc_type : '';
  if (tplType === 'SALARY_CERT') {
    data.base_salary = Number(v.base_salary || 0);
    data.base_salary_text = Util.money(data.base_salary);
    data.base_salary_baht = Util.bahtText(data.base_salary);
  }

  // ค่าเพิ่มเติมที่ผู้ขอกรอกเอง
  if (request && request.parameters) {
    Object.keys(request.parameters).forEach(function (k) {
      if (data[k] === undefined) data[k] = request.parameters[k];
    });
  }
  return data;
}

/** สร้างไฟล์เอกสารใน Google Drive แล้วคืน URL */
function renderDocumentToDrive(tpl, data, docNo) {
  if (!CFG.DRIVE_FOLDER_ID) return null;
  const folder = DriveApp.getFolderById(CFG.DRIVE_FOLDER_ID);
  const fileName = (tpl.code || 'DOC') + '_' + docNo.replace(/[\/\s]/g, '-');

  if (tpl.engine === 'GDOC' && tpl.template_ref) {
    // คัดลอกแม่แบบ Google Docs แล้วแทนที่ตัวแปร {{key}}
    const copy = DriveApp.getFileById(tpl.template_ref).makeCopy(fileName, folder);
    const doc = DocumentApp.openById(copy.getId());
    const body = doc.getBody();
    Object.keys(data).forEach(function (k) {
      body.replaceText('\\{\\{' + k + '\\}\\}', String(data[k] === null ? '' : data[k]));
    });
    doc.saveAndClose();
    const pdf = folder.createFile(copy.getAs('application/pdf').setName(fileName + '.pdf'));
    copy.setTrashed(true);
    return pdf.getUrl();
  }

  // engine = HTML : แทนที่ตัวแปรแล้วแปลงเป็น PDF
  let html = tpl.body_html || defaultCertificateHtml();
  Object.keys(data).forEach(function (k) {
    html = html.replace(new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'g'),
                        String(data[k] === null || data[k] === undefined ? '' : data[k]));
  });
  html = html.replace(/\{\{\s*\w+\s*\}\}/g, '');   // ตัวแปรที่เหลือให้ว่าง

  const blob = Utilities.newBlob(html, 'text/html', fileName + '.html')
                        .getAs('application/pdf').setName(fileName + '.pdf');
  return folder.createFile(blob).getUrl();
}

/** แม่แบบ HTML สำรอง เมื่อยังไม่ได้กำหนด body_html */
function defaultCertificateHtml() {
  return '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:"Sarabun","TH SarabunPSK",sans-serif;font-size:16pt;' +
    'line-height:1.8;margin:2.5cm 2cm;}' +
    '.center{text-align:center}.right{text-align:right}.indent{text-indent:2.5cm}' +
    'h1{font-size:20pt;margin-bottom:.2em}.no{margin-top:0}' +
    '</style></head><body>' +
    '<div class="center"><h1>{{org_name}}</h1>' +
    '<div class="no">{{facility_name}}</div></div>' +
    '<p class="right">ที่ {{document_no}}</p>' +
    '<h2 class="center">{{title}}</h2>' +
    '<p class="indent">หนังสือฉบับนี้ให้ไว้เพื่อรับรองว่า {{full_name}} ' +
    'รหัสประจำตัว {{emp_code}} ปัจจุบันปฏิบัติงานในตำแหน่ง {{position_name}} ' +
    'สังกัด {{department_name}} {{facility_name}} ' +
    'เริ่มปฏิบัติงานตั้งแต่วันที่ {{hire_date_th}} รวมอายุงาน {{service_length}}</p>' +
    '<p class="indent">ออกให้เพื่อ {{purpose}}</p>' +
    '<p class="right">ให้ไว้ ณ วันที่ {{issue_date_th}}</p>' +
    '<p class="center" style="margin-top:3em">(ลงชื่อ) ..................................</p>' +
    '<p class="center">ตรวจสอบเอกสาร: {{verify_url}}</p>' +
    '</body></html>';
}

/** ใช้โดยหน้า Verify (ไม่ต้องล็อกอิน) */
function verifyDocument(code) {
  if (!code) return { valid: false, message: 'ไม่ได้ระบุรหัสตรวจสอบ' };
  try {
    const doc = DB.first('issued_documents', {
      select: 'document_no,title,issue_date,status,employees(emp_code,first_name_th,last_name_th)',
      filter: { verify_code: String(code).toUpperCase() }
    });
    if (!doc) return { valid: false, message: 'ไม่พบเอกสารที่ตรงกับรหัสนี้' };
    if (doc.status === 'REVOKED') {
      return { valid: false, message: 'เอกสารฉบับนี้ถูกยกเลิกแล้ว', document: doc };
    }
    const emp = doc.employees || {};
    return {
      valid: true,
      document: {
        document_no: doc.document_no,
        title: doc.title,
        issue_date_th: Util.thaiDate(doc.issue_date),
        employee_name: [emp.first_name_th, emp.last_name_th].filter(String).join(' '),
        status: doc.status
      }
    };
  } catch (e) {
    return { valid: false, message: 'ตรวจสอบไม่สำเร็จ: ' + e.message };
  }
}
