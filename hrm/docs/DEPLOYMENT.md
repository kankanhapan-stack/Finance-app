# คู่มือติดตั้งระบบ HRM

ใช้เวลาประมาณ 45–60 นาทีสำหรับการติดตั้งครั้งแรก

---

## สิ่งที่ต้องเตรียม

| รายการ | หมายเหตุ |
|---|---|
| บัญชี Supabase | แผนฟรีใช้ได้สำหรับหน่วยงานขนาดเล็ก–กลาง |
| บัญชี Google (Workspace แนะนำ) | ใช้สร้าง Apps Script และเป็นตัวยืนยันตัวตนของผู้ใช้ |
| โฟลเดอร์ Google Drive | สำหรับเก็บเอกสารที่ระบบสร้าง (หนังสือรับรอง/รายงาน) |
| `psql` หรือ Supabase SQL Editor | สำหรับรันสคีมา |

---

## ขั้นที่ 1 — สร้างฐานข้อมูล Supabase

### 1.1 สร้างโปรเจกต์

1. เข้า https://supabase.com → **New project**
2. ตั้งชื่อ เลือก region **Southeast Asia (Singapore)** (ใกล้ไทยที่สุด)
3. ตั้งรหัสผ่านฐานข้อมูลและเก็บไว้ให้ดี
4. รอสร้างเสร็จประมาณ 2 นาที

### 1.2 รันสคีมา

**วิธีที่ 1 — ใช้สคริปต์ (แนะนำ เพราะรันทดสอบให้ด้วย)**

```bash
export DB_URL="postgres://postgres:[รหัสผ่าน]@db.[project-ref].supabase.co:5432/postgres"
./hrm/supabase/tests/run_all.sh
```

สคริปต์จะลงไฟล์ `01` ถึง `14` ตามลำดับ แล้วรัน smoke test ที่เดินเส้นทาง
ตั้งแต่รับสมัคร → บรรจุ → ลงเวลา → ลา → เลื่อนตำแหน่ง → เงินเดือน → ประเมิน →
พ้นสภาพ → ตรวจ audit ทั้งหมดอยู่ใน transaction ที่ rollback ท้ายสุด
จึงไม่ทิ้งข้อมูลทดสอบไว้

**วิธีที่ 2 — ผ่าน Supabase SQL Editor**

เปิดไฟล์ใน `hrm/supabase/sql/` แล้ววางรันทีละไฟล์ **ตามลำดับเลข**
(ลำดับสำคัญ เพราะไฟล์หลังอ้าง FK ของไฟล์ก่อน)

> หากเจอ error `role "service_role" does not exist` แปลว่ารันบน PostgreSQL
> ธรรมดาที่ไม่ใช่ Supabase ให้สร้าง role ทั้งสามก่อน (สคริปต์ `run_all.sh` ทำให้แล้ว)

### 1.3 ตรวจผล

```sql
select count(*) as tables   from pg_tables  where schemaname = 'public';   -- 97
select count(*) as views    from pg_views   where schemaname = 'public';   -- 15
select count(*) as policies from pg_policies where schemaname = 'public';  -- 147
select count(*) as perms    from permissions;                              -- 48
```

### 1.4 สร้าง Storage bucket สำหรับแฟ้มเอกสารบุคลากร

Supabase → **Storage** → **New bucket**
- ชื่อ: `employee-files`
- **Public bucket: ปิด** (สำคัญมาก — แฟ้มบุคลากรต้องไม่เปิดสาธารณะ)

ระบบเข้าถึงไฟล์ผ่าน signed URL อายุ 10 นาทีเท่านั้น

### 1.5 เก็บ key ที่ต้องใช้

Supabase → **Project Settings** → **API**

| key | ใช้ที่ไหน | ระดับความลับ |
|---|---|---|
| Project URL | `SUPABASE_URL` | เปิดเผยได้ |
| `anon` public | `SUPABASE_ANON_KEY` | เปิดเผยได้ |
| `service_role` | `SUPABASE_SERVICE_KEY` | **ห้ามหลุด** — ข้าม RLS ได้ทั้งระบบ |

