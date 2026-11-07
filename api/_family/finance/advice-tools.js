// Tools Claude can call while answering a question on the Advice tab
// (askAdvice in advice.js). They run here, on the family's own data, and
// return exact figures, so answers don't rest on estimates:
//   spending        totals of money out or in, by category, merchant or
//                   month, over up to 24 months
//   recurring       their subscriptions, bills and regular income
//   accounts        balances (and rates) of the accounts the viewer can see
//   debt_payoff     months and interest to pay off a debt, with and
//                   without extra payments
//   savings_growth  where savings get to at a given rate, or how long a
//                   target takes
// Like the rest of Advice they send totals and names, never account numbers
// or a list of transactions, and only from accounts the viewer can see.
// Each call returns { result, label } (label: shown under the answer as
// "Looked up: ...") or { error }.

import { readMonth, visibleTx, isTransferCat } from './transactions.js';
import { visibleAccounts, familyDay, addMonths } from './data.js';
import { visibleRecurring, CADENCES } from './recurring.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const usd = c => Math.round(c) / 100; // cents -> dollars with cents
const monthLabel = m => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const LOOKUP_TOOLS = [
  {
    name: 'spending',
    description: 'Exact totals from the household\'s own transactions (accounts the viewer can see; moves between their own accounts left out; refunds netted). Use it for any question about how much they spent or earned, where, or when, instead of estimating. Covers the last 24 months; the current month is still in progress.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'First month, YYYY-MM.' },
        to: { type: 'string', description: 'Last month, YYYY-MM (inclusive).' },
        group_by: { type: 'string', enum: ['category', 'merchant', 'month'], description: 'How to break the total down.' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out = spending (default), in = income.' },
        category: { type: 'string', description: 'Only this category (its name, e.g. "Dining out").' },
        merchant: { type: 'string', description: 'Only merchants whose name contains this text.' },
        limit: { type: 'integer', description: 'Most groups to return (default 12, at most 25; months always all).' }
      },
      required: ['from', 'to', 'group_by']
    }
  },
  {
    name: 'recurring',
    description: 'Their recurring subscriptions, bills and regular income as found in their transactions or added by hand: name, amount, how often, a monthly equivalent, and any recent price change.',
    input_schema: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['subscription', 'bill', 'income', 'all'] } }, required: [] }
  },
  {
    name: 'accounts',
    description: 'The accounts the viewer can see: name, type, whose, current balance, and interest rate, credit limit and minimum payment where known.',
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    name: 'debt_payoff',
    description: 'Exact payoff math for a debt: months to pay it off and total interest at a monthly payment, and how much sooner and cheaper with an extra amount each month. Name one of their debts (balance, rate and minimum come from the account) or give balance and APR directly.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        debt: { type: 'string', description: 'Part of one of their debt account names.' },
        balance: { type: 'number', description: 'Dollars, if not using one of their debts.' },
        apr: { type: 'number', description: 'Annual percentage rate, e.g. 22.9.' },
        monthly_payment: { type: 'number', description: 'Dollars a month (defaults to the account\'s minimum).' },
        extra_monthly: { type: 'number', description: 'Extra dollars a month to compare against.' }
      },
      required: []
    }
  },
  {
    name: 'savings_growth',
    description: 'Exact growth math with monthly compounding: the balance after some years at an assumed annual rate, or (with target) how many months it takes to reach a target. Say the rate is an assumption, not a promise.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        start: { type: 'number', description: 'Dollars to start with.' },
        monthly: { type: 'number', description: 'Dollars added each month.' },
        annual_rate: { type: 'number', description: 'Assumed yearly rate in percent, e.g. 4.2.' },
        years: { type: 'number', description: 'How many years (when not using target).' },
        target: { type: 'number', description: 'A goal in dollars: returns the months it takes.' }
      },
      required: ['annual_rate']
    }
  }
];

// One question's tool calls share the month files they read.
export function toolContext(state, viewer) {
  const months = new Map();
  return { state, viewer, month: m => { if (!months.has(m)) months.set(m, readMonth(m)); return months.get(m); } };
}

const bad = msg => ({ error: msg });
const finite = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export async function runTool(name, input, ctx) {
  input = input && typeof input === 'object' ? input : {};
  try {
    switch (name) {
      case 'spending': return await spending(input, ctx);
      case 'recurring': return recurring(input, ctx);
      case 'accounts': return accounts(ctx);
      case 'debt_payoff': return debtPayoff(input, ctx);
      case 'savings_growth': return growth(input);
      default: return bad('Unknown tool.');
    }
  } catch (e) {
    console.error('Finance advice: tool failed', name, e && e.constructor && e.constructor.name);
    return bad('That lookup failed.');
  }
}

