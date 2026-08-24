/**
 * HRM :: 90_Triggers.gs
 * งานอัตโนมัติตามเวลา — ติดตั้งครั้งเดียวด้วย installTriggers()
 */

/** ติดตั้งทริกเกอร์ทั้งหมด (ลบของเดิมก่อนกันซ้ำ) */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('jobSendNotifications').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('jobNightlyAttendance').timeBased().atHour(1).everyDays(1).create();
  ScriptApp.newTrigger('jobDailyAlerts').timeBased().atHour(7).everyDays(1).create();
  ScriptApp.newTrigger('jobWeeklyDigest').timeBased()
           .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  ScriptApp.newTrigger('jobFiscalYearRollover').timeBased()
           .onMonthDay(1).atHour(2).create();

  Logger.log('ติดตั้งทริกเกอร์แล้ว ' + ScriptApp.getProjectTriggers().length + ' รายการ');
}

/** ส่งการแจ้งเตือนที่ค้างอยู่ในคิว */
function jobSendNotifications() {
  const pending = DB.select('notifications', {
    select: 'id,user_id,employee_id,channel,title,body,link_url',
    filter: { status: 'PENDING', channel: ['EMAIL', 'LINE'],
              scheduled_at: { op: 'lte', value: new Date().toISOString() } },
    order: 'scheduled_at', limit: 50
  });

  pending.forEach(function (n) {
    try {
      if (n.channel === 'EMAIL') {
        const email = resolveEmail(n);
        if (!email) throw new Error('ไม่พบอีเมลผู้รับ');
        MailApp.sendEmail({
          to: email,
          subject: '[' + CFG.APP_NAME + '] ' + n.title,
          htmlBody: '<div style="font-family:sans-serif;line-height:1.7">' +
                    '<h3 style="color:#1f6b47;margin:0 0 8px">' + escapeHtml(n.title) + '</h3>' +
                    '<p>' + escapeHtml(n.body || '').replace(/\n/g, '<br>') + '</p>' +
                    (n.link_url ? '<p><a href="' + n.link_url +
                      '" style="background:#1f6b47;color:#fff;padding:9px 16px;' +
                      'border-radius:8px;text-decoration:none">เปิดในระบบ</a></p>' : '') +
                    '<hr style="border:none;border-top:1px solid #dfe0d5;margin:16px 0">' +
                    '<small style="color:#6b7a70">อีเมลนี้ส่งอัตโนมัติจาก ' +
                    CFG.APP_NAME + ' กรุณาอย่าตอบกลับ</small></div>'
        });
      } else if (n.channel === 'LINE' && CFG.LINE_TOKEN) {
        UrlFetchApp.fetch('https://notify-api.line.me/api/notify', {
          method: 'post',
          headers: { 'Authorization': 'Bearer ' + CFG.LINE_TOKEN },
          payload: { message: '\n' + n.title + '\n' + (n.body || '') },
          muteHttpExceptions: true
        });
      }
      DB.updateById('notifications', n.id, {
        status: 'SENT', sent_at: new Date().toISOString()
      });
    } catch (e) {
      DB.updateById('notifications', n.id, { status: 'FAILED', error_message: e.message });
    }
  });
}