> `service_role` key เก็บใน Script Properties ของ Apps Script เท่านั้น
> ห้ามใส่ในโค้ด ห้าม commit ลง git และห้ามส่งไปฝั่งหน้าเว็บ

---

## ขั้นที่ 2 — ตั้งค่าองค์กรของท่าน

ไฟล์ `14_seed.sql` สร้างองค์กรตัวอย่างไว้ให้ทดลองใช้ เมื่อจะใช้งานจริง
ให้แก้เป็นข้อมูลของหน่วยงานท่าน:

```sql
-- 2.1 แก้ข้อมูลองค์กร
update organizations
   set code    = 'CUP-XXXX',
       name_th = 'เครือข่ายบริการสุขภาพอำเภอ...',
       settings = settings || jsonb_build_object(
         'retirement_age', 60,
         'work_days_per_week', 5)
 where id = '22222222-0000-0000-0000-000000000001';

-- 2.2 แก้/เพิ่มสถานบริการ พร้อมพิกัดสำหรับตรวจการลงเวลา
update facilities
   set code = '10999', name_th = 'โรงพยาบาล...',
       geo = jsonb_build_object('lat', 13.7563, 'lng', 100.5018, 'radius_m', 300)
 where id = '33333333-0000-0000-0000-000000000001';

-- 2.3 วันหยุดราชการของปีปัจจุบัน (seed ใส่ตัวอย่างปี 2569 ไว้)
insert into holidays (org_id, holiday_date, name_th, holiday_type)
values ('22222222-0000-0000-0000-000000000001', '2027-01-01', 'วันขึ้นปีใหม่', 'PUBLIC');
```

จากนั้นเพิ่มหน่วยงาน ตำแหน่ง และระดับให้ตรงกับโครงสร้างจริง
(ทำผ่านหน้าจอ **โมดูล 02 โครงสร้างองค์กร** ได้หลังติดตั้ง Apps Script เสร็จ)

---

## ขั้นที่ 3 — สร้างโปรเจกต์ Apps Script

### 3.1 สร้างโปรเจกต์

1. เข้า https://script.google.com → **New project**
2. ตั้งชื่อ เช่น `HRM - ระบบบริหารงานบุคคล`

### 3.2 วางไฟล์

**วิธีที่ 1 — ใช้ clasp (แนะนำ เพราะไม่ต้องคัดลอกทีละไฟล์)**

```bash
npm install -g @google/clasp
clasp login
cd hrm/apps-script
clasp create --title "HRM" --type webapp
clasp push
```

โครงสร้างไฟล์จะถูกส่งขึ้นตามนี้:
- `server/*.gs` → ไฟล์ Script
- `client/*.html` → ไฟล์ HTML
- `appsscript.json` → manifest

**วิธีที่ 2 — คัดลอกด้วยมือ**

สร้างไฟล์ในโปรเจกต์ให้ครบตามรายการ โดย**ต้องคงชื่อเดิมทั้งหมด**
เพราะโค้ดอ้างชื่อไฟล์ผ่าน `include('client/Styles')` และ Apps Script
โหลดไฟล์ `.gs` ตามลำดับตัวอักษร (เลขนำหน้าจึงมีความหมาย)

> เปิด **Project Settings → Show "appsscript.json" manifest file** ก่อน
> จึงจะแก้ manifest ได้

### 3.3 ตั้งค่า Script Properties

**Project Settings → Script Properties → Add script property**

