/**
 * src/core/tax.js
 *
 * Paycheck estimator tax data and pure math.
 *
 * VALID FOR TAX YEAR 2026. Last verified 2026-06-23.
 * Re-verify each January when the new IRS Rev. Proc. and state tables publish.
 *
 * Federal source: IRS Rev. Proc. 2025-32 (Internal Revenue Bulletin 2025-45).
 * Per-state sources cited inline above each STATES_2026 entry.
 *
 * Coverage tiers:
 *   - "brackets" mode: full progressive-bracket math, exact figures.
 *   - "user-rate" mode: state has no published bracket data here yet, caller
 *     supplies an effective rate. UI surfaces this so the result is clearly
 *     marked as an estimate against a user-entered rate, not exact brackets.
 *
 * No DOM, no I/O. Pure functions. Safe to import from anywhere.
 */

export const FEDERAL_BRACKETS_2026 = {
  single: [
    { rate: 0.10, upper: 12400 },
    { rate: 0.12, upper: 50400 },
    { rate: 0.22, upper: 105700 },
    { rate: 0.24, upper: 201775 },
    { rate: 0.32, upper: 256225 },
    { rate: 0.35, upper: 640600 },
    { rate: 0.37, upper: Infinity },
  ],
  mfj: [
    { rate: 0.10, upper: 24800 },
    { rate: 0.12, upper: 100800 },
    { rate: 0.22, upper: 211400 },
    { rate: 0.24, upper: 403550 },
    { rate: 0.32, upper: 512450 },
    { rate: 0.35, upper: 768700 },
    { rate: 0.37, upper: Infinity },
  ],
  hoh: [
    { rate: 0.10, upper: 17700 },
    { rate: 0.12, upper: 67450 },
    { rate: 0.22, upper: 105700 },
    { rate: 0.24, upper: 201750 },
    { rate: 0.32, upper: 256200 },
    { rate: 0.35, upper: 640600 },
    { rate: 0.37, upper: Infinity },
  ],
};

export const FEDERAL_STD_DEDUCTION_2026 = {
  single: 16100,
  mfj: 32200,
  hoh: 24150,
};

export const FICA_2026 = {
  ssRate: 0.062,
  ssWageBase: 184500,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThreshold: {
    single: 200000,
    mfj: 250000,
    hoh: 200000,
    mfs: 125000,
  },
};

export const FEDERAL_SUPPLEMENTAL_RATE_2026 = {
  underOneMillion: 0.22,
  overOneMillion: 0.37,
};

/**
 * Run a progressive bracket schedule against a taxable-income amount.
 * Schedule is an array of {rate, upper} entries in ascending order; the implied
 * lower of each is the previous entry's upper (0 for the first). The final
 * entry must have upper === Infinity.
 */
export function applyBrackets(taxableIncome, schedule) {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of schedule) {
    if (taxableIncome <= b.upper) {
      tax += (taxableIncome - prev) * b.rate;
      return tax;
    }
    tax += (b.upper - prev) * b.rate;
    prev = b.upper;
  }
  return tax;
}

/** Find the marginal rate that applies at a given taxable-income level. */
export function marginalRate(taxableIncome, schedule) {
  if (taxableIncome <= 0) return schedule[0].rate;
  for (const b of schedule) {
    if (taxableIncome <= b.upper) return b.rate;
  }
  return schedule[schedule.length - 1].rate;
}

/** Annual federal income tax on a gross wage with 401(k)/Section-125 pre-tax. */
export function estimateFederalIncome({ annualGross, filingStatus, preTaxFederal = 0 }) {
  const status = filingStatus in FEDERAL_BRACKETS_2026 ? filingStatus : 'single';
  const taxable = Math.max(0, annualGross - FEDERAL_STD_DEDUCTION_2026[status] - preTaxFederal);
  return applyBrackets(taxable, FEDERAL_BRACKETS_2026[status]);
}

/**
 * Annual FICA breakdown. Section-125 pre-tax (HSA, FSA, premiums via cafeteria
 * plan) reduces FICA wages; 401(k)/403(b)/457(b) deferrals do NOT.
 */
