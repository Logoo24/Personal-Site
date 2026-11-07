// "About you two": what Advice can't see in the accounts, typed in once
// on the Advice tab. Household-wide (both people see and edit it), kept in
// the encrypted state as state.profile:
//   { state, filing, kids, risk, plans, people: { [email]: { birthYear,
//     income (cents a year, before tax), plan, matchRate, matchUpTo,
//     contribPct, contribType, hsa, ira, iraThisYear (cents) } },
//     updatedAt, updatedBy }
// Every field is optional. profileFacts() turns it into what the briefing
// and the checks use, worked out in code with this year's figures
// (knowledge.js): ages, combined income, an estimated federal bracket,
// Roth IRA eligibility, employer match left unclaimed, and room left in
// the 401(k), IRA and HSA.

import { updateState, familyDay } from './data.js';
import { financeEmails } from '../session.js';
import { YEAR, FILING, LIMITS, bracketFor, standardDeduction, k401Limit, iraLimit, rothIraAllowed } from './knowledge.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
export const RISK = { cautious: 'Cautious: losses would worry us', balanced: 'In between', growth: 'Comfortable with ups and downs for more growth' };
export const PLANS = { none: 'No plan at work', '401k': '401(k)', '403b': '403(b)', '457': '457', tsp: 'TSP', other: 'Another plan' };
const CONTRIB = { traditional: 'traditional (pre-tax)', roth: 'Roth', both: 'some of each', unsure: 'not sure which' };
const YESNO = { yes: 'yes', no: 'no', unsure: 'not sure' };
const IRA = { none: 'none', roth: 'Roth IRA', traditional: 'traditional IRA', both: 'both' };

/* ---------- saving ---------- */
const pick = (v, table) => (v == null || v === '' ? undefined : Object.hasOwn(table, v) ? v : (() => { throw fail(400, 'One of the choices wasn’t recognized.'); })());
function num(v, lo, hi, label) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `Check ${label}.`);
  return n;
}
const money = (v, hi, label) => { const n = num(v, 0, hi, label); return n === undefined ? undefined : Math.round(n * 100); };
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function saveProfile(input, viewer) {
  input = input || {};
  const year = +familyDay().slice(0, 4);
  const people = {};
  for (const email of financeEmails()) {
    const p = (input.people && Object.hasOwn(input.people, email) && input.people[email]) || {};
    people[email] = clean({
      birthYear: num(p.birthYear, year - 100, year - 14, 'the birth year'),
      income: money(p.income, 10000000, 'the yearly pay'),
      plan: pick(p.plan, PLANS),
      matchRate: num(p.matchRate, 0, 300, 'the match percentage'),
      matchUpTo: num(p.matchUpTo, 0, 50, 'the “up to” percentage'),
      contribPct: num(p.contribPct, 0, 100, 'how much goes in'),
      contribType: pick(p.contribType, CONTRIB),
      hsa: pick(p.hsa, YESNO),
      ira: pick(p.ira, IRA),
      iraThisYear: money(p.iraThisYear, 100000, 'the IRA amount')
    });
  }
  const profile = clean({
    state: pick(input.state, US_STATES),
    filing: pick(input.filing, FILING),
    kids: num(input.kids, 0, 15, 'the number of kids'),
    risk: pick(input.risk, RISK),
    plans: input.plans == null ? undefined : String(input.plans).trim().slice(0, 300) || undefined,
    people, updatedAt: new Date().toISOString(), updatedBy: viewer
  });
  if (profile.kids !== undefined) profile.kids = Math.round(profile.kids);
  return updateState(s => { s.profile = profile; });
}

/* ---------- what Advice uses ---------- */
const dollars = c => Math.round((c || 0) / 100);
export function profileFilled(profile) {
  const p = profile || {};
  return !!(p.filing || p.state || Object.values(p.people || {}).some(x => Object.keys(x).length));
}