| Property | ค่า | บังคับ |
|---|---|:---:|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | ✔ |
| `SUPABASE_SERVICE_KEY` | service_role key | ✔ |
| `SUPABASE_ANON_KEY` | anon key | |
| `DEFAULT_ORG_CODE` | รหัสองค์กร เช่น `CUP-XXXX` | ✔ |
| `DRIVE_FOLDER_ID` | id โฟลเดอร์ Drive เก็บเอกสาร | |
| `APP_NAME` | ชื่อที่แสดงบนหัวเว็บ | |
| `SESSION_HOURS` | อายุ session (ค่าเริ่มต้น 12) | |
| `DEBUG` | `true` เพื่อดู log ละเอียดตอนติดตั้ง | |

หรือแก้ค่าในฟังก์ชัน `setupConfig()` (`00_Config.gs`) แล้วกด Run หนึ่งครั้ง
แล้ว**ลบค่าจริงออกจากโค้ดทันที**

### 3.4 หา DRIVE_FOLDER_ID

สร้างโฟลเดอร์ใน Google Drive แล้วดู URL:
```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       └────────── นี่คือ id ──────────┘
```

---

## ขั้นที่ 4 — สร้างผู้ใช้คนแรก

ระบบยืนยันตัวตนด้วยบัญชี Google เทียบกับตาราง `app_users`
ผู้ใช้คนแรกต้องสร้างผ่าน SQL เพราะยังเข้าหน้าเว็บไม่ได้:

```sql
-- 4.1 สร้างบัญชีผู้ดูแลระบบ (ใช้อีเมล Google จริงของท่าน)
insert into app_users (id, org_id, email, google_email, display_name, status, is_superadmin)
values ('99999999-9999-9999-9999-999999999999',
        '22222222-0000-0000-0000-000000000001',
        'admin@example.com',      -- ← แก้เป็นอีเมลจริง
        'admin@example.com',      -- ← แก้เป็นอีเมลจริง
        'ผู้ดูแลระบบ', 'ACTIVE', true);

-- 4.2 ให้บทบาทผู้ดูแลระบบสูงสุด
insert into user_roles (user_id, role_id, org_id)
values ('99999999-9999-9999-9999-999999999999',
        '11111111-0000-0000-0000-000000000001',   -- SUPERADMIN
        '22222222-0000-0000-0000-000000000001');
```

> `is_superadmin = true` ให้สิทธิ `*` โดยไม่ต้องผ่านตาราง `role_permissions`
> ควรมีเพียง 1–2 คนเท่านั้น

---

## ขั้นที่ 5 — Deploy เป็นเว็บแอป

1. Apps Script → **Deploy** → **New deployment**
2. Select type → **Web app**
3. ตั้งค่า:

| ช่อง | ค่า | เหตุผล |
|---|---|---|
| Description | `HRM v1.0` | |
| Execute as | **Me** | เพื่อให้เข้าถึง Drive/Mail ของระบบได้ |
| Who has access | **Anyone within [องค์กร]** | จำกัดเฉพาะคนในองค์กร |

> เลือก **Anyone with Google account** เฉพาะเมื่อจำเป็นต้องเปิดหน้าสมัครงาน
> ให้บุคคลภายนอก — ระบบยังตรวจสิทธิที่ `app_users` อยู่ดี คนที่ไม่มีบัญชี
> จะเห็นข้อความแจ้งว่าไม่พบบัญชีผู้ใช้

4. กด **Deploy** → อนุญาต scope ที่ระบบขอ
5. คัดลอก **Web app URL** เก็บไว้

### หน้าที่เข้าถึงได้

| URL | หน้า | ต้องล็อกอิน |
|---|---|:---:|
| `<WebAppURL>` | ระบบหลัก | ✔ |
| `<WebAppURL>?page=jobs` | ประกาศรับสมัครงาน | |
| `<WebAppURL>?page=verify&code=XXXX` | ตรวจสอบเอกสาร | |

---

## ขั้นที่ 6 — ติดตั้งงานอัตโนมัติ

ใน Apps Script editor เลือกฟังก์ชัน `installTriggers` แล้วกด **Run** หนึ่งครั้ง