export function estimateFica({ annualGross, preTaxFica = 0, filingStatus = 'single' }) {
  const ficaWages = Math.max(0, annualGross - preTaxFica);
  const ss = Math.min(ficaWages, FICA_2026.ssWageBase) * FICA_2026.ssRate;
  const medicare = ficaWages * FICA_2026.medicareRate;
  const threshold = FICA_2026.additionalMedicareThreshold[filingStatus]
    ?? FICA_2026.additionalMedicareThreshold.single;
  const additionalMedicare = Math.max(0, ficaWages - threshold) * FICA_2026.additionalMedicareRate;
  return { ss, medicare, additionalMedicare };
}

// State table shape:
//   {
//     code, name,
//     income: {
//       single: { mode: 'brackets', brackets: [...], stdDeduction?: number, surtax?: { rate, threshold } }
//             | { mode: 'user-rate' },
//       mfj:    same shape
//       hoh:    same shape
//     },
//     payrollAddons: [{ code, name, rate, annualCap? }],
//     locals: descriptive only; the engine knows per-state local logic.
//   }
//
// Modes are per filing status because some states (NJ, CT, VT) have verified
// single brackets but pending MFJ/HoH thresholds.

const PA_FLAT = [{ rate: 0.0307, upper: Infinity }];

const STATES_2026 = {
  // Pennsylvania flat 3.07%. Source: https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/personal-income-tax
  PA: {
    code: 'PA', name: 'Pennsylvania',
    income: {
      single: { mode: 'brackets', brackets: PA_FLAT, stdDeduction: 0 },
      mfj:    { mode: 'brackets', brackets: PA_FLAT, stdDeduction: 0 },
      hoh:    { mode: 'brackets', brackets: PA_FLAT, stdDeduction: 0 },
    },
    // PA SUI employee rate (small, recently 0.07%) — TODO verify 2026.
    payrollAddons: [],
  },

  // Massachusetts flat 5% + 4% surtax over $1,107,750. Source: https://www.mass.gov/info-details/massachusetts-tax-rates
  // MA PFML 2026 employee 0.46% (0.28% medical + 0.18% family) on SS wage base.
  MA: {
    code: 'MA', name: 'Massachusetts',
    income: {
      single: { mode: 'brackets', brackets: [{ rate: 0.05, upper: Infinity }], stdDeduction: 0,
                surtax: { rate: 0.04, threshold: 1107750 } },
      mfj:    { mode: 'brackets', brackets: [{ rate: 0.05, upper: Infinity }], stdDeduction: 0,
                surtax: { rate: 0.04, threshold: 1107750 } },
      hoh:    { mode: 'brackets', brackets: [{ rate: 0.05, upper: Infinity }], stdDeduction: 0,
                surtax: { rate: 0.04, threshold: 1107750 } },
    },
    // TODO 2026 MA personal exemption (was $4,400 single / $8,800 MFJ historically).
    payrollAddons: [
      { code: 'MA_PFML', name: 'MA PFML', rate: 0.0046, annualCap: 184500 * 0.0046 },
    ],
  },

  // New Hampshire has no wage tax; I&D tax repealed effective 2025.
  // Source: https://www.revenue.nh.gov/news-and-media/repeal-nh-interest-and-dividends-tax-now-effect
  NH: {
    code: 'NH', name: 'New Hampshire',
    income: {
      single: { mode: 'brackets', brackets: [{ rate: 0, upper: Infinity }], stdDeduction: 0 },
      mfj:    { mode: 'brackets', brackets: [{ rate: 0, upper: Infinity }], stdDeduction: 0 },
      hoh:    { mode: 'brackets', brackets: [{ rate: 0, upper: Infinity }], stdDeduction: 0 },
    },
    payrollAddons: [],
  },

  // Delaware 0-6.6%, 7 brackets, same for all statuses. Top at $60K.
  // TODO verify intermediate thresholds; current values are best-known approximation
  // from public summaries pending direct verification against revenue.delaware.gov.
  DE: {
    code: 'DE', name: 'Delaware',
    income: {
      single: { mode: 'brackets', stdDeduction: 3250,
        brackets: [
          { rate: 0.000, upper: 2000 },
          { rate: 0.022, upper: 5000 },
          { rate: 0.039, upper: 10000 },
          { rate: 0.048, upper: 20000 },
          { rate: 0.052, upper: 25000 },
          { rate: 0.0555, upper: 60000 },
          { rate: 0.066, upper: Infinity },
        ] },
      mfj: { mode: 'brackets', stdDeduction: 6500,
        brackets: [
          { rate: 0.000, upper: 2000 },
          { rate: 0.022, upper: 5000 },
          { rate: 0.039, upper: 10000 },
          { rate: 0.048, upper: 20000 },
          { rate: 0.052, upper: 25000 },
          { rate: 0.0555, upper: 60000 },
          { rate: 0.066, upper: Infinity },
        ] },
      hoh: { mode: 'brackets', stdDeduction: 3250,
        brackets: [
          { rate: 0.000, upper: 2000 },
          { rate: 0.022, upper: 5000 },
          { rate: 0.039, upper: 10000 },
          { rate: 0.048, upper: 20000 },
          { rate: 0.052, upper: 25000 },
          { rate: 0.0555, upper: 60000 },
          { rate: 0.066, upper: Infinity },
        ] },
    },
    payrollAddons: [],
  },

  // Rhode Island 3 brackets. First to $82,050 for 2026 (RI Adv 2025-22).
  // TODO verify 2nd bracket upper (placeholder $186,500 from public summary).
  RI: {
    code: 'RI', name: 'Rhode Island',
    income: {
      single: { mode: 'brackets', stdDeduction: 10550,
        brackets: [
          { rate: 0.0375, upper: 82050 },
          { rate: 0.0475, upper: 186500 },
          { rate: 0.0599, upper: Infinity },
        ] },
      mfj: { mode: 'brackets', stdDeduction: 21100,
        brackets: [
          { rate: 0.0375, upper: 82050 },
          { rate: 0.0475, upper: 186500 },
          { rate: 0.0599, upper: Infinity },
        ] },
      hoh: { mode: 'brackets', stdDeduction: 15800,
        brackets: [
          { rate: 0.0375, upper: 82050 },
          { rate: 0.0475, upper: 186500 },
          { rate: 0.0599, upper: Infinity },
        ] },
    },
    payrollAddons: [
      { code: 'RI_TDI', name: 'RI TDI', rate: 0.011, annualCap: 100000 * 0.011 },
    ],
  },

  // Vermont 4 brackets per RemoteLaws / Tax Foundation summaries.
  // TODO verify MFJ/HoH thresholds (using single for all statuses in v1 with note).
  VT: {
    code: 'VT', name: 'Vermont',
    income: {
      single: { mode: 'brackets', stdDeduction: 12500,
        brackets: [
          { rate: 0.0335, upper: 45400 },
          { rate: 0.066,  upper: 110050 },
          { rate: 0.076,  upper: 229550 },
          { rate: 0.0875, upper: Infinity },
        ] },
      mfj: { mode: 'user-rate' },
      hoh: { mode: 'user-rate' },
    },
    payrollAddons: [],
  },

  // New Jersey single brackets verified. MFJ/HoH pending direct fetch.
  // Source: https://www.nj.gov/treasury/taxation/taxtables.shtml
  NJ: {
    code: 'NJ', name: 'New Jersey',
    income: {
      single: { mode: 'brackets', stdDeduction: 0,
        brackets: [
          { rate: 0.014,   upper: 20000 },
          { rate: 0.0175,  upper: 35000 },
          { rate: 0.035,   upper: 40000 },
          { rate: 0.05525, upper: 75000 },
          { rate: 0.0637,  upper: 500000 },
          { rate: 0.0897,  upper: 1000000 },
          { rate: 0.1075,  upper: Infinity },
        ] },
      mfj: { mode: 'user-rate' },
      hoh: { mode: 'user-rate' },
    },
    payrollAddons: [
      // NJ FLI 0.23% on first $171,100. NJ DOL 2026 press release.
      { code: 'NJ_FLI', name: 'NJ Family Leave Insurance', rate: 0.0023, annualCap: 171100 * 0.0023 },
      // NJ SDI/TDI employee rate has been 0 since 2023. TODO verify 2026.
      // NJ SUI employee rate placeholder (was ~0.3825% historically). TODO verify 2026.
    ],
  },

  // Connecticut single brackets verified. MFJ pending direct fetch.
  // Source: https://portal.ct.gov/drs
  CT: {
    code: 'CT', name: 'Connecticut',
    income: {
      single: { mode: 'brackets', stdDeduction: 0,
        brackets: [
          { rate: 0.020,  upper: 10000 },
          { rate: 0.045,  upper: 50000 },
          { rate: 0.055,  upper: 100000 },
          { rate: 0.060,  upper: 200000 },
          { rate: 0.065,  upper: 250000 },
          { rate: 0.069,  upper: 500000 },
          { rate: 0.0699, upper: Infinity },
        ] },
      mfj: { mode: 'user-rate' },
      hoh: { mode: 'user-rate' },
    },
    payrollAddons: [
      // CT PFML 0.5% on wages up to SS wage base ($184,500), max $922.50/year.
      { code: 'CT_PFML', name: 'CT PFML', rate: 0.005, annualCap: 184500 * 0.005 },
    ],
  },

  // New York: rates known but exact bracket thresholds pending direct PDF parse.
  // SDI/PFL/Yonkers verified. NYC user-rate.
  NY: {
    code: 'NY', name: 'New York',
    income: {
      single: { mode: 'user-rate' },
      mfj:    { mode: 'user-rate' },
      hoh:    { mode: 'user-rate' },
    },
    payrollAddons: [
      // NY SDI 0.5% capped at $0.60/week ($31.20/year).
      { code: 'NY_SDI', name: 'NY State Disability', rate: 0.005, annualCap: 31.20 },
      // NY PFL 2026: 0.432% capped at $411.91/year.
      // Source: https://paidfamilyleave.ny.gov/2026
      { code: 'NY_PFL', name: 'NY Paid Family Leave', rate: 0.00432, annualCap: 411.91 },
    ],
  },

  // Maryland: rates 2-5.75% in 8 brackets; thresholds pending. County tax separate.
  MD: {
    code: 'MD', name: 'Maryland',
    income: {
      single: { mode: 'user-rate' },
      mfj:    { mode: 'user-rate' },
      hoh:    { mode: 'user-rate' },
    },
    payrollAddons: [],
  },

  // District of Columbia: 4-10.75% in 7 brackets, no inflation indexing.
  // Bracket thresholds pending TY2026 Pertinent Data Book fetch.
  DC: {
    code: 'DC', name: 'District of Columbia',
    income: {
      single: { mode: 'user-rate' },
      mfj:    { mode: 'user-rate' },
      hoh:    { mode: 'user-rate' },
    },
    payrollAddons: [],
  },

  // Virginia 2-5.75%, 4 brackets. Top rate kicks in at just $17K (verified).
  // Lower thresholds pending direct verification (likely 2% to $3K, 3% to $5K, 5% to $17K).
  VA: {
    code: 'VA', name: 'Virginia',
    income: {
      single: { mode: 'user-rate' },
      mfj:    { mode: 'user-rate' },
      hoh:    { mode: 'user-rate' },
    },
    payrollAddons: [],
  },
};