// names: email -> first name. Only people on FAMILY_FINANCE_EMAILS.
export function profileFacts(profile, names) {
  const p = profile || {};
  if (!profileFilled(p)) return { filled: false, referenceYear: YEAR };
  const filing = p.filing || null;
  let gross = 0, pretax = 0, anyIncome = false;
  const people = financeEmails().map(email => {
    const x = (p.people || {})[email] || {};
    const age = x.birthYear ? YEAR - x.birthYear : null;
    const out = { name: names[email] || email.split('@')[0], age };
    if (x.income) { out.payBeforeTax = dollars(x.income); gross += x.income; anyIncome = true; }
    if (x.plan) out.workRetirementPlan = PLANS[x.plan];
    const hasPlan = x.plan && x.plan !== 'none';
    if (hasPlan) {
      if (x.matchRate != null && x.matchUpTo != null) out.employerMatch = x.matchRate && x.matchUpTo ? `${x.matchRate}% of what they put in, up to ${x.matchUpTo}% of pay` : 'none';
      if (x.contribPct != null) out.puttingIn = `${x.contribPct}% of pay` + (x.contribType ? ', ' + CONTRIB[x.contribType] : '');
      if (x.income && x.contribPct != null) {
        const yearly = Math.round(x.income * x.contribPct / 100);
        const limit = k401Limit(age || 0);
        out.contributingAYear = dollars(Math.min(yearly, limit));
        out.planLimitThisYear = dollars(limit);
        out.roomLeftUnderLimit = dollars(Math.max(0, limit - yearly));
        if (x.contribType !== 'roth') pretax += Math.round(Math.min(yearly, limit) * (x.contribType === 'both' ? 0.5 : 1));
        if (x.matchRate != null && x.matchUpTo != null) {
          const missed = x.income * Math.max(0, x.matchUpTo - x.contribPct) / 100 * x.matchRate / 100;
          out.employerMatchAYear = dollars(x.income * Math.min(x.contribPct, x.matchUpTo) / 100 * x.matchRate / 100);
          out.matchLeftUnclaimedAYear = dollars(missed);
          out.contributeToGetFullMatch = x.matchUpTo ? `${x.matchUpTo}% of pay` : null;
        }
      }
    }
    if (x.hsa) out.hsaEligiblePlan = YESNO[x.hsa];
    if (x.ira) out.ira = IRA[x.ira];
    if (x.iraThisYear != null || x.ira) {
      const limit = iraLimit(age || 0);
      out.iraPutInThisYear = dollars(x.iraThisYear || 0);
      out.iraRoomLeftThisYear = dollars(Math.max(0, limit - (x.iraThisYear || 0)));
    }
    return out;
  });
  const facts = {
    filled: true, referenceYear: YEAR,
    state: p.state ? US_STATES[p.state] : null,
    filingStatus: filing ? FILING[filing] : null,
    kids: p.kids != null ? p.kids : null,
    comfortWithUpsAndDowns: p.risk ? RISK[p.risk] : null,
    plansAhead: p.plans || null,
    people
  };
  if (anyIncome) {
    facts.combinedPayBeforeTax = dollars(gross);
    const f = filing || 'mfj';
    const taxable = Math.max(0, gross - pretax - standardDeduction(f));
    facts.estimatedTaxableIncome = dollars(taxable);
    facts.estimatedFederalBracket = bracketFor(f, taxable / 100) + '%';
    facts.rothIraAllowed = rothIraAllowed(f, (gross - pretax) / 100);
    facts.taxNote = `Estimated from pay before tax minus traditional 401(k) contributions and the ${YEAR} standard deduction${filing ? '' : ' (assuming married filing jointly)'}; other deductions and income aren't known.`;
  }
  const hsa = people.filter(x => x.hsaEligiblePlan === 'yes');
  if (hsa.length) facts.hsaLimitThisYear = `${'$' + dollars(LIMITS.hsaSelf).toLocaleString('en-US')} self-only or ${'$' + dollars(LIMITS.hsaFamily).toLocaleString('en-US')} family coverage`;
  return facts;
}
