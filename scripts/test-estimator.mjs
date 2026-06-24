/**
 * scripts/test-estimator.mjs
 *
 * End-to-end paycheck estimator scenarios. Confirms the orchestrator wires
 * federal + FICA + state + locals + addons + deductions together correctly.
 *
 * Run with: node scripts/test-estimator.mjs
 */
import { estimatePaycheck, periodsPerYear } from '../src/core/estimator.js';
import { estimateFederalIncome, estimateFica, estimateStateIncome } from '../src/core/tax.js';

let pass = 0, fail = 0;
const close = (a, b, tol = 0.5) => Math.abs(a - b) < tol;
const check = (name, got, want, tol = 0.5) => {
  const ok = close(got, want, tol);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${Number(got).toFixed(2)}, want ${Number(want).toFixed(2)})`);
  ok ? pass++ : fail++;
};
const eq = (name, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); c ? pass++ : fail++; };

// 0. periodsPerYear
console.log('\n== 0. periodsPerYear ==');
eq('weekly → 52',      periodsPerYear('weekly') === 52);
eq('biweekly → 26',    periodsPerYear('biweekly') === 26);
eq('semimonthly → 24', periodsPerYear('semimonthly') === 24);
eq('monthly → 12',     periodsPerYear('monthly') === 12);
eq('numeric passthrough', periodsPerYear(26) === 26);

// 1. PA single, $2000 biweekly, no deductions, no locality
console.log('\n== 1. PA single, $2000 biweekly, no deductions ==');
const r1 = estimatePaycheck({
  grossPerPeriod: 2000, payPeriodsPerYear: 26,
  state: 'PA', filingStatus: 'single',
});
// Annual gross = 52,000. Federal taxable = 52000 - 16100 = 35,900
// Federal: 10% on 12,400 + 12% on 23,500 = 1240 + 2820 = $4,060/yr
check('PA single fed annual', r1.annual.federalIncomeTax, 4060);
check('PA single fed per-period', r1.federalIncomeTax, 4060 / 26);
// SS: 52000 × 0.062 = $3,224/yr
check('PA single SS annual', r1.annual.socialSecurity, 52000 * 0.062);
// Medicare: 52000 × 0.0145
check('PA single Medicare annual', r1.annual.medicare, 52000 * 0.0145);
// State PA: 52000 × 0.0307 = $1,596.40/yr
check('PA single state annual', r1.annual.stateTax, 52000 * 0.0307);
// No locals, no addons
check('PA single local total', r1.localTax, 0);
eq('PA single no addons', r1.payrollAddons.length === 0);

// 2. PA + Philadelphia resident: state 3.07% + Philly 3.74%
console.log('\n== 2. PA + Philadelphia resident ==');
const r2 = estimatePaycheck({
  grossPerPeriod: 2000, payPeriodsPerYear: 26,
  state: 'PA', filingStatus: 'single',
  locality: { philadelphia: 'resident' },
});
check('PA+Philly local annual = 3.74% × 52K', r2.annual.localTax, 52000 * 0.0374);
eq('Philly local item is labeled', r2.localItems.length === 1 && r2.localItems[0].code === 'PHILA_RES');

// 3. NJ single, $2500 biweekly, $100 HSA + $200 401(k) per period
console.log('\n== 3. NJ single, $2500 biweekly, $100 HSA + $200 401(k) ==');
const r3 = estimatePaycheck({
  grossPerPeriod: 2500, payPeriodsPerYear: 26,
  state: 'NJ', filingStatus: 'single',
  deductions: [
    { name: 'HSA',    amountPerPeriod: 100, type: 'pre-tax-section125' },
    { name: '401(k)', amountPerPeriod: 200, type: 'pre-tax-401k' },
  ],
});
// Annual gross = 65,000
// Pre-tax federal = (100 + 200) × 26 = 7,800
// Federal taxable = 65000 - 16100 - 7800 = 41,100
// Federal: 10% on 12,400 + 12% on 28,700 = 1240 + 3444 = $4,684/yr
check('NJ single fed annual', r3.annual.federalIncomeTax, 4684);
// FICA reduced only by Section 125 (HSA): annual gross 65000 - (100×26 = 2600) = 62,400 FICA wages
// SS = 62400 × 0.062 = $3868.80
check('NJ single SS annual (HSA reduces)', r3.annual.socialSecurity, 62400 * 0.062);
// NJ state taxable = 65000 - 7800 = 57,200
// NJ brackets single: 1.4% on 20K + 1.75% on 15K + 3.5% on 5K + 5.525% on (57200-40000=17200)
// = 280 + 262.5 + 175 + 950.30 = 1,667.80
check('NJ single state annual', r3.annual.stateTax, 280 + 262.5 + 175 + (17200 * 0.05525));
// NJ FLI addon: 65000 × 0.0023 = 149.50 (below cap)
const njFli = r3.payrollAddons.find(a => a.code === 'NJ_FLI');
check('NJ FLI per-period', njFli.amount, (65000 * 0.0023) / 26);

// 4. MA MFJ, $3000 biweekly, $300 401(k)/period, PFML included
console.log('\n== 4. MA MFJ, $3000 biweekly, $300 401(k) ==');
const r4 = estimatePaycheck({
  grossPerPeriod: 3000, payPeriodsPerYear: 26,
  state: 'MA', filingStatus: 'mfj',
  deductions: [{ name: '401(k)', amountPerPeriod: 300, type: 'pre-tax-401k' }],
});
// Annual gross = 78,000
// Federal taxable = 78000 - 32200 - 7800 = 38,000
// MFJ: 10% on 24,800 + 12% on (38000 - 24800 = 13,200) = 2480 + 1584 = $4,064
check('MA MFJ fed annual', r4.annual.federalIncomeTax, 4064);
// State MA: 5% on (78000 - 7800) = 70200 → $3,510
check('MA MFJ state annual', r4.annual.stateTax, 70200 * 0.05);
// MA PFML: 78000 × 0.0046 = 358.80
const maPfml = r4.payrollAddons.find(a => a.code === 'MA_PFML');
check('MA PFML annual per-period', maPfml.amount, (78000 * 0.0046) / 26);

// 5. NY single (now bracket mode), $2500 biweekly, NYC rate 3.8%
console.log('\n== 5. NY single (brackets), NYC 3.8% ==');
const r5 = estimatePaycheck({
  grossPerPeriod: 2500, payPeriodsPerYear: 26,
  state: 'NY', filingStatus: 'single',
  locality: { nyc: true, nycRate: 0.038 },
});
// Annual gross = 65,000
// NY single brackets: 8500*.039 + 3200*.044 + 2200*.0515 + 51100*.054 = 3345.0
check('NY single state annual (brackets)', r5.annual.stateTax, 3345.0);
// NYC: 65000 × 0.038 = $2,470
check('NY NYC local annual', r5.annual.localTax, 65000 * 0.038);
// NY SDI cap $31.20 + NY PFL: 65000 × 0.00432 = 280.80 (below cap)
const nySdi = r5.payrollAddons.find(a => a.code === 'NY_SDI');
const nyPfl = r5.payrollAddons.find(a => a.code === 'NY_PFL');
check('NY SDI per-period', nySdi.amount, 31.20 / 26);
check('NY PFL per-period', nyPfl.amount, (65000 * 0.00432) / 26);

// 6. Yonkers resident surcharge depends on state tax (now bracket-computed)
console.log('\n== 6. NY single + Yonkers resident (16.75% of state tax) ==');
const r6 = estimatePaycheck({
  grossPerPeriod: 2500, payPeriodsPerYear: 26,
  state: 'NY', filingStatus: 'single',
  locality: { yonkers: 'resident' },
});
// Yonkers resident: 16.75% of NY state tax (3345.0 for $65K single)
check('Yonkers resident surcharge', r6.annual.localTax, 3345.0 * 0.1675);

// 6b. User-rate path still works on NY HoH (HoH not yet bracket-mode)
console.log('\n== 6b. NY HoH user-rate fallback ==');
const r6b = estimatePaycheck({
  grossPerPeriod: 2500, payPeriodsPerYear: 26,
  state: 'NY', filingStatus: 'hoh',
  stateEffectiveRate: 0.065,
});
check('NY HoH user-rate annual', r6b.annual.stateTax, 65000 * 0.065);

// 7. NH zero state tax, no addons
console.log('\n== 7. NH (no income tax) ==');
const r7 = estimatePaycheck({
  grossPerPeriod: 2000, payPeriodsPerYear: 26,
  state: 'NH', filingStatus: 'single',
});
check('NH state tax = 0', r7.annual.stateTax, 0);
eq('NH no addons', r7.payrollAddons.length === 0);

// 8. Take-home sanity: gross > 0 and take-home < gross for a normal case
console.log('\n== 8. take-home sanity ==');
eq('take-home > 0', r1.takeHome > 0);
eq('take-home < gross', r1.takeHome < r1.gross);
eq('annual.takeHome = sum check',
   close(r1.annual.takeHome,
         r1.annual.gross
         - r1.annual.federalIncomeTax
         - r1.annual.socialSecurity - r1.annual.medicare - r1.annual.additionalMedicare
         - r1.annual.stateTax - r1.annual.localTax - r1.annual.payrollAddons
         - r1.annual.preTaxDeductions - r1.annual.postTaxDeductions, 0.01));

// 9. Post-tax deductions reduce take-home but not taxes
console.log('\n== 9. post-tax deduction ==');
const baseline = estimatePaycheck({
  grossPerPeriod: 2000, payPeriodsPerYear: 26,
  state: 'PA', filingStatus: 'single',
});
const withPost = estimatePaycheck({
  grossPerPeriod: 2000, payPeriodsPerYear: 26,
  state: 'PA', filingStatus: 'single',
  deductions: [{ name: 'Roth 401(k)', amountPerPeriod: 100, type: 'post-tax' }],
});
check('post-tax does not change federal', withPost.federalIncomeTax, baseline.federalIncomeTax);
check('post-tax does not change FICA SS', withPost.socialSecurity, baseline.socialSecurity);
check('post-tax reduces take-home by $100', baseline.takeHome - withPost.takeHome, 100);

// 10. Marginal federal rate exposed
console.log('\n== 10. marginal federal rate ==');
eq('PA $52K single marginal = 12%', r1.marginalFederalRate === 0.12);

console.log(`\n--- ${pass} pass, ${fail} fail ---`);
process.exit(fail === 0 ? 0 : 1);