/* ---------- spending ---------- */
async function spending(input, { state, viewer, month }) {
  const cur = familyDay().slice(0, 7), oldest = addMonths(cur, -23);
  let from = MONTH.test(input.from) ? input.from : addMonths(cur, -2);
  let to = MONTH.test(input.to) ? input.to : cur;
  if (from > to) [from, to] = [to, from];
  if (from < oldest) from = oldest;
  if (to > cur) to = cur;
  if (from > to) return bad('Those months are outside the last 24.');
  const months = [];
  for (let m = from; m <= to && months.length < 24; m = addMonths(m, 1)) months.push(m);
  const dir = input.direction === 'in' ? 'in' : 'out';
  const by = ['category', 'merchant', 'month'].includes(input.group_by) ? input.group_by : 'category';
  const cats = new Map((state.categories || []).map(c => [c.id, c]));
  let catFilter = null;
  if (input.category) {
    const q = String(input.category).toLowerCase().trim();
    const hit = (state.categories || []).find(c => c.id === q || c.name.toLowerCase() === q) || (state.categories || []).find(c => c.name.toLowerCase().includes(q));
    if (!hit) return bad('No category called "' + String(input.category).slice(0, 40) + '". Categories: ' + (state.categories || []).map(c => c.name).join(', ') + '.');
    catFilter = hit.id;
  }
  const merch = input.merchant ? String(input.merchant).toLowerCase().trim().slice(0, 60) : '';
  const groups = new Map();
  let total = 0, count = 0;
  for (const m of months) {
    for (const t of visibleTx(await month(m), state, viewer)) {
      if (t.hidden || t.pending || !t.amt || isTransferCat(state, t.cat)) continue;
      const kind = (cats.get(t.cat) || {}).kind || null;
      if (dir === 'out' ? !(kind === 'expense' || (!kind && t.amt < 0)) : !(kind === 'income' || (!kind && t.amt > 0))) continue;
      if (catFilter && t.cat !== catFilter) continue;
      if (merch && !`${t.name || ''} ${t.raw || ''}`.toLowerCase().includes(merch)) continue;
      const v = dir === 'out' ? -t.amt : t.amt;
      const key = by === 'month' ? m : by === 'merchant' ? t.name || 'Unknown' : (cats.get(t.cat) || {}).name || 'Uncategorized';
      const g = groups.get(key) || { name: key, total: 0, transactions: 0, months: new Set() };
      g.total += v; g.transactions++; g.months.add(m);
      groups.set(key, g);
      total += v; count++;
    }
  }
  let list = [...groups.values()];
  if (by === 'month') list = months.map(m => groups.get(m) || { name: m, total: 0, transactions: 0, months: new Set() });
  else list.sort((a, b) => b.total - a.total);
  const limit = by === 'month' ? list.length : Math.min(Math.max(Math.round(Number(input.limit)) || 12, 1), 25);
  const shown = list.slice(0, limit);
  const what = (dir === 'out' ? 'Spending' : 'Income') + (catFilter ? ' on ' + cats.get(catFilter).name : '') + (merch ? ' at “' + merch + '”' : '');
  return {
    label: `${what}, ${from === to ? monthLabel(from) : monthLabel(from) + ' to ' + monthLabel(to)}`,
    result: {
      from, to, months: months.length, direction: dir === 'out' ? 'money out (spending, refunds netted)' : 'money in (income)',
      groupedBy: by, total: usd(total), transactions: count,
      averagePerMonth: usd(total / months.length),
      groups: shown.map(g => ({ name: g.name, total: usd(g.total), transactions: g.transactions, ...(by === 'month' ? {} : { monthsWithAny: g.months.size }) })),
      ...(list.length > shown.length ? { otherGroups: list.length - shown.length, otherTotal: usd(list.slice(limit).reduce((s, g) => s + g.total, 0)) } : {}),
      ...(to === cur ? { note: `${cur} is still in progress.` } : {})
    }
  };
}

/* ---------- recurring ---------- */
function recurring(input, { state, viewer }) {
  const kind = ['subscription', 'bill', 'income'].includes(input.kind) ? input.kind : 'all';
  const list = visibleRecurring(state, viewer).filter(r => r.status !== 'ignored' && !r.ended)
    .filter(r => kind === 'all' || (kind === 'income' ? r.dir === 'in' : r.dir === 'out' && r.kind === kind));
  return {
    label: kind === 'all' ? 'Your recurring bills, subscriptions and income' : kind === 'income' ? 'Your regular income' : `Your ${kind}s`,
    result: list.map(r => ({
      name: r.name, kind: r.kind, moneyIn: r.dir === 'in',
      amount: usd(r.amount), amountChanges: !!r.variable,
      howOften: r.pattern === 'month' ? 'monthly total, changes each month' : (CADENCES[r.cadence] || {}).label || r.cadence,
      perMonth: usd(r.monthly), confirmed: r.status !== 'detected',
      ...(r.priceChange ? { priceChange: { from: usd(r.priceChange.from), to: usd(r.priceChange.to), on: r.priceChange.date } } : {})
    }))
  };
}