function resolveEmail(n) {
  if (n.user_id) {
    const u = DB.first('app_users', { select: 'email', filter: { id: n.user_id } });
    if (u && u.email) return u.email;
  }
  if (n.employee_id) {
    const e = DB.first('employees', {
      select: 'email_work,email', filter: { id: n.employee_id }
    });
    if (e) return e.email_work || e.email;
  }
  return null;
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** คำนวณสรุปเวลาของเมื่อวานให้ทุกองค์กร */
function jobNightlyAttendance() {
  const yesterday = Util.addDays(Util.isoDate(), -1);
  DB.select('organizations', { select: 'id,name_th', filter: { is_active: true } })
    .forEach(function (org) {
      try {
        const n = DB.rpc('fn_recalc_attendance_range', {
          p_org_id: org.id, p_from: yesterday, p_to: yesterday, p_facility_id: null
        });
        console.log('[attendance] ' + org.name_th + ' คำนวณ ' + n + ' รายการ');
      } catch (e) {
        console.error('[attendance] ' + org.name_th + ' ล้มเหลว: ' + e.message);
      }
    });
}

/** แจ้งเตือนรายการที่ใกล้ครบกำหนด */
function jobDailyAlerts() {
  DB.select('organizations', { select: 'id', filter: { is_active: true } }).forEach(function (org) {
    try {
      const alerts = DB.select('v_compliance_alerts', {
        filter: { org_id: org.id, severity: ['CRITICAL', 'HIGH'] }, limit: 200
      });

      alerts.forEach(function (a) {
        // แจ้งเจ้าตัว 1 ครั้งต่อรายการต่อวัน
        const dup = DB.first('notifications', {
          select: 'id',
          filter: {
            employee_id: a.employee_id, entity_type: a.alert_type,
            created_at: { op: 'gte', value: Util.isoDate() + 'T00:00:00Z' }
          }
        });
        if (dup) return;

        DB.insert('notifications', {
          org_id: org.id,
          employee_id: a.employee_id,
          user_id: Util.userIdOfEmployee(a.employee_id),
          channel: 'EMAIL',
          title: alertTitle(a.alert_type),
          body: a.detail + ' — ครบกำหนดวันที่ ' + Util.thaiDate(a.due_date) +
                (a.days_remaining !== null ? ' (อีก ' + a.days_remaining + ' วัน)' : ''),
          entity_type: a.alert_type
        });
      });
    } catch (e) {
      console.error('[alerts] ' + e.message);
    }
  });
}

function alertTitle(type) {
  const map = {
    LICENSE_EXPIRING:   'ใบประกอบวิชาชีพใกล้หมดอายุ',
    PROBATION_DUE:      'ครบกำหนดทดลองปฏิบัติงาน',
    RETIREMENT_DUE:     'ใกล้ครบเกษียณอายุราชการ',
    TRAINING_EXPIRING:  'ใบรับรองการอบรมใกล้หมดอายุ',
    HEALTH_CHECKUP_DUE: 'ยังไม่ได้ตรวจสุขภาพประจำปี'
  };
  return map[type] || 'มีรายการที่ต้องดำเนินการ';
}

/** สรุปงานค้างส่งหัวหน้างานทุกวันจันทร์ */
function jobWeeklyDigest() {
  DB.select('organizations', { select: 'id', filter: { is_active: true } }).forEach(function (org) {
    try {
      const pending = DB.select('leave_requests', {
        select: 'employee_id,request_no,start_date,end_date,total_days',
        filter: { org_id: org.id, status: 'PENDING' }, limit: 500
      });
      if (!pending.length) return;

      // จัดกลุ่มตามผู้บังคับบัญชา
      const empIds = pending.map(function (r) { return r.employee_id; });
      const supMap = {};
      DB.select('v_employee_current', {
        select: 'employee_id,supervisor_id,full_name_th', filter: { employee_id: empIds }
      }).forEach(function (e) { supMap[e.employee_id] = e; });

      const bySup = {};
      pending.forEach(function (r) {
        const e = supMap[r.employee_id];
        if (!e || !e.supervisor_id) return;
        (bySup[e.supervisor_id] = bySup[e.supervisor_id] || []).push(
          e.full_name_th + ' — ' + r.total_days + ' วัน (' +
          Util.thaiDate(r.start_date, true) + ' ถึง ' + Util.thaiDate(r.end_date, true) + ')');
      });

      Object.keys(bySup).forEach(function (supId) {
        DB.insert('notifications', {
          org_id: org.id,
          employee_id: supId,
          user_id: Util.userIdOfEmployee(supId),
          channel: 'EMAIL',
          title: 'สรุปใบลารออนุมัติ ' + bySup[supId].length + ' รายการ',
          body: bySup[supId].join('\n'),
          linkUrl: CFG.APP_URL
        });
      });
    } catch (e) {
      console.error('[digest] ' + e.message);
    }
  });
}

/** ต้นปีงบประมาณ (1 ต.ค.) — ตั้งสิทธิวันลาปีใหม่ให้ทุกองค์กร */
function jobFiscalYearRollover() {
  const now = new Date();
  if (now.getMonth() !== 9 || now.getDate() !== 1) return;   // เฉพาะ 1 ตุลาคม

  const fy = Util.fiscalYear();
  DB.select('organizations', { select: 'id,name_th', filter: { is_active: true } })
    .forEach(function (org) {
      try {
        const n = DB.rpc('fn_generate_leave_entitlements', {
          p_org_id: org.id, p_period_year: fy
        });
        console.log('[rollover] ' + org.name_th + ' ตั้งสิทธิวันลาปี ' + fy + ' จำนวน ' + n + ' รายการ');
      } catch (e) {
        console.error('[rollover] ' + org.name_th + ' ล้มเหลว: ' + e.message);
      }
    });
}