export const SUPPORTED_STATES = Object.keys(STATES_2026);

export function stateMeta(code) {
  const s = STATES_2026[code];
  if (!s) return null;
  return { code: s.code, name: s.name };
}

export function listStates() {
  return SUPPORTED_STATES.map(c => ({ code: c, name: STATES_2026[c].name }));
}

/**
 * Per-filing-status state income tax. When the state's filing status is in
 * user-rate mode, userEffectiveRate must be supplied (decimal, e.g. 0.065).
 * Surtax (e.g. MA 4% over $1,107,750) is applied on top of the bracket math.
 */
export function estimateStateIncome({ state, filingStatus, annualGross, preTaxState = 0, userEffectiveRate = null }) {
  const data = STATES_2026[state];
  if (!data) throw new Error(`Unknown state: ${state}`);
  const status = filingStatus in data.income ? filingStatus : 'single';
  const cfg = data.income[status];
  const base = Math.max(0, annualGross - preTaxState);

  if (cfg.mode === 'user-rate') {
    if (userEffectiveRate == null) {
      throw new Error(`State ${state} (${status}) is in user-rate mode; supply userEffectiveRate.`);
    }
    return base * userEffectiveRate;
  }

  const stdDeduct = cfg.stdDeduction || 0;
  const taxable = Math.max(0, base - stdDeduct);
  let tax = applyBrackets(taxable, cfg.brackets);
  if (cfg.surtax) {
    const excess = Math.max(0, taxable - cfg.surtax.threshold);
    tax += excess * cfg.surtax.rate;
  }
  return tax;
}

