// The reference sheet for Advice: this tax year's US federal figures and
// the planning rules the briefing and the "Ask" box follow. The numbers
// live once, in LIMITS, and are used two ways: by code (advice.js works
// out brackets, Roth IRA eligibility and room left in each account) and,
// as REFERENCE, in every prompt (cached, so it costs little).
//
// Built in from the IRS announcements for 2026 (late 2025). advice.js
// also checks them against irs.gov once a month (officialCheck) and passes
// any difference, and next year's figures once announced, along with them.
// Update LIMITS and YEAR each January.

export const YEAR = 2026;
const D = n => Math.round(n * 100); // dollars -> cents

export const LIMITS = {
  k401: D(24500), k401CatchUp: D(8000), k401CatchUp6063: D(11250),
  ira: D(7500), iraCatchUp: D(1100),
  hsaSelf: D(4400), hsaFamily: D(8750), hsaCatchUp: D(1000),
  dependentCareFsa: D(7500), healthFsa: D(3400),
  std: { mfj: D(32200), single: D(16100), mfs: D(16100), hoh: D(24150) },
  // Top of each bracket, in dollars of taxable income: 10, 12, 22, 24, 32, 35%; 37% above.
  brackets: {
    mfj: [24800, 100800, 211400, 403550, 512450, 768700],
    single: [12400, 50400, 105700, 201775, 256225, 640600],
    mfs: [12400, 50400, 105700, 201775, 256225, 384350],
    hoh: [17700, 67450, 105700, 201750, 256200, 640600]
  },
  // Roth IRA contributions phase out across these modified AGIs (dollars).
  rothPhaseout: { mfj: [242000, 252000], single: [153000, 168000], hoh: [153000, 168000], mfs: [0, 10000] }
};
const RATES = [10, 12, 22, 24, 32, 35, 37];

export const FILING = { mfj: 'Married filing jointly', mfs: 'Married filing separately', single: 'Single', hoh: 'Head of household' };
const filingOr = f => (Object.hasOwn(FILING, f) ? f : 'mfj');

// The federal bracket for a taxable income (dollars).
export function bracketFor(filing, taxable) {
  const tops = LIMITS.brackets[filingOr(filing)];
  let i = 0;
  while (i < tops.length && taxable > tops[i]) i++;
  return RATES[i];
}
export const standardDeduction = filing => LIMITS.std[filingOr(filing)];
// Age = the age reached this year, as the IRS counts catch-ups.
export const k401Limit = age => LIMITS.k401 + (age >= 60 && age <= 63 ? LIMITS.k401CatchUp6063 : age >= 50 ? LIMITS.k401CatchUp : 0);
export const iraLimit = age => LIMITS.ira + (age >= 50 ? LIMITS.iraCatchUp : 0);
export function rothIraAllowed(filing, magi) {
  const [lo, hi] = LIMITS.rothPhaseout[filingOr(filing)];
  return magi < lo ? 'yes' : magi < hi ? 'partly (income is in the phase-out range)' : 'no (income is over the limit)';
}

const $ = c => '$' + Math.round(c / 100).toLocaleString('en-US');
const $d = n => '$' + n.toLocaleString('en-US');
const tops = f => LIMITS.brackets[f].map((t, i) => `${RATES[i]}% to ${$d(t)}`).join('; ') + '; 37% above';
const L = LIMITS;

