#!/usr/bin/env bash
# รันสคีมาทั้งหมด + smoke test ลงฐานข้อมูล PostgreSQL ที่ระบุ
# ใช้ตรวจก่อน deploy ขึ้น Supabase จริง
#   ตัวอย่าง:  DB_URL="postgres://postgres:pass@localhost:5432/hrm" ./run_all.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$HERE/../sql"
: "${DB_URL:?ต้องกำหนดตัวแปร DB_URL}"

echo "==> เตรียม role ของ Supabase (ถ้ายังไม่มี)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname='service_role')  then create role service_role  nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon')          then create role anon          nologin; end if;
end $$;
SQL

for f in "$SQL_DIR"/*.sql; do
  echo "==> $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "==> smoke test"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$HERE/smoke_test.sql"
echo "==> เสร็จสมบูรณ์"
