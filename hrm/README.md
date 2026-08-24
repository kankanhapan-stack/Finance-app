# HRM — ระบบบริหารงานบุคคล

ระบบบริหารงานบุคคลแบบครบวงจร ทำงานบน **Google Apps Script** (runtime + web app)
และใช้ **Supabase (PostgreSQL)** เป็นฐานข้อมูล ออกแบบให้รองรับ
**หลายหน่วยงาน / หลายสถานบริการ** ตั้งแต่ต้น และต่อยอดเป็นระบบออนไลน์เต็มรูปแบบได้

> แนวคิดหลัก: **“ข้อมูลบุคลากรครั้งเดียว ใช้ได้ทุกกระบวนงาน”**
> รับสมัคร → บรรจุ → บันทึกประวัติ → ลงเวลา → ลา → ประเมิน → ฝึกอบรม → เงินเดือน →
> เลื่อนตำแหน่ง → ย้าย → พ้นสภาพ/เกษียณ → เก็บประวัติ

---

## สารบัญเอกสาร

| เอกสาร | เนื้อหา |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | สถาปัตยกรรม 3 ชั้น กระแสข้อมูล และเหตุผลของการออกแบบ |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | พจนานุกรมข้อมูล 97 ตาราง จัดกลุ่มตามโมดูล |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | ขั้นตอนติดตั้งตั้งแต่ศูนย์จนใช้งานได้จริง |
| [docs/SECURITY.md](docs/SECURITY.md) | โมเดลสิทธิ RBAC + RLS, Audit, PDPA |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | งานประจำวัน/เดือน/ปี และการแก้ปัญหาที่พบบ่อย |

---

## โมดูลหลัก 15 ระบบ

| # | โมดูล | ความสามารถ | ตารางหลัก |
|---|---|---|---|
| 01 | **Dashboard** | ภาพรวมกำลังคน KPI งานค้าง แนวโน้ม | `fn_dashboard_summary` |
| 02 | **Organization** | องค์กร → สถานบริการ → หน่วยงาน → ตำแหน่ง → กรอบอัตรากำลัง | `organizations` `facilities` `departments` `positions` `position_slots` |
| 03 | **Employee** | ทะเบียนประวัติ + ประวัติการดำรงตำแหน่งตามช่วงเวลา | `employees` `employment_assignments` `employment_events` |
| 04 | **Recruitment** | คำขออัตรากำลัง → ประกาศ → ใบสมัคร → คัดเลือก → บรรจุ | `job_postings` `applicants` `applications` |
| 05 | **Time Attendance** | กะ/ตารางเวร/ลงเวลา GPS/สรุปสาย-ขาด-ล่วงเวลา | `work_shifts` `time_logs` `attendance_daily` |
| 06 | **Leave** | ประเภทลาตามระเบียบราชการ/สิทธิ/ใบลา/สายอนุมัติ | `leave_types` `leave_entitlements` `leave_requests` |
| 07 | **Payroll** | งวดจ่าย/ประมวลผล/สลิป/ภาษี/ไฟล์ธนาคาร | `payroll_periods` `payroll_runs` `payroll_slips` |
| 08 | **Benefits** | แผนสวัสดิการ/เบิกจ่าย/เงินกู้/ตรวจสุขภาพ | `benefit_plans` `benefit_claims` `employee_loans` |
| 09 | **Performance** | รอบประเมิน/KPI/ผลสัมฤทธิ์ 70 + สมรรถนะ 30/เลื่อนขั้น | `appraisal_cycles` `appraisals` `merit_increases` |
| 10 | **Training** | หลักสูตร/รุ่นอบรม/ลงทะเบียน/ประวัติ | `training_courses` `training_sessions` `training_records` |
| 11 | **Career** | เส้นทางความก้าวหน้า/คำสั่งเลื่อน-ย้าย/แผนสืบทอด | `career_paths` `career_movements` `succession_plans` |
| 12 | **Document** | แม่แบบ/คำขอ/ออกหนังสือรับรอง/ตรวจสอบด้วย QR | `document_templates` `issued_documents` |
| 13 | **Discipline** | เรื่องวินัย/สอบสวน/โทษ/ทะเบียนคำสั่ง | `discipline_cases` `discipline_actions` `personnel_orders` |
| 14 | **Offboarding** | ลาออก/เกษียณ/เคลียร์ของ/สัมภาษณ์ก่อนลาออก | `separation_requests` `clearance_items` |
| 15 | **Reports** | รายงานมาตรฐาน 11 ฉบับ + ส่งออก CSV/Google Sheets | view `v_*` |

เสริม: **Audit Log** (บันทึกทุกการเปลี่ยนแปลง + PDPA) และ **Admin** (ผู้ใช้/บทบาท/สายอนุมัติ)

---

## โครงสร้างโปรเจกต์