// The figures alone (what officialCheck verifies), then the rules.
export const FIGURES = `Contribution limits ${YEAR}
- 401(k), 403(b), most 457 plans and the TSP: ${$(L.k401)} of employee contributions (traditional and Roth combined). Catch-up: ${$(L.k401CatchUp)} more at 50 and up, or ${$(L.k401CatchUp6063)} more at ages 60 to 63 instead. Employer match money doesn't count toward this.
- IRA (Roth and traditional combined, per person; a non-working spouse can have one): ${$(L.ira)}, ${$(L.iraCatchUp)} more at 50 and up. Contributions for ${YEAR} can be made until the tax filing deadline in April ${YEAR + 1}.
- Roth IRA income limit (modified AGI): phases out from ${$d(L.rothPhaseout.mfj[0])} to ${$d(L.rothPhaseout.mfj[1])} married filing jointly, ${$d(L.rothPhaseout.single[0])} to ${$d(L.rothPhaseout.single[1])} single or head of household. Over it, a "backdoor" Roth exists; leave the details to a tax professional.
- Traditional IRA deduction when covered by a workplace plan: phases out from $129,000 to $149,000 married filing jointly ($242,000 to $252,000 for a spouse without a plan whose partner has one), $81,000 to $91,000 single. Without a workplace plan it's fully deductible.
- HSA (needs an HSA-eligible high-deductible health plan; from 2026 bronze and catastrophic marketplace plans qualify too): ${$(L.hsaSelf)} self-only coverage, ${$(L.hsaFamily)} family coverage, ${$(L.hsaCatchUp)} more at 55 and up.
- Dependent care FSA: ${$(L.dependentCareFsa)} per household. Health FSA: ${$(L.healthFsa)}.

Taxes ${YEAR}
- Standard deduction: ${$(L.std.mfj)} married filing jointly, ${$(L.std.single)} single or married filing separately, ${$(L.std.hoh)} head of household.
- Brackets, by taxable income. Married filing jointly: ${tops('mfj')}. Single: ${tops('single')}.
- Long-term capital gains and qualified dividends: 0% up to $98,900 of taxable income married filing jointly ($49,450 single), then 15%.
- Child tax credit: $2,200 per child under 17. Saver's credit for retirement contributions: married filing jointly with AGI up to $80,500.
- Interest from Treasury bills, notes and I bonds is free of state income tax; savings account and CD interest is taxed as ordinary income.`;

export const RULES = `Order of priorities (adapt to their facts; the checks on the page follow it)
1. Essentials and every minimum payment; no new credit card balances.
2. A starter emergency fund: about one month of essential spending (at least $1,000 to $2,000) in savings.
3. The full employer 401(k) match: an instant 25% to 100% return. Leaving match money unclaimed is the most expensive common mistake.
4. High-rate debt (about 8% APR and up; credit cards are usually 20%+), highest rate first (avalanche). Smallest balance first (snowball) is fine when motivation matters more.
5. Emergency fund up to 3 to 6 months of essential spending; lean to 6 or more with one income, variable pay, kids or a house. Keep it in high-yield savings or a money market fund, never invested.
6. An HSA, if eligible: tax-free in, tax-free growth, tax-free out for medical costs; it can be invested and kept for the long run.
7. IRAs. Roth when the federal bracket is 12% or lower or income is expected to rise; traditional (if deductible) at 24% and up; at 22% either, or split. Roth contributions (not earnings) can come back out any time, which makes a Roth a flexible backstop.
8. Workplace retirement saving toward 15% of gross pay in total (match included), then toward the limit.
9. Mid-rate debt (about 4% to 8%): a judgment call; splitting extra money between paying it down and investing is reasonable.
10. Goals, taxable investing, then low-rate debt (under about 4% to 5%, often mortgages and some car and student loans) last.

Money by when it's needed
- Within about 3 years (emergency fund, house down payment, next car): high-yield savings, money market funds, Treasury bills, CDs, I bonds (locked for 12 months, lose 3 months of interest if cashed before 5 years, $10,000 per person a year). Not stocks.
- 3 to 5 years and beyond, and retirement: diversified, low-cost investing. Describe categories only (broad index funds, target-date funds); never name a fund, stock or other security. Their comfort with ups and downs shapes the mix.

Rules of thumb
- Housing: total housing cost at or under about 28% of gross income, all debt payments under about 36%. 20% down avoids PMI. Budget 1% to 3% of a home's value a year for upkeep, plus 2% to 5% in closing costs.
- Credit: pay statement balances in full; keep card use under 30%, ideally under 10%; keep old cards open; free reports at annualcreditreport.com.
- Retirement savings, roughly: about 1 times salary by 30, 3 times by 40, 6 times by 50.
- Insurance: term life (about 10 to 12 times income) once anyone depends on that income; disability cover through work when offered; renters or homeowners; an umbrella policy once net worth grows.
- Kids: 529 plans for education (many states give a tax deduction for their own plan); leftover 529 money can roll into the child's Roth IRA (up to $35,000 over a lifetime, after 15 years). Children born 2025 to 2028 get a $1,000 federal deposit in a "Trump account". A dependent care FSA helps with childcare.
- Student loans: federal loans have income-driven repayment and forgiveness programs (studentaid.gov); refinancing them privately gives those up.
- Raises and windfalls: decide the split ahead of time (for example, half to goals, half to enjoy).`;

export const REFERENCE = `<reference_sheet year="${YEAR}">
US federal figures for tax year ${YEAR}, from IRS announcements (<irs_check>, when given, corrects or updates them), and the planning rules to follow.

${FIGURES}

${RULES}
</reference_sheet>`;