| งาน | ความถี่ | หน้าที่ |
|---|---|---|
| `jobSendNotifications` | ทุก 15 นาที | ส่งอีเมล/LINE จากคิวแจ้งเตือน |
| `jobNightlyAttendance` | ทุกวัน 01:00 | คำนวณสรุปเวลาของเมื่อวาน |
| `jobDailyAlerts` | ทุกวัน 07:00 | เตือนใบอนุญาตใกล้หมดอายุ/ครบทดลองงาน/ใกล้เกษียณ |
| `jobWeeklyDigest` | จันทร์ 08:00 | สรุปใบลาค้างอนุมัติส่งหัวหน้างาน |
| `jobFiscalYearRollover` | 1 ต.ค. 02:00 | ตั้งสิทธิวันลาปีใหม่ + ยกยอดลาพักผ่อน |

---

## ขั้นที่ 7 — ตรวจความพร้อม

เปิดเว็บแอป → เมนู **ผู้ใช้และสิทธิ** → แท็บ **ตรวจสอบระบบ**

หน้าจอจะตรวจ 8 รายการ: การเชื่อมต่อ Supabase, ตารางสิทธิ, บทบาทระบบ,
ประเภทการลา, สายอนุมัติใบลา, กะการทำงาน, โฟลเดอร์ Drive และทริกเกอร์

ทุกข้อควรขึ้นเครื่องหมายถูก หากข้อใดไม่ผ่าน หน้าจอจะบอกสาเหตุและวิธีแก้

---

## ขั้นที่ 8 — นำเข้าข้อมูลบุคลากร

### วิธีที่ 1 — ผ่านหน้าจอ (เหมาะกับจำนวนน้อย)

โมดูล **03 ทะเบียนบุคลากร** → ปุ่ม **+ เพิ่มบุคลากร**

### วิธีที่ 2 — นำเข้าจากไฟล์ (เหมาะกับย้ายระบบ)

```sql
-- ตัวอย่างนำเข้าจากตารางชั่วคราวที่ import ไว้แล้ว
insert into employees (org_id, emp_code, national_id, title_th,
                       first_name_th, last_name_th, gender, birth_date,
                       phone, email, hire_date, employment_status)
select '22222222-0000-0000-0000-000000000001',
       emp_code, national_id, title, first_name, last_name,
       gender, birth_date::date, phone, email, hire_date::date, 'ACTIVE'
from staging_employees
on conflict (org_id, emp_code) do nothing;

-- สร้างการดำรงตำแหน่งให้ทุกคน (ขาดขั้นนี้จะไม่ปรากฏใน v_employee_current)
insert into employment_assignments (org_id, employee_id, facility_id, department_id,
                                    position_id, employment_type, assignment_type,
                                    effective_from, base_salary, reason)
select e.org_id, e.id, f.id, d.id, p.id, s.employment_type, 'PRIMARY',
       e.hire_date, s.salary::numeric, 'นำเข้าข้อมูลจากระบบเดิม'
from employees e
join staging_employees s on s.emp_code = e.emp_code
left join facilities  f on f.code = s.facility_code and f.org_id = e.org_id
left join departments d on d.code = s.dept_code     and d.org_id = e.org_id
left join positions   p on p.code = s.position_code and p.org_id = e.org_id
where e.org_id = '22222222-0000-0000-0000-000000000001';
```

> **ข้อควรระวัง** ระบบตรวจเลขบัตรประชาชนด้วย checksum ผ่าน constraint
> `ck_emp_national_id` แถวที่เลขไม่ถูกต้องจะถูกปฏิเสธ
> ตรวจก่อนนำเข้าด้วย `select * from staging_employees where not fn_valid_thai_id(national_id);`

### หลังนำเข้าเสร็จ

