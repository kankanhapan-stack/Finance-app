/**
 * HRM :: 16_Api_Benefit.gs
 * โมดูล 08 Benefits — สวัสดิการ / การเบิกจ่าย / เงินกู้ / ตรวจสุขภาพ
 */

function routesBenefit() {
  return {

    'benefit.planList': {
      perm: 'benefit.read',
      fn: function (p, ctx) {
        return DB.select('benefit_plans', {
          filter: { org_id: ctx.orgId }, order: 'benefit_type,name_th'
        });
      }
    },

    'benefit.planSave': {
      perm: 'benefit.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['code', 'name_th', 'benefit_type'], ['รหัส', 'ชื่อสวัสดิการ', 'ประเภท']);
        const data = Util.pick(p, ['code','name_th','benefit_type','provider','description',
                                   'eligibility','annual_limit','per_claim_limit','family_covered',
                                   'employer_contribution','employee_contribution',
                                   'effective_from','effective_to','is_active']);
        data.org_id = ctx.orgId;
        return p.id ? DB.updateById('benefit_plans', p.id, data) : DB.insert('benefit_plans', data);
      }
    },

    /** สิทธิที่ฉัน/บุคลากรรายนี้มี พร้อมยอดคงเหลือ */
    'benefit.myBenefits': {
      perm: null,
      fn: function (p, ctx) {
        const employeeId = p.employeeId || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('benefit.read');
          Auth.requireEmployee(ctx, employeeId);
        }
        return {
          usage: DB.select('v_benefit_usage', { filter: { employee_id: employeeId } }),
          enrollments: DB.select('benefit_enrollments', {
            select: '*,benefit_plans(code,name_th,benefit_type,annual_limit)',
            filter: { employee_id: employeeId, status: 'ACTIVE' }
          }),
          loans: DB.select('employee_loans', {
            filter: { employee_id: employeeId, status: 'ACTIVE' }
          })
        };
      }
    },

    'benefit.enroll': {
      perm: 'benefit.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'plan_id'], ['บุคลากร', 'สวัสดิการ']);
        Auth.requireEmployee(ctx, p.employee_id);
        const data = Util.pick(p, ['employee_id','plan_id','enrolled_date','end_date',
                                   'policy_no','covered_members','status','note']);
        data.org_id = ctx.orgId;
        data.enrolled_date = data.enrolled_date || Util.isoDate();
        return p.id ? DB.updateById('benefit_enrollments', p.id, data)
                    : DB.insert('benefit_enrollments', data);
      }
    },

    'benefit.claimList': {
      perm: null,
      fn: function (p, ctx) {
        const filter = {};
        if (p.mine || !Auth.can(ctx, 'benefit.read')) {
          if (!ctx.employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
          filter.employee_id = ctx.employeeId;
        } else {
          filter.org_id = ctx.orgId;
          if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
          if (p.status) filter.status = p.status;
        }
        return DB.select('benefit_claims', {
          select: '*,benefit_plans(code,name_th,benefit_type),' +
                  'employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'claim_date.desc', limit: p.limit || 100
        });
      }
    },

    'benefit.claimSave': {
      perm: null,
      fn: function (p, ctx) {
        Util.requireFields(p, ['plan_id', 'claim_amount'], ['สวัสดิการ', 'จำนวนเงินที่ขอเบิก']);
        const employeeId = p.employee_id || ctx.employeeId;
        if (!employeeId) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับข้อมูลบุคลากร');
        if (employeeId !== ctx.employeeId) {
          Auth.require('benefit.write');
          Auth.requireEmployee(ctx, employeeId);
        }
        if (Number(p.claim_amount) <= 0) throw new Error('จำนวนเงินต้องมากกว่า 0');

        const plan = DB.first('benefit_plans', {
          select: 'id,name_th,per_claim_limit,annual_limit',
          filter: { id: p.plan_id, org_id: ctx.orgId }
        });
        if (!plan) throw new Error('ไม่พบสวัสดิการนี้');

        if (plan.per_claim_limit && Number(p.claim_amount) > Number(plan.per_claim_limit)) {
          throw new Error('เบิกได้ครั้งละไม่เกิน ' + Util.money(plan.per_claim_limit) + ' บาท');
        }

        // ตรวจวงเงินคงเหลือรายปี
        if (plan.annual_limit) {
          const usage = DB.first('v_benefit_usage', {
            select: 'remaining_amount', filter: { employee_id: employeeId, plan_id: p.plan_id }
          });
          if (usage && Number(usage.remaining_amount) < Number(p.claim_amount)) {
            throw new Error('วงเงินคงเหลือไม่พอ (คงเหลือ ' +
                            Util.money(usage.remaining_amount) + ' บาท)');
          }
        }

        const data = Util.pick(p, ['plan_id','claim_date','service_date','claimant_name',
                                   'claimant_relation','provider_name','description',
                                   'claim_amount','receipt_url']);
        data.org_id = ctx.orgId;
        data.employee_id = employeeId;
        data.claim_date = data.claim_date || Util.isoDate();
        data.status = p.submit === false ? 'DRAFT' : 'SUBMITTED';
        if (!p.id) {
          data.claim_no = Util.nextDocNo(ctx.orgId, 'CLAIM', 'CL', Util.fiscalYear().toString(), 4);
        }
        return p.id ? DB.updateById('benefit_claims', p.id, data)
                    : DB.insert('benefit_claims', data);
      }
    },

    'benefit.claimAct': {
      perm: 'benefit.approve',
      fn: function (p, ctx) {
        Util.requireFields(p, ['id', 'action'], ['คำขอเบิก', 'การดำเนินการ']);
        const claim = DB.first('benefit_claims', {
          select: '*', filter: { id: p.id, org_id: ctx.orgId }
        });
        if (!claim) throw new Error('ไม่พบคำขอเบิก');
        if (['SUBMITTED', 'REVIEWING'].indexOf(claim.status) < 0) {
          throw new Error('คำขอสถานะ ' + claim.status + ' พิจารณาไม่ได้');
        }

        const patch = {
          reviewed_by: ctx.userId,
          reviewed_at: new Date().toISOString()
        };

        if (p.action === 'APPROVE') {
          const approved = p.approved_amount === undefined
            ? Number(claim.claim_amount) : Number(p.approved_amount);
          if (approved <= 0) throw new Error('จำนวนเงินอนุมัติต้องมากกว่า 0');
          if (approved > Number(claim.claim_amount)) {
            throw new Error('อนุมัติเกินจำนวนที่ขอเบิกไม่ได้');
          }
          patch.approved_amount = approved;
          patch.status = approved < Number(claim.claim_amount) ? 'PARTIAL' : 'APPROVED';
        } else if (p.action === 'REJECT') {
          if (!p.reason) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
          patch.status = 'REJECTED';
          patch.reject_reason = p.reason;
        } else {
          throw new Error('การดำเนินการไม่ถูกต้อง');
        }

        const out = DB.updateById('benefit_claims', p.id, patch);
        Util.notify(ctx, {
          employeeId: claim.employee_id,
          userId: Util.userIdOfEmployee(claim.employee_id),
          title: 'ผลการพิจารณาคำขอเบิกสวัสดิการ ' + (claim.claim_no || ''),
          body: patch.status === 'REJECTED'
            ? 'ไม่อนุมัติ: ' + p.reason
            : 'อนุมัติจำนวน ' + Util.money(patch.approved_amount) + ' บาท',
          entityType: 'benefit_claims', entityId: p.id
        });
        return out;
      }
    },

    'benefit.loanSave': {
      perm: 'benefit.write',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'principal', 'installments', 'installment_amount', 'start_period'],
                              ['บุคลากร', 'เงินต้น', 'จำนวนงวด', 'ยอดผ่อนต่องวด', 'งวดแรก']);
        Auth.requireEmployee(ctx, p.employee_id);
        const data = Util.pick(p, ['employee_id','loan_no','loan_type','lender','principal',
                                   'interest_rate','installments','installment_amount',
                                   'start_period','paid_installments','outstanding','status',
                                   'contract_url']);
        data.org_id = ctx.orgId;
        if (data.outstanding === undefined || data.outstanding === null) {
          data.outstanding = Number(p.principal);
        }
        return p.id ? DB.updateById('employee_loans', p.id, data)
                    : DB.insert('employee_loans', data);
      }
    },

    'benefit.checkupSave': {
      perm: 'health.read',
      fn: function (p, ctx) {
        Util.requireFields(p, ['employee_id', 'checkup_year'], ['บุคลากร', 'ปีที่ตรวจ']);
        Auth.requireEmployee(ctx, p.employee_id);
        const data = Util.pick(p, ['employee_id','checkup_year','checkup_date','provider',
                                   'program','result_summary','risk_level','followup_needed',
                                   'followup_note','report_url','is_confidential']);
        data.org_id = ctx.orgId;
        return DB.insert('health_checkups', data, { upsertOn: 'employee_id,checkup_year' });
      }
    },

    'benefit.checkupList': {
      perm: 'health.read',
      fn: function (p, ctx) {
        const filter = { org_id: ctx.orgId };
        if (p.year) filter.checkup_year = p.year;
        if (p.employeeId) { Auth.requireEmployee(ctx, p.employeeId); filter.employee_id = p.employeeId; }
        return DB.select('health_checkups', {
          select: '*,employees(emp_code,first_name_th,last_name_th)',
          filter: filter, order: 'checkup_date.desc', limit: p.limit || 200
        });
      }
    }
  };
}