```
hrm/
├── supabase/
│   ├── sql/                    ← สคีมาฐานข้อมูล รันตามลำดับเลขไฟล์
│   │   ├── 01_core.sql             tenancy, RBAC, approval engine, เลขที่เอกสาร
│   │   ├── 02_employee.sql         ทะเบียนประวัติ + assignment แบบ effective-dated
│   │   ├── 03_recruitment.sql      รับสมัคร + fn_hire_applicant()
│   │   ├── 04_time_attendance.sql  กะ/เวลา + fn_recalc_attendance()
│   │   ├── 05_leave.sql            ลา + fn_submit_leave_request() / fn_act_leave_request()
│   │   ├── 06_payroll.sql          เงินเดือน + fn_payroll_input() / fn_payroll_finalize()
│   │   ├── 07_benefits.sql         สวัสดิการ
│   │   ├── 08_performance.sql      ประเมินผล + fn_calc_appraisal_score()
│   │   ├── 09_training_career.sql  อบรม/IDP/ความก้าวหน้า + fn_apply_career_movement()
│   │   ├── 10_document_...sql      เอกสาร/วินัย/พ้นสภาพ + fn_complete_separation()
│   │   ├── 11_audit.sql            audit trigger กลาง (append-only)
│   │   ├── 12_views_reports.sql    view รายงาน + fn_dashboard_summary()
│   │   ├── 13_rls.sql              Row Level Security 2 ชั้น
│   │   └── 14_seed.sql             สิทธิ/บทบาท/ประเภทลา/กะ/ภาษี/แม่แบบเอกสาร
│   └── tests/
│       ├── smoke_test.sql          ทดสอบเส้นทางหลักตั้งแต่รับสมัครถึงพ้นสภาพ
│       └── run_all.sh              ลงสคีมาทั้งหมด + smoke test
│
├── apps-script/
│   ├── appsscript.json         manifest (timezone, scopes, web app)
│   ├── server/                 โค้ดฝั่ง server (.gs)
│   │   ├── 00_Config.gs            อ่านค่าจาก Script Properties
│   │   ├── 01_Supabase.gs          ชั้นเดียวที่คุยฐานข้อมูล
│   │   ├── 02_Auth.gs              ด่านบังคับสิทธิเพียงจุดเดียว
│   │   ├── 03_Util.gs              วันที่ไทย/ตัวเลข/ตรวจข้อมูล/แจ้งเตือน
│   │   ├── 04_Main.gs              doGet + API router
│   │   ├── 10–24_Api_*.gs          API รายโมดูล
│   │   ├── 25_Api_Public.gs        ช่องทางสาธารณะ (สมัครงาน/ตรวจเอกสาร)
│   │   └── 90_Triggers.gs          งานอัตโนมัติตามเวลา
│   ├── client/                 หน้าเว็บ (HtmlService)
│   │   ├── Index.html / Styles.html / Core.html / Shell.html
│   │   ├── ViewsCore / ViewsPeople / ViewsWork / ViewsAdmin.html
│   │   └── PublicJobs.html / Verify.html
│   └── tests/
│       ├── harness.js              รันโค้ด .gs ใน Node พร้อม stub ของ Google Services
│       ├── run_tests.js            ทดสอบตรรกะ 36 กรณี
│       └── check_wiring.js         ตรวจความสอดคล้อง client ↔ server ↔ SQL
└── docs/
```

---

## เริ่มใช้งานอย่างเร็ว

```bash
# 1) ฐานข้อมูล — รันบน Supabase SQL Editor หรือ psql ตามลำดับไฟล์
DB_URL="postgres://postgres:PASSWORD@db.xxxxx.supabase.co:5432/postgres" \
  ./hrm/supabase/tests/run_all.sh

# 2) Apps Script — สร้างโปรเจกต์ใหม่ วางไฟล์จาก apps-script/ แล้วตั้ง Script Properties
#    SUPABASE_URL / SUPABASE_SERVICE_KEY / DEFAULT_ORG_CODE

# 3) ติดตั้งงานอัตโนมัติ (รันครั้งเดียวใน Apps Script editor)
installTriggers()

# 4) Deploy เป็น Web app แล้วเปิดใช้งาน
```

รายละเอียดครบถ้วนอยู่ใน [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## การทดสอบ

```bash
# ตรรกะฝั่ง server (ไม่ต้อง deploy) — 36 กรณี
node hrm/apps-script/tests/run_tests.js

# ความสอดคล้องระหว่าง client / server / SQL
node hrm/apps-script/tests/check_wiring.js

# ฐานข้อมูล: ลงสคีมาทั้งหมดแล้วเดินเส้นทางหลักตั้งแต่รับสมัครถึงพ้นสภาพ
DB_URL="postgres://..." ./hrm/supabase/tests/run_all.sh
```

ผลล่าสุด: schema ลงครบ 14 ไฟล์ (97 ตาราง / 15 view / 147 policy),
smoke test ผ่านทั้งหมด, unit test 36/36, wiring check ผ่านทุกหมวด

---

## เทคโนโลยีและข้อจำกัดที่ควรรู้

| หัวข้อ | รายละเอียด |
|---|---|
| Runtime | Google Apps Script (V8) — โควตา `UrlFetchApp` 20,000 ครั้ง/วัน, สคริปต์ทำงานได้ครั้งละไม่เกิน 6 นาที |
| ฐานข้อมูล | Supabase PostgreSQL ผ่าน PostgREST |
| การยืนยันตัวตน | บัญชี Google ของผู้ใช้ (`Session.getActiveUser`) เทียบกับตาราง `app_users` |
| ไฟล์แนบ | Supabase Storage (แฟ้มบุคลากร) และ Google Drive (เอกสารที่ระบบสร้าง) |
| เขตเวลา | `Asia/Bangkok` ทั้งระบบ · ปีงบประมาณ 1 ต.ค. – 30 ก.ย. |

**ข้อจำกัดที่ออกแบบรองรับไว้แล้ว**
- การประมวลผลเงินเดือนจำนวนมากอาจชนเพดาน 6 นาที → แบ่งรอบตามสถานบริการได้ผ่าน `payroll_runs.facility_id`
- Apps Script ใช้ `service_role` key ซึ่งข้าม RLS → การบังคับสิทธิจึงรวมศูนย์อยู่ที่ `02_Auth.gs`
  และมี RLS เป็นชั้นที่สองรอไว้สำหรับตอนเปิดให้เข้าตรงผ่าน Supabase Auth
