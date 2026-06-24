/**
 * src/core/estimator.js
 *
 * Paycheck estimator: orchestrates federal + FICA + state + local + addons
 * from a single per-paycheck input. Returns a per-paycheck breakdown plus
 * an annual breakdown for reference. Pure function, safe to import anywhere.
 *
 * Engine semantics:
 *   - Inputs are PER PAYCHECK. Engine annualizes (× payPeriodsPerYear), applies
 *     bracket math against annual taxable income, divides back to per-period.
 *     This matches how withholding actually works.
 *   - Pre-tax 401(k)/403(b)/457(b) reduce federal + state income tax but NOT
 *     FICA. Section 125 (HSA, FSA, pre-tax health premium) reduces all three.
 *   - Post-tax deductions reduce take-home only.
 *   - This estimator is for personal planning, not actual payroll withholding.
 *     UI should label results as "estimate" clearly.
 */

import {
  FEDERAL_BRACKETS_2026,
  FEDERAL_STD_DEDUCTION_2026,
  estimateFederalIncome,
  estimateFica,
  estimateStateIncome,
  estimateAddons,
  estimateLocals,
  marginalRate,
} from './tax.js';

const PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

export function periodsPerYear(frequency) {
  if (typeof frequency === 'number') return frequency;
  return PERIODS[frequency] || 26;
}

/**
 * @param {object} inputs
 * @param {number} inputs.grossPerPeriod          Gross wages this paycheck.
 * @param {number|string} inputs.payPeriodsPerYear  52 | 26 | 24 | 12, or 'weekly' etc.
 * @param {string} inputs.state                    Two-letter state code (PA, NY, ...).
 * @param {string} inputs.filingStatus             'single' | 'mfj' | 'hoh'.
 * @param {object} [inputs.locality]               See estimateLocals for shape.
 * @param {Array}  [inputs.deductions]             [{name, amountPerPeriod, type}]
 *     type: 'pre-tax-401k'      reduces federal + state, not FICA
 *           'pre-tax-section125' reduces federal + state + FICA (HSA, FSA, premium)
 *           'post-tax'           reduces take-home only
 * @param {number} [inputs.stateEffectiveRate]     Required when state is in user-rate mode (decimal).
 */
export function estimatePaycheck(inputs) {
  const {
    grossPerPeriod,
    payPeriodsPerYear,
    state,
    filingStatus,
    locality = {},
    deductions = [],
    stateEffectiveRate = null,
  } = inputs;

  const periods = periodsPerYear(payPeriodsPerYear);
  const annualGross = grossPerPeriod * periods;

  // Bucket per-period deductions by tax treatment.
  let pre401k = 0, preSec125 = 0, post = 0;
  for (const d of deductions) {
    const amt = Number(d.amountPerPeriod) || 0;
    if (d.type === 'pre-tax-401k') pre401k += amt;
    else if (d.type === 'pre-tax-section125') preSec125 += amt;
    else if (d.type === 'post-tax') post += amt;
  }

  // Annualize for tax math.
  const annualPre401k = pre401k * periods;
  const annualPreSec125 = preSec125 * periods;
  const annualPost = post * periods;

  // Federal: both pre-tax categories reduce taxable.
  const preTaxFederal = annualPre401k + annualPreSec125;
  // FICA: only Section 125 reduces. 401(k) deferrals are still FICA-taxable.
  const preTaxFica = annualPreSec125;
  // State: same as federal in most states. PA taxes 401(k) at contribution time
  // (state-specific edge), not modeled in v1.
  const preTaxState = annualPre401k + annualPreSec125;

  const annualFederalTax = estimateFederalIncome({ annualGross, filingStatus, preTaxFederal });
  const fica = estimateFica({ annualGross, preTaxFica, filingStatus });
  const annualStateTax = estimateStateIncome({
    state, filingStatus, annualGross, preTaxState, userEffectiveRate: stateEffectiveRate,
  });
  const annualAddons = estimateAddons({ state, annualGross });
  const annualLocals = estimateLocals({ state, locality, annualGross, stateTax: annualStateTax });

  const annualAddonTotal = annualAddons.reduce((s, a) => s + a.amount, 0);
  const perPeriod = (annual) => annual / periods;

  const federalIncomeTax    = perPeriod(annualFederalTax);
  const socialSecurity      = perPeriod(fica.ss);
  const medicare            = perPeriod(fica.medicare);
  const additionalMedicare  = perPeriod(fica.additionalMedicare);
  const stateTax            = perPeriod(annualStateTax);
  const localTax            = perPeriod(annualLocals.total);
  const payrollAddons       = annualAddons.map(a => ({ code: a.code, name: a.name, amount: perPeriod(a.amount) }));
  const payrollAddonsTotal  = perPeriod(annualAddonTotal);

  const preTaxDeductions  = pre401k + preSec125;
  const postTaxDeductions = post;

  const totalTaxes = federalIncomeTax + socialSecurity + medicare + additionalMedicare
                    + stateTax + localTax + payrollAddonsTotal;
  const takeHome = grossPerPeriod - preTaxDeductions - totalTaxes - postTaxDeductions;

  // Marginal federal rate at the annual taxable level.
  const status = filingStatus in FEDERAL_BRACKETS_2026 ? filingStatus : 'single';
  const taxableFederal = Math.max(0, annualGross - FEDERAL_STD_DEDUCTION_2026[status] - preTaxFederal);
  const marginalFederalRate = marginalRate(taxableFederal, FEDERAL_BRACKETS_2026[status]);

  const effectiveTaxRate = grossPerPeriod > 0 ? totalTaxes / grossPerPeriod : 0;

  return {
    // Per-paycheck figures (the headline numbers a user reads):
    gross: grossPerPeriod,
    federalIncomeTax,
    socialSecurity,
    medicare,
    additionalMedicare,
    stateTax,
    localTax,
    localItems: annualLocals.items.map(i => ({ code: i.code, name: i.name, amount: perPeriod(i.amount) })),
    payrollAddons,
    preTaxDeductions,
    postTaxDeductions,
    takeHome,

    // Reference figures:
    annualGross,
    effectiveTaxRate,
    marginalFederalRate,

    // Annual breakdown (handy for sanity checks and "if you keep doing this all year"):
    annual: {
      gross: annualGross,
      federalIncomeTax: annualFederalTax,
      socialSecurity: fica.ss,
      medicare: fica.medicare,
      additionalMedicare: fica.additionalMedicare,
      stateTax: annualStateTax,
      localTax: annualLocals.total,
      payrollAddons: annualAddonTotal,
      preTaxDeductions: annualPre401k + annualPreSec125,
      postTaxDeductions: annualPost,
      takeHome: annualGross - (annualPre401k + annualPreSec125) - (annualFederalTax + fica.ss + fica.medicare + fica.additionalMedicare + annualStateTax + annualLocals.total + annualAddonTotal) - annualPost,
    },
  };
}
