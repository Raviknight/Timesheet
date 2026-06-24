/**
 * scripts/test-tax.mjs
 *
 * Unit tests for the pure tax engine. No estimator orchestration here —
 * see test-estimator.mjs for end-to-end paycheck scenarios.
 *
 * Run with: node scripts/test-tax.mjs
 */
import {
  FEDERAL_BRACKETS_2026,
  FEDERAL_STD_DEDUCTION_2026,
  FICA_2026,
  applyBrackets,
  marginalRate,
  estimateFederalIncome,
  estimateFica,
  estimateStateIncome,
  estimateAddons,
  estimateLocals,
  requiresUserRate,
  listStates,
} from '../src/core/tax.js';

let pass = 0, fail = 0;
const close = (a, b) => Math.abs(a - b) < 0.01;
const check = (name, got, want) => {
  const ok = close(got, want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${Number(got).toFixed(2)}, want ${Number(want).toFixed(2)})`);
  ok ? pass++ : fail++;
};
const eq = (name, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); c ? pass++ : fail++; };

// 1. applyBrackets math
console.log('\n== 1. applyBrackets ==');
check('zero income → 0', applyBrackets(0, FEDERAL_BRACKETS_2026.single), 0);
check('negative income → 0', applyBrackets(-100, FEDERAL_BRACKETS_2026.single), 0);
// $10,000 (single): all in 10% bracket → $1,000
check('single $10,000 → $1,000', applyBrackets(10000, FEDERAL_BRACKETS_2026.single), 1000);
// $50,000 single: 10% on 12,400 + 12% on (50000 - 12400) = 1240 + 4512 = 5752
check('single $50,000 → $5,752', applyBrackets(50000, FEDERAL_BRACKETS_2026.single), 5752);
// $100,000 single: 10% on 12,400 + 12% on 38,000 + 22% on 49,600 = 1240 + 4560 + 10912 = 16,712
check('single $100,000 → $16,712', applyBrackets(100000, FEDERAL_BRACKETS_2026.single), 16712);
// MFJ $200,000: 10% on 24,800 + 12% on 76,000 + 22% on 99,200 = 2480 + 9120 + 21824 = 33,424
check('mfj $200,000 → $33,424', applyBrackets(200000, FEDERAL_BRACKETS_2026.mfj), 33424);

// 2. marginalRate
console.log('\n== 2. marginalRate ==');
eq('single $5,000 → 10%',    marginalRate(5000,   FEDERAL_BRACKETS_2026.single) === 0.10);
eq('single $50,000 → 12%',   marginalRate(50000,  FEDERAL_BRACKETS_2026.single) === 0.12);
eq('single $200,000 → 24%',  marginalRate(200000, FEDERAL_BRACKETS_2026.single) === 0.24);
eq('single $1M → 37%',       marginalRate(1000000, FEDERAL_BRACKETS_2026.single) === 0.37);
eq('mfj $300,000 → 24%',     marginalRate(300000, FEDERAL_BRACKETS_2026.mfj) === 0.24);

// 3. estimateFederalIncome (uses std deduction)
console.log('\n== 3. estimateFederalIncome ==');
// $60,000 single gross, no pretax: taxable = 60000 - 16100 = 43,900
// 10% on 12,400 + 12% on (43,900 - 12,400 = 31,500) = 1240 + 3780 = 5,020
check('single $60K, no pretax', estimateFederalIncome({ annualGross: 60000, filingStatus: 'single' }), 5020);
// With $6,000 401(k) pretax: taxable = 60000 - 16100 - 6000 = 37,900 → 10% on 12,400 + 12% on 25,500 = 1240 + 3060 = 4,300
check('single $60K, $6K 401k', estimateFederalIncome({ annualGross: 60000, filingStatus: 'single', preTaxFederal: 6000 }), 4300);

// 4. estimateFica
console.log('\n== 4. estimateFica ==');
// $50,000 simple
const fica1 = estimateFica({ annualGross: 50000 });
check('FICA $50K SS',       fica1.ss,       50000 * 0.062);
check('FICA $50K Medicare', fica1.medicare, 50000 * 0.0145);
check('FICA $50K Addl Med', fica1.additionalMedicare, 0);
// $250,000 single → SS capped at $184,500, Medicare on full, Addl Medicare on (250000 - 200000) * 0.009
const fica2 = estimateFica({ annualGross: 250000, filingStatus: 'single' });
check('FICA $250K SS capped', fica2.ss, 184500 * 0.062);
check('FICA $250K Addl Med',  fica2.additionalMedicare, 50000 * 0.009);
// MFJ $250K → Addl Medicare threshold $250K, so 0
const fica3 = estimateFica({ annualGross: 250000, filingStatus: 'mfj' });
check('FICA $250K MFJ Addl Med', fica3.additionalMedicare, 0);
// Section 125 reduces FICA: $50K - $3000 = $47K FICA wages
const fica4 = estimateFica({ annualGross: 50000, preTaxFica: 3000 });
check('FICA Section 125 reduces SS', fica4.ss, 47000 * 0.062);

// 5. State: PA flat
console.log('\n== 5. PA (flat 3.07%) ==');
check('PA $50K single', estimateStateIncome({ state: 'PA', filingStatus: 'single', annualGross: 50000 }), 50000 * 0.0307);
check('PA $100K mfj',   estimateStateIncome({ state: 'PA', filingStatus: 'mfj', annualGross: 100000 }), 100000 * 0.0307);

// 6. State: MA flat + millionaire surtax
console.log('\n== 6. MA (5% + 4% surtax over $1,107,750) ==');
check('MA $50K single', estimateStateIncome({ state: 'MA', filingStatus: 'single', annualGross: 50000 }), 50000 * 0.05);
// $1.2M: 5% on full + 4% on (1,200,000 - 1,107,750)
const ma1200 = estimateStateIncome({ state: 'MA', filingStatus: 'single', annualGross: 1200000 });
check('MA $1.2M single (5% + 4% surtax on excess)', ma1200, 1200000 * 0.05 + (1200000 - 1107750) * 0.04);

// 7. State: NH zero
console.log('\n== 7. NH (no income tax) ==');
check('NH $100K single', estimateStateIncome({ state: 'NH', filingStatus: 'single', annualGross: 100000 }), 0);

// 8. State: NJ single (verified brackets)
console.log('\n== 8. NJ single ==');
// $100,000 single: 1.4% on 20K + 1.75% on 15K + 3.5% on 5K + 5.525% on 35K + 6.37% on (100000-75000=25000)
// = 280 + 262.5 + 175 + 1933.75 + 1592.5 = 4243.75
check('NJ $100K single', estimateStateIncome({ state: 'NJ', filingStatus: 'single', annualGross: 100000 }), 4243.75);

// 9. User-rate mode requires userEffectiveRate (NY HoH is the user-rate
// representative now that NY single/MFJ, NJ MFJ, VT MFJ are bracket-mode).
console.log('\n== 9. user-rate fallback (NY HoH) ==');
check('NY HoH $100K @ 6.5%', estimateStateIncome({ state: 'NY', filingStatus: 'hoh', annualGross: 100000, userEffectiveRate: 0.065 }), 6500);
eq('NY HoH throws without userEffectiveRate', (() => {
  try { estimateStateIncome({ state: 'NY', filingStatus: 'hoh', annualGross: 100000 }); return false; }
  catch { return true; }
})());

// 9b. New brackets: NY single, NJ MFJ, MD single, DC, VA (all newly bracket-mode).
console.log('\n== 9b. newly-bracketed state spot checks ==');
// NY single $65K: 8500*.039 + 3200*.044 + 2200*.0515 + 51100*.054
//               = 331.5 + 140.8 + 113.3 + 2759.4 = 3345.0
check('NY single $65K', estimateStateIncome({ state: 'NY', filingStatus: 'single', annualGross: 65000 }), 3345.0);
// NJ MFJ $100K: 20000*.014 + 30000*.0175 + 20000*.0245 + 10000*.035 + 20000*.0553
//             = 280 + 525 + 490 + 350 + 1106 = 2751
check('NJ MFJ $100K', estimateStateIncome({ state: 'NJ', filingStatus: 'mfj', annualGross: 100000 }), 2751);
// MD single $50K: taxable = 50000 - 2550 = 47450
//   1000*.02 + 1000*.03 + 1000*.04 + (47450-3000)*.0475
//   = 20 + 30 + 40 + 2111.375 = 2201.375
check('MD single $50K', estimateStateIncome({ state: 'MD', filingStatus: 'single', annualGross: 50000 }), 2201.375);
// DC single $80K: taxable = 80000 - 15000 = 65000
//   10000*.04 + 30000*.06 + 20000*.065 + 5000*.085
//   = 400 + 1800 + 1300 + 425 = 3925
check('DC single $80K', estimateStateIncome({ state: 'DC', filingStatus: 'single', annualGross: 80000 }), 3925);
// VA single $30K: taxable = 30000 - 8750 = 21250
//   3000*.02 + 2000*.03 + 12000*.05 + 4250*.0575
//   = 60 + 60 + 600 + 244.375 = 964.375
check('VA single $30K', estimateStateIncome({ state: 'VA', filingStatus: 'single', annualGross: 30000 }), 964.375);

// 10. requiresUserRate
console.log('\n== 10. requiresUserRate flags ==');
eq('PA single does not',            requiresUserRate('PA', 'single') === false);
eq('NJ single does not',            requiresUserRate('NJ', 'single') === false);
eq('NJ mfj does not (v5.1)',        requiresUserRate('NJ', 'mfj') === false);
eq('NJ hoh still does',             requiresUserRate('NJ', 'hoh') === true);
eq('NY single does not (v5.1)',     requiresUserRate('NY', 'single') === false);
eq('NY hoh still does',             requiresUserRate('NY', 'hoh') === true);
eq('VT single does not',            requiresUserRate('VT', 'single') === false);
eq('VT mfj does not (v5.1)',        requiresUserRate('VT', 'mfj') === false);
eq('VT hoh still does',             requiresUserRate('VT', 'hoh') === true);
eq('MD single does not (v5.1)',     requiresUserRate('MD', 'single') === false);
eq('DC mfj does not (v5.1)',        requiresUserRate('DC', 'mfj') === false);
eq('VA hoh does not (v5.1)',        requiresUserRate('VA', 'hoh') === false);

// 11. Addons
console.log('\n== 11. payroll addons ==');
// NJ FLI: $200K gross → capped at $393.53
const njAddons = estimateAddons({ state: 'NJ', annualGross: 200000 });
const njFli = njAddons.find(a => a.code === 'NJ_FLI');
check('NJ FLI capped at $393.53', njFli.amount, 393.53);
// NY PFL: $100K → 0.432% × 100000 = $432, but cap is $411.91
const nyAddons = estimateAddons({ state: 'NY', annualGross: 100000 });
const nyPfl = nyAddons.find(a => a.code === 'NY_PFL');
check('NY PFL capped at $411.91', nyPfl.amount, 411.91);
// NY PFL low earner: $50K → 0.432% × 50000 = $216 (below cap)
const nyPflLow = estimateAddons({ state: 'NY', annualGross: 50000 }).find(a => a.code === 'NY_PFL');
check('NY PFL $50K not capped', nyPflLow.amount, 216);
// NY SDI cap: $31.20
const nySdi = nyAddons.find(a => a.code === 'NY_SDI');
check('NY SDI capped at $31.20', nySdi.amount, 31.20);
// RI TDI: $120K → 1.1% on first $100K only = $1,100 (cap)
const riAddons = estimateAddons({ state: 'RI', annualGross: 120000 });
const riTdi = riAddons.find(a => a.code === 'RI_TDI');
check('RI TDI capped at $1,100', riTdi.amount, 1100);
// MA PFML: 0.46% × $50K = $230 (below cap)
const maAddons = estimateAddons({ state: 'MA', annualGross: 50000 });
const maPfml = maAddons.find(a => a.code === 'MA_PFML');
check('MA PFML $50K', maPfml.amount, 230);

// 12. Locals
console.log('\n== 12. local taxes ==');
// Yonkers resident: 16.75% of NY state tax
const yres = estimateLocals({ state: 'NY', locality: { yonkers: 'resident' }, annualGross: 100000, stateTax: 5000 });
check('Yonkers resident: 16.75% of $5000 state tax', yres.total, 5000 * 0.1675);
// Yonkers nonresident: 0.5% of wages
const ynr = estimateLocals({ state: 'NY', locality: { yonkers: 'nonresident' }, annualGross: 100000, stateTax: 0 });
check('Yonkers nonresident: 0.5% × $100K', ynr.total, 500);
// Philadelphia resident: 3.74%
const phRes = estimateLocals({ state: 'PA', locality: { philadelphia: 'resident' }, annualGross: 60000, stateTax: 0 });
check('Philly resident: 3.74% × $60K', phRes.total, 60000 * 0.0374);
// Wilmington: 1.25%
const wilm = estimateLocals({ state: 'DE', locality: { wilmington: true }, annualGross: 80000, stateTax: 0 });
check('Wilmington 1.25% × $80K', wilm.total, 80000 * 0.0125);
// MD county: user rate 3.2%
const mdc = estimateLocals({ state: 'MD', locality: { mdCountyRate: 0.032 }, annualGross: 90000, stateTax: 0 });
check('MD county 3.2% × $90K', mdc.total, 90000 * 0.032);

// 13. listStates sanity
console.log('\n== 13. listStates ==');
const states = listStates();
eq('listStates returns 12 jurisdictions', states.length === 12);
eq('listStates includes NY', states.some(s => s.code === 'NY'));
eq('listStates includes PA', states.some(s => s.code === 'PA'));
eq('listStates includes NH', states.some(s => s.code === 'NH'));

console.log(`\n--- ${pass} pass, ${fail} fail ---`);
process.exit(fail === 0 ? 0 : 1);
