/**
 * HRM :: 15_Api_Payroll.gs
 * โมดูล 07 Payroll — งวดจ่าย / ประมวลผล / สลิป / ภาษี
 *
 * การคำนวณอยู่ฝั่ง Apps Script (ยืดหยุ่นต่อสูตรเฉพาะองค์กร)
 * ส่วนข้อมูลตั้งต้นและการปิดยอดใช้ RPC ฝั่ง DB
 */

function routesPayroll() {
  return {

    'payroll.periodList': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        return DB.select('payroll_periods', {
          filter: { org_id: ctx.orgId },
          order: 'period_year.desc,period_month.desc,period_seq.desc',
          limit: p.limit || 36
        });
      }
    },

    'payroll.periodSave': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th', 'period_year', 'period_month',
                               'start_date', 'end_date', 'pay_date'],
                              ['รหัสงวด', 'ชื่องวด', 'ปี', 'เดือน',
                               'วันเริ่มงวด', 'วันสิ้นงวด', 'วันจ่าย']);
        const data = Util.pick(p, ['code','name_th','period_year','period_month','period_seq',
                                   'start_date','end_date','cutoff_date','pay_date','status']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('payroll_periods', p.id, data)
                    : DB.insert('payroll_periods', data);
      }
    },

    'payroll.runList': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.periodId) filter.period_id = p.periodId;
        return DB.select('payroll_runs', {
          select: '*,payroll_periods(code,name_th,pay_date),facilities(name_th)',
          filter: filter, order: 'created_at.desc', limit: p.limit || 50
        });
      }
    },

    'payroll.runCreate': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['period_id'], ['งวดการจ่าย']);
        const period = DB.first('payroll_periods', {
          select: 'id,status,code', filter: { id: p.period_id, org_id: ctx.orgId }
        });
        if (!period) throw new Error('ไม่พบงวดการจ่าย');
        if (['CLOSED', 'CANCELLED'].indexOf(period.status) >= 0) {
          throw new Error('งวด ' + period.code + ' ปิดแล้ว');
        }

        return DB.insert('payroll_runs', {
          org_id: ctx.orgId,
          period_id: p.period_id,
          facility_id: p.facility_id || null,
          run_no: p.run_no || Util.nextDocNo(ctx.orgId, 'PAYROLL', 'PR', period.code, 3),
          run_type: p.run_type || 'REGULAR',
          employee_filter: p.employee_filter || {},
          note: p.note || null
        });
      }
    },

    /**
     * ประมวลผลเงินเดือน
     * 1) ดึงข้อมูลตั้งต้นจาก RPC  2) คำนวณรายการได้-หัก  3) คำนวณภาษี  4) เขียนสลิป
     */
    'payroll.calculate': {
      perm: 'payroll.calculate',
      fn: function (p, ctx) {
        Util.requireFields(p, ['run_id'], ['รอบประมวลผล']);

        const run = DB.first('payroll_runs', {
          select: '*,payroll_periods(*)', filter: { id: p.run_id, org_id: ctx.orgId }
        });
        if (!run) throw new Error('ไม่พบรอบประมวลผล');
        if (['APPROVED', 'PAID'].indexOf(run.status) >= 0) {
          throw new Error('รอบนี้อนุมัติ/จ่ายแล้ว ประมวลผลซ้ำไม่ได้');
        }

        const period = run.payroll_periods;
        const inputs = DB.rpc('fn_payroll_input', { p_run_id: p.run_id });
        if (!inputs || !inputs.length) throw new Error('ไม่มีบุคลากรที่เข้าเงื่อนไขในรอบนี้');

        const rates = loadContributionRates(ctx.orgId, period.end_date);
        const brackets = loadTaxBrackets(ctx.orgId, Number(String(period.end_date).slice(0, 4)));

        // ล้างสลิปเดิมของรอบนี้ก่อน
        DB.remove('payroll_slips', { run_id: p.run_id });

        const workDaysInPeriod = Number(p.work_days_per_month || 22);
        const results = [];

        inputs.forEach(function (row) {
          const calc = calculatePayslip(row, {
            period: period, rates: rates, brackets: brackets,
            workDaysInPeriod: workDaysInPeriod
          });

          const slip = DB.insert('payroll_slips', {
            org_id: ctx.orgId,
            run_id: p.run_id,
            employee_id: row.employee_id,
            slip_no: Util.nextDocNo(ctx.orgId, 'SLIP', 'SL', period.code, 4),
            emp_code: row.emp_code,
            full_name: row.full_name,
            position_name: row.position_name,
            department_name: row.department_name,
            facility_name: row.facility_name,
            bank_account: row.bank_account || {},
            base_salary: calc.baseSalary,
            work_days: row.work_days,
            absent_days: row.absent_days,
            leave_unpaid_days: row.unpaid_leave_days,
            ot_minutes: row.ot_minutes,
            gross_earning: calc.grossEarning,
            total_deduction: calc.totalDeduction,
            net_pay: calc.netPay,
            employer_cost: calc.employerCost,
            tax_amount: calc.tax,
            sso_employee: calc.ssoEmployee,
            sso_employer: calc.ssoEmployer
          });

          const items = calc.items.map(function (it, i) {
            return {
              slip_id: slip.id,
              component_id: it.component_id || null,
              component_code: it.code,
              component_name: it.name,
              component_type: it.type,
              category: it.category || null,
              quantity: it.quantity === undefined ? null : it.quantity,
              rate: it.rate === undefined ? null : it.rate,
              amount: it.amount,
              is_taxable: it.is_taxable !== false,
              calc_note: it.note || null,
              sort_order: it.sort === undefined ? i : it.sort
            };
          });
          if (items.length) DB.insert('payroll_slip_items', items);

          results.push({ employee_id: row.employee_id, emp_code: row.emp_code,
                         net_pay: calc.netPay });
        });

        const finalized = DB.rpc('fn_payroll_finalize', {
          p_run_id: p.run_id, p_status: 'CALCULATED'
        });

        return { run: finalized, slips: results.length, detail: results };
      }
    },

    'payroll.slipList': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['run_id'], ['รอบประมวลผล']);
        return DB.select('payroll_slips', {
          filter: { run_id: p.run_id, org_id: ctx.orgId },
          order: 'emp_code', limit: p.limit || 1000
        });
      }
    },

    /** สลิปรายบุคคล (ตนเองดูได้เสมอ) */
    'payroll.slipGet': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['id'], ['สลิป']);
        const slip = DB.first('payroll_slips', {
          select: '*,payroll_runs(run_no,payroll_periods(code,name_th,pay_date))',
          filter: { id: p.id }
        });
        if (!slip) throw new Error('ไม่พบสลิปเงินเดือน');
        if (slip.employee_id !== ctx.employeeId) {
          Auth.require('payroll.read');
          Auth.requireEmployee(ctx, slip.employee_id);
        }

        slip.items = DB.select('payroll_slip_items', {
          filter: { slip_id: p.id }, order: 'component_type,sort_order'
        });
        slip.net_pay_text = Util.bahtText(slip.net_pay);

        if (slip.employee_id === ctx.employeeId && !slip.is_viewed) {
          DB.updateById('payroll_slips', p.id, {
            is_viewed: true, viewed_at: new Date().toISOString()
          });
        }
        Auth.logAccess(ctx, {
          module: 'payroll', action: 'VIEW', employeeId: slip.employee_id,
          entityType: 'payroll_slips', entityId: p.id
        });
        return slip;
      }
    },

    /** สลิปทั้งหมดของฉัน */
    'payroll.mySlips': {
      perm: null,
      fn: function (p, ctx) {
        if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        return DB.select('payroll_slips', {
          select: 'id,slip_no,gross_earning,total_deduction,net_pay,payment_status,paid_at,' +
                  'payroll_runs(run_no,payroll_periods(code,name_th,pay_date))',
          filter: { employee_id: ctx.employeeId },
          order: 'created_at.desc', limit: p.limit || 24
        });
      }
    },

    'payroll.runApprove': {
      perm: 'payroll.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['run_id'], ['รอบประมวลผล']);
        const run = DB.first('payroll_runs', {
          select: 'id,status,headcount', filter: { id: p.run_id, org_id: ctx.orgId }
        });
        if (!run) throw new Error('ไม่พบรอบประมวลผล');
        if (run.status !== 'CALCULATED' && run.status !== 'PENDING_APPROVAL') {
          throw new Error('รอบสถานะ ' + run.status + ' ยังอนุมัติไม่ได้');
        }
        if (!run.headcount) throw new Error('รอบนี้ยังไม่มีสลิป');

        return DB.updateById('payroll_runs', p.run_id, {
          status: 'APPROVED', approved_by: ctx.userId, approved_at: new Date().toISOString()
        });
      }
    },

    'payroll.runMarkPaid': {
      perm: 'payroll.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['run_id'], ['รอบประมวลผล']);
        const run = DB.first('payroll_runs', {
          select: 'id,status', filter: { id: p.run_id, org_id: ctx.orgId }
        });
        if (!run) throw new Error('ไม่พบรอบประมวลผล');
        if (run.status !== 'APPROVED') throw new Error('ต้องอนุมัติรอบก่อนบันทึกการจ่าย');

        const now = new Date().toISOString();
        DB.update('payroll_slips', { run_id: p.run_id },
                  { payment_status: 'PAID', paid_at: now });
        return DB.updateById('payroll_runs', p.run_id, { status: 'PAID', paid_at: now });
      }
    },

    /** ไฟล์นำเข้าธนาคาร (CSV) */
    'payroll.bankFile': {
      perm: 'payroll.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['run_id'], ['รอบประมวลผล']);
        const slips = DB.select('payroll_slips', {
          select: 'emp_code,full_name,bank_account,net_pay',
          filter: { run_id: p.run_id, org_id: ctx.orgId, payment_method: 'TRANSFER' },
          order: 'emp_code'
        });

        const lines = ['รหัสพนักงาน,ชื่อบัญชี,ธนาคาร,เลขที่บัญชี,จำนวนเงิน'];
        const noAccount = [];
        slips.forEach(function (s) {
          const b = s.bank_account || {};
          if (!b.account_no) { noAccount.push(s.emp_code + ' ' + s.full_name); return; }
          lines.push([s.emp_code, b.account_name || s.full_name, b.bank_name || b.bank_code || '',
                      b.account_no, Number(s.net_pay).toFixed(2)].join(','));
        });

        return {
          csv: lines.join('\n'),
          rows: lines.length - 1,
          missingAccount: noAccount
        };
      }
    },

    // -------------------------------------------------- รายการเงินได้-หัก
    'payroll.componentList': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        return DB.select('pay_components', {
          filter: { org_id: ctx.orgId }, order: 'component_type,sort_order'
        });
      }
    },

    'payroll.componentSave': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th', 'component_type'],
                              ['รหัส', 'ชื่อรายการ', 'ประเภท']);
        const data = Util.pick(p, ['code','name_th','component_type','category','calc_method',
                                   'default_amount','default_percent','formula','is_taxable',
                                   'is_sso_base','is_recurring','cap_amount','gl_account',
                                   'sort_order','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('pay_components', p.id, data)
                    : DB.insert('pay_components', data);
      }
    },

    'payroll.employeeComponents': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id'], ['บุคลากร']);
        Auth.requireEmployee(ctx, p.employee_id);
        return DB.select('employee_pay_components', {
          select: '*,pay_components(code,name_th,component_type,category)',
          filter: { employee_id: p.employee_id }, order: 'effective_from.desc'
        });
      }
    },

    'payroll.employeeComponentSave': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'component_id', 'effective_from'],
                              ['บุคลากร', 'รายการ', 'มีผลตั้งแต่']);
        Auth.requireEmployee(ctx, p.employee_id);
        const data = Util.pick(p, ['employee_id','component_id','amount','percent_value',
                                   'effective_from','effective_to','reference_no','note']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('employee_pay_components', p.id, data)
                    : DB.insert('employee_pay_components', data);
      }
    },

    /** ปรับเงินเดือน (บันทึกประวัติ + อัปเดต assignment ปัจจุบัน) */
    'payroll.salaryAdjust': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'effective_date', 'new_salary'],
                              ['บุคลากร', 'วันที่มีผล', 'เงินเดือนใหม่']);
        Auth.requireEmployee(ctx, p.employee_id);

        const current = DB.first('employment_assignments', {
          select: 'id,base_salary',
          filter: { employee_id: p.employee_id, assignment_type: 'PRIMARY', effective_to: null }
        });
        const oldSalary = current ? current.base_salary : null;

        const hist = DB.insert('salary_histories', {
          org_id: ctx.orgId,
          employee_id: p.employee_id,
          effective_date: p.effective_date,
          old_salary: oldSalary,
          new_salary: p.new_salary,
          change_percent: oldSalary ? ((p.new_salary - oldSalary) / oldSalary * 100).toFixed(4) : null,
          change_type: p.change_type || 'ADJUSTMENT',
          reason: p.reason || null,
          order_no: p.order_no || null,
          order_date: p.order_date || null,
          approved_by: ctx.employeeId || null
        });

        if (current) DB.updateById('employment_assignments', current.id, { base_salary: p.new_salary });

        DB.insert('employment_events', {
          org_id: ctx.orgId, employee_id: p.employee_id, event_type: 'SALARY_ADJUST',
          event_date: p.effective_date, title: 'ปรับเงินเดือน',
          detail: p.reason || null, order_no: p.order_no || null,
          from_value: { salary: oldSalary }, to_value: { salary: p.new_salary },
          source_table: 'salary_histories', source_id: hist.id
        });

        return hist;
      }
    },

    'payroll.taxProfileSave': {
      perm: 'payroll.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'tax_year'], ['บุคลากร', 'ปีภาษี']);
        Auth.requireEmployee(ctx, p.employee_id);
        const data = Util.pick(p, ['employee_id','tax_year','marital_status','spouse_has_income',
                                   'child_count','parent_count','disabled_count',
                                   'insurance_premium','pvd_contribution','rmf_ltf_amount',
                                   'home_loan_interest','donation_amount','other_deduction']);
        return DB.insert('employee_tax_profiles', data, { upsertOn: 'employee_id,tax_year' });
      }
    },

    'payroll.costReport': {
      perm: 'payroll.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.periodYear) filter.period_year = p.periodYear;
        if (p.facilityId) filter.facility_id = p.facilityId;
        return DB.select('v_payroll_cost', {
          filter: filter, order: 'period_year.desc,period_month.desc'
        });
      }
    }
  };
}