/* ---------- accounts ---------- */
function accounts({ state, viewer }) {
  const names = state.people || {};
  return {
    label: 'Your account balances',
    result: visibleAccounts(state, viewer).filter(a => !a.hidden).map(a => ({
      name: a.nick || a.name, type: a.type, owes: a.side === 'liability',
      whose: a.owner === 'joint' ? 'joint' : names[a.owner] || 'one of them',
      balance: usd(a.balance || 0),
      ...(a.apr != null ? { ratePercent: a.apr } : {}),
      ...(a.limit ? { creditLimit: usd(a.limit) } : {}),
      ...(a.minPayment != null ? { minimumPayment: usd(a.minPayment) } : {})
    }))
  };
}

/* ---------- debt payoff ---------- */
function simulate(balance, apr, payment) {
  const r = apr / 1200;
  let b = balance, months = 0, interest = 0;
  while (b > 0.5 && months < 600) {
    const i = b * r;
    if (payment <= i + 0.5) return null; // never pays off
    interest += i; b = b + i - Math.min(payment, b + i); months++;
  }
  return months >= 600 ? null : { months, interest };
}
function monthsFromNow(n) {
  const d = familyDay().slice(0, 7);
  return monthLabel(addMonths(d, n));
}
function debtPayoff(input, { state, viewer }) {
  let name = 'the debt', balance = input.balance, apr = input.apr, payment = input.monthly_payment;
  if (input.debt) {
    const q = String(input.debt).toLowerCase();
    const debts = visibleAccounts(state, viewer).filter(a => a.side === 'liability' && !a.hidden && (a.balance || 0) > 0);
    const a = debts.find(x => (x.nick || x.name).toLowerCase().includes(q));
    if (!a) return bad('No debt matching "' + String(input.debt).slice(0, 40) + '". Their debts: ' + (debts.map(x => x.nick || x.name).join(', ') || 'none') + '.');
    name = a.nick || a.name;
    if (balance == null) balance = (a.balance || 0) / 100;
    if (apr == null) apr = a.apr;
    if (payment == null && a.minPayment) payment = a.minPayment / 100;
  }
  if (!finite(balance, 1, 1e8)) return bad('Give the balance in dollars.');
  if (!finite(apr, 0, 60)) return bad('Give the APR (the account has no rate on file).');
  if (!finite(payment, 1, 1e7)) return bad('Give a monthly payment in dollars (no minimum is on file).');
  const extra = finite(input.extra_monthly, 0, 1e7) ? input.extra_monthly : 0;
  const c = x => Math.round(x * 100) / 100;
  const base = simulate(balance, apr, payment);
  const out = { debt: name, balance: c(balance), aprPercent: apr, monthlyPayment: c(payment) };
  if (!base) out.atThisPayment = 'The payment doesn\'t cover the interest, so the balance never goes down.';
  else Object.assign(out, { months: base.months, paidOffAround: monthsFromNow(base.months), totalInterest: c(base.interest) });
  if (extra) {
    const more = simulate(balance, apr, payment + extra);
    out.withExtra = { extraMonthly: c(extra), ...(more ? { months: more.months, paidOffAround: monthsFromNow(more.months), totalInterest: c(more.interest) } : { note: 'Still doesn\'t cover the interest.' }) };
    if (base && more) Object.assign(out.withExtra, { monthsSooner: base.months - more.months, interestSaved: c(base.interest - more.interest) });
  }
  return { label: `Payoff math for ${name}`, result: out };
}

/* ---------- savings growth ---------- */
function growth(input) {
  const start = finite(input.start, 0, 1e9) ? input.start : 0;
  const monthly = finite(input.monthly, 0, 1e7) ? input.monthly : 0;
  if (!finite(input.annual_rate, 0, 20)) return bad('Give an annual rate between 0 and 20 percent.');
  const r = input.annual_rate / 1200;
  const c = x => Math.round(x * 100) / 100;
  const after = n => (r ? start * Math.pow(1 + r, n) + monthly * (Math.pow(1 + r, n) - 1) / r : start + monthly * n);
  const out = { start: c(start), monthly: c(monthly), annualRatePercent: input.annual_rate, assumption: 'The rate is an assumption, held steady; real returns vary.' };
  if (finite(input.target, 1, 1e10)) {
    if (input.target <= start) out.monthsToTarget = 0;
    else {
      let n = 0;
      while (n < 1200 && after(n) < input.target) n++;
      if (n >= 1200) out.monthsToTarget = null; else Object.assign(out, { target: c(input.target), monthsToTarget: n, reachedAround: monthsFromNow(n), contributed: c(start + monthly * n) });
    }
  } else {
    if (!finite(input.years, 0.08, 60)) return bad('Give a number of years, or a target.');
    const n = Math.round(input.years * 12), end = after(n);
    Object.assign(out, { years: input.years, endBalance: c(end), contributed: c(start + monthly * n), growth: c(end - start - monthly * n) });
  }
  return { label: 'Savings growth math', result: out };
}