/** Whether a given state+status is in user-rate mode (so the UI can switch input). */
export function requiresUserRate(state, filingStatus) {
  const data = STATES_2026[state];
  if (!data) return false;
  const status = filingStatus in data.income ? filingStatus : 'single';
  return data.income[status].mode === 'user-rate';
}

/** State payroll add-ons (SDI/PFL/FLI/TDI/PFML). Annual amounts. */
export function estimateAddons({ state, annualGross }) {
  const data = STATES_2026[state];
  if (!data) return [];
  return data.payrollAddons.map(a => {
    const raw = annualGross * a.rate;
    const amount = a.annualCap != null ? Math.min(raw, a.annualCap) : raw;
    return { code: a.code, name: a.name, amount };
  });
}

/**
 * Per-state local tax (NYC, Yonkers, Philly, Wilmington, PA EIT, MD county).
 * locality shape:
 *   { nyc: bool, nycRate: 0.038,
 *     yonkers: 'resident' | 'nonresident' | 'no',
 *     philadelphia: 'resident' | 'nonresident' | 'no',
 *     wilmington: bool,
 *     paLocalEitRate: 0.01, mdCountyRate: 0.032 }
 * Returns { items: [{code, name, amount}], total }.
 */
export function estimateLocals({ state, locality = {}, annualGross, stateTax }) {
  const items = [];

  if (state === 'NY') {
    if (locality.nyc && locality.nycRate != null) {
      items.push({ code: 'NYC', name: 'NYC income tax', amount: annualGross * locality.nycRate });
    }
    if (locality.yonkers === 'resident') {
      items.push({ code: 'YONKERS_RES', name: 'Yonkers resident surcharge (16.75% of NY tax)',
                   amount: stateTax * 0.1675 });
    } else if (locality.yonkers === 'nonresident') {
      items.push({ code: 'YONKERS_NONRES', name: 'Yonkers nonresident earnings tax (0.5%)',
                   amount: annualGross * 0.005 });
    }
  } else if (state === 'PA') {
    if (locality.philadelphia === 'resident') {
      items.push({ code: 'PHILA_RES', name: 'Philadelphia resident wage tax (3.74%)',
                   amount: annualGross * 0.0374 });
    } else if (locality.philadelphia === 'nonresident') {
      items.push({ code: 'PHILA_NONRES', name: 'Philadelphia non-resident wage tax (3.43%)',
                   amount: annualGross * 0.0343 });
    } else if (locality.paLocalEitRate) {
      items.push({ code: 'PA_EIT', name: 'PA local Earned Income Tax',
                   amount: annualGross * locality.paLocalEitRate });
    }
  } else if (state === 'DE') {
    if (locality.wilmington) {
      items.push({ code: 'WILMINGTON', name: 'Wilmington earned income tax (1.25%)',
                   amount: annualGross * 0.0125 });
    }
  } else if (state === 'MD') {
    if (locality.mdCountyRate != null) {
      items.push({ code: 'MD_COUNTY', name: 'MD county income tax',
                   amount: annualGross * locality.mdCountyRate });
    }
  }

  const total = items.reduce((s, i) => s + i.amount, 0);
  return { items, total };
}