// =============================================================================
// เครื่องคำนวณเงินเดือน
// =============================================================================

function loadContributionRates(orgId, onDate) {
  const rows = DB.select('contribution_rates', {
    filter: { effective_from: { op: 'lte', value: onDate } },
    order: 'effective_from.desc'
  });
  const out = {};
  rows.forEach(function (r) {
    if (r.org_id && r.org_id !== orgId) return;
    if (r.effective_to && r.effective_to < onDate) return;
    if (!out[r.fund_type] || (r.org_id && !out[r.fund_type].org_id)) out[r.fund_type] = r;
  });
  return out;
}

function loadTaxBrackets(orgId, taxYear) {
  let rows = DB.select('tax_brackets', {
    filter: { tax_year: taxYear, org_id: orgId }, order: 'income_from'
  });
  if (!rows.length) {
    rows = DB.select('tax_brackets', {
      filter: { tax_year: taxYear, org_id: null }, order: 'income_from'
    });
  }
  if (!rows.length) {
    // ถอยไปใช้ปีล่าสุดที่มีข้อมูล
    const any = DB.select('tax_brackets', { order: 'tax_year.desc,income_from', limit: 20 });
    const latestYear = any.length ? any[0].tax_year : null;
    rows = any.filter(function (r) { return r.tax_year === latestYear; })
              .sort(function (a, b) { return a.income_from - b.income_from; });
  }
  return rows;
}