```sql
-- ตั้งสิทธิวันลาให้ทุกคน
select fn_generate_leave_entitlements('22222222-0000-0000-0000-000000000001',
                                      fn_fiscal_year(current_date));

-- ผูกกะทำงานมาตรฐาน
update employment_assignments a
   set work_shift_id = (select id from work_shifts
                        where org_id = a.org_id and code = 'OFFICE')
 where a.effective_to is null and a.work_shift_id is null;

-- กำหนดผู้บังคับบัญชา (จำเป็นสำหรับสายอนุมัติใบลา)
update employment_assignments a
   set supervisor_id = (select head_employee_id from departments
                        where id = a.department_id)
 where a.effective_to is null and a.supervisor_id is null;
```

จากนั้นสร้างบัญชีผู้ใช้ให้บุคลากรผ่านหน้าจอ
**ผู้ใช้และสิทธิ → สร้างจากทะเบียนบุคลากร**

---

## ขั้นที่ 9 — อัปเดตระบบภายหลัง

```bash
# ฝั่ง Apps Script
cd hrm/apps-script && clasp push
# แล้ว Deploy → Manage deployments → แก้ deployment เดิม → เลือก version ใหม่
# (การสร้าง deployment ใหม่จะได้ URL ใหม่ ผู้ใช้ต้องเปลี่ยน bookmark)

# ฝั่งฐานข้อมูล — ทุกไฟล์เขียนแบบรันซ้ำได้ (idempotent)
psql "$DB_URL" -f hrm/supabase/sql/12_views_reports.sql
```

> ไฟล์ SQL ทุกไฟล์ใช้ `create table if not exists` / `create or replace`
> จึงรันซ้ำได้โดยไม่เสียข้อมูล ยกเว้นการเปลี่ยนชนิดคอลัมน์ซึ่งต้องเขียน
> `alter table` เพิ่มเอง

---

## แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ | วิธีแก้ |
|---|---|---|
| `ยังไม่ได้ตั้งค่า Script Properties` | ยังไม่ได้ใส่ค่าใน Script Properties | ทำขั้นที่ 3.3 |
| `ไม่พบบัญชีผู้ใช้ ... ในระบบ` | อีเมล Google ไม่ตรงกับ `app_users` | ตรวจ `select email, google_email from app_users;` |
| `ไม่มีสิทธิใช้งานส่วนนี้` | บทบาทยังไม่ครอบคลุมสิทธินั้น | ผู้ใช้และสิทธิ → กำหนดสิทธิ แล้วให้ผู้ใช้กด **รีเฟรช** |
| บุคลากรไม่ขึ้นในรายการ | ไม่มีแถวใน `employment_assignments` ที่ `effective_to is null` | สร้าง assignment ให้ (ดูขั้นที่ 8) |
| ใบลาส่งไม่ได้ — `ยังไม่ได้ตั้งค่าสายอนุมัติ` | ไม่มี `approval_flows` ของ `LEAVE_REQUEST` | รัน `14_seed.sql` หรือสร้างผ่านหน้า Admin |
| แจ้งเตือนทางอีเมลไม่ถูกส่ง | ยังไม่ติดตั้ง trigger | Run `installTriggers()` |
| `Exceeded maximum execution time` ตอนคิดเงินเดือน | คนเยอะเกินหนึ่งรอบ 6 นาที | แบ่งรอบตามสถานบริการ (`payroll_runs.facility_id`) |
| ลงเวลาแล้วขึ้น “นอกพื้นที่” | พิกัด `facilities.geo` ไม่ตรง/รัศมีแคบ | แก้ `geo` เป็นพิกัดจริงและเพิ่ม `radius_m` |
| การเปลี่ยนสิทธิไม่มีผลทันที | แคชสิทธิเก็บไว้ 5 นาที | กดปุ่ม **รีเฟรช** บนหัวเว็บ |

### ดู log เมื่อเกิดปัญหา

```
Apps Script → Executions   (ดู error พร้อม stack trace)
```
ตั้ง `DEBUG = true` ใน Script Properties จะเห็น log ของทุก API call
พร้อมเวลาที่ใช้ — ควรปิดกลับเมื่อใช้งานจริงเพราะ log มีข้อมูลละเอียด