/** ภาษีเงินได้ต่อปีตามขั้นบันได */
function calcAnnualTax(netIncome, brackets) {
  if (!brackets || !brackets.length || netIncome <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i];
    const from = Number(b.income_from);
    const to = b.income_to === null || b.income_to === undefined ? Infinity : Number(b.income_to);
    if (netIncome <= from) break;
    const taxable = Math.min(netIncome, to) - from;
    if (taxable > 0) tax += taxable * Number(b.rate_percent) / 100;
  }
  return Math.max(0, tax);
}

/**
 * คำนวณสลิป 1 ใบ
 * ลำดับ: เงินเดือนฐาน -> รายการเงินได้ -> หักขาดงาน -> ประกันสังคม -> ภาษี -> รายการหักอื่น
 */
function calculatePayslip(row, opt) {
  const items = [];
  const components = row.components || [];
  const rates = opt.rates || {};
  const dailyRate = Number(row.base_salary || 0) / (opt.workDaysInPeriod || 22);

  let baseSalary = Number(row.base_salary || 0);
  let grossEarning = 0;
  let ssoBase = 0;
  let taxableIncome = 0;
  let totalDeduction = 0;
  let employerCost = 0;

  function addItem(it) {
    items.push(it);
    const amt = Number(it.amount || 0);
    if (it.type === 'EARNING') {
      grossEarning += amt;
      if (it.is_taxable !== false) taxableIncome += amt;
      if (it.is_sso_base) ssoBase += amt;
    } else if (it.type === 'DEDUCTION') {
      totalDeduction += amt;
    } else if (it.type === 'EMPLOYER_COST') {
      employerCost += amt;
    }
  }

  // ---- 1) รายการเงินได้ที่ผูกไว้กับบุคลากร
  components.forEach(function (c) {
    if (c.type !== 'EARNING') return;
    let amount = 0;

    switch (c.calc_method) {
      case 'FIXED':         amount = Number(c.amount || 0); break;
      case 'PERCENT_BASE':  amount = baseSalary * Number(c.percent || 0) / 100; break;
      case 'RATE_TIME':
        if (c.category === 'OT') {
          const hours = Number(row.ot_minutes || 0) / 60;
          const hourly = dailyRate / 8;
          amount = hours * hourly * 1.5;
          addItem({ component_id: c.component_id, code: c.code, name: c.name, type: 'EARNING',
                    category: c.category, quantity: Math.round(hours * 100) / 100,
                    rate: Math.round(hourly * 1.5 * 100) / 100,
                    amount: Math.round(amount * 100) / 100,
                    is_taxable: c.is_taxable, is_sso_base: c.is_sso_base,
                    note: 'ล่วงเวลา ' + Util.minutesToText(row.ot_minutes), sort: c.sort });
          return;
        }
        amount = Number(c.amount || 0);
        break;
      default:              amount = Number(c.amount || 0);
    }

    if (c.cap && amount > Number(c.cap)) amount = Number(c.cap);
    if (c.category === 'BASE') baseSalary = amount || baseSalary;

    addItem({ component_id: c.component_id, code: c.code, name: c.name, type: 'EARNING',
              category: c.category, amount: Math.round(amount * 100) / 100,
              is_taxable: c.is_taxable, is_sso_base: c.is_sso_base, sort: c.sort });
  });

  // ถ้าไม่มีรายการ BASE ผูกไว้ ให้ใช้เงินเดือนจาก assignment
  if (!components.some(function (c) { return c.category === 'BASE'; }) && baseSalary > 0) {
    addItem({ code: 'BASE', name: 'เงินเดือน', type: 'EARNING', category: 'BASE',
              amount: Math.round(baseSalary * 100) / 100,
              is_taxable: true, is_sso_base: true, sort: 1 });
  }

  // ---- 2) หักขาดงาน / ลาไม่รับเงินเดือน
  const unpaidDays = Number(row.absent_days || 0) + Number(row.unpaid_leave_days || 0);
  if (unpaidDays > 0 && dailyRate > 0) {
    const amount = Math.round(unpaidDays * dailyRate * 100) / 100;
    addItem({ code: 'ABSENT', name: 'หักขาดงาน/ลาไม่รับเงินเดือน', type: 'DEDUCTION',
              category: 'ABSENCE', quantity: unpaidDays,
              rate: Math.round(dailyRate * 100) / 100, amount: amount,
              is_taxable: false, note: unpaidDays + ' วัน', sort: 90 });
  }

  // ---- 3) ประกันสังคม
  let ssoEmployee = 0, ssoEmployer = 0;
  const sso = rates['SSO'];
  if (sso) {
    let base = ssoBase || baseSalary;
    if (sso.min_base) base = Math.max(base, Number(sso.min_base));
    if (sso.max_base) base = Math.min(base, Number(sso.max_base));

    ssoEmployee = base * Number(sso.employee_percent || 0) / 100;
    ssoEmployer = base * Number(sso.employer_percent || 0) / 100;
    if (sso.employee_cap) ssoEmployee = Math.min(ssoEmployee, Number(sso.employee_cap));
    if (sso.employer_cap) ssoEmployer = Math.min(ssoEmployer, Number(sso.employer_cap));

    ssoEmployee = Math.round(ssoEmployee * 100) / 100;
    ssoEmployer = Math.round(ssoEmployer * 100) / 100;

    if (ssoEmployee > 0) {
      addItem({ code: 'SSO', name: 'ประกันสังคม', type: 'DEDUCTION', category: 'SSO',
                rate: Number(sso.employee_percent), amount: ssoEmployee,
                is_taxable: false, note: 'ฐาน ' + Util.money(base), sort: 91 });
    }
    if (ssoEmployer > 0) {
      addItem({ code: 'SSO_ER', name: 'ประกันสังคม (นายจ้าง)', type: 'EMPLOYER_COST',
                category: 'SSO', amount: ssoEmployer, is_taxable: false, sort: 95 });
    }
  }

  // ---- 4) ภาษีหัก ณ ที่จ่าย (ประมาณการรายปีแล้วเฉลี่ยต่อเดือน)
  const annualIncome = taxableIncome * 12;
  const expenseDeduct = Math.min(annualIncome * 0.5, 100000);   // ค่าใช้จ่าย 50% ไม่เกิน 100,000
  const personalAllowance = 60000;
  const ssoAnnual = ssoEmployee * 12;
  const netIncome = Math.max(0, annualIncome - expenseDeduct - personalAllowance - ssoAnnual);
  const annualTax = calcAnnualTax(netIncome, opt.brackets);
  const tax = Math.round(annualTax / 12 * 100) / 100;

  if (tax > 0) {
    addItem({ code: 'TAX', name: 'ภาษีเงินได้หัก ณ ที่จ่าย', type: 'DEDUCTION', category: 'TAX',
              amount: tax, is_taxable: false,
              note: 'ประมาณการเงินได้ทั้งปี ' + Util.money(annualIncome), sort: 92 });
  }

  // ---- 5) รายการหักอื่น ๆ ที่ผูกไว้ (สหกรณ์, เงินกู้, กบข.)
  components.forEach(function (c) {
    if (c.type !== 'DEDUCTION' && c.type !== 'EMPLOYER_COST') return;
    if (['TAX', 'SSO'].indexOf(c.category) >= 0) return;    // คำนวณไปแล้วข้างบน

    let amount = 0;
    if (c.calc_method === 'PERCENT_BASE') amount = baseSalary * Number(c.percent || 0) / 100;
    else if (c.calc_method === 'PERCENT_GROSS') amount = grossEarning * Number(c.percent || 0) / 100;
    else amount = Number(c.amount || 0);

    if (c.cap && amount > Number(c.cap)) amount = Number(c.cap);
    if (amount <= 0) return;

    addItem({ component_id: c.component_id, code: c.code, name: c.name, type: c.type,
              category: c.category, amount: Math.round(amount * 100) / 100,
              is_taxable: false, sort: c.sort });
  });

  const netPay = Math.round((grossEarning - totalDeduction) * 100) / 100;

  return {
    baseSalary: Math.round(baseSalary * 100) / 100,
    grossEarning: Math.round(grossEarning * 100) / 100,
    totalDeduction: Math.round(totalDeduction * 100) / 100,
    netPay: netPay,
    employerCost: Math.round(employerCost * 100) / 100,
    tax: tax,
    ssoEmployee: ssoEmployee,
    ssoEmployer: ssoEmployer,
    items: items
  };
}
