// Recurring money: subscriptions, bills, paychecks and other regular income,
// found in the last 14 months of transactions and kept in state.recurring.
//
// A merchant counts as recurring when its charges (or deposits) come at a
// steady rhythm (weekly, every two weeks, twice a month, monthly, quarterly,
// yearly) and, for most, at a steady amount (within 15%; bills such as
// power and gas can vary). The family confirms or dismisses what's found
// and can add their own (rent paid by check). A scan keeps those decisions,
// names, amounts and "whose" choices; it only refreshes the numbers.
//
// Item: { id, key, dir: in|out, name, cat, acct, kind: subscription|bill|
//   paycheck|income, cadence, amount (typical, cents, positive), variable,
//   last, prev (amounts), lastDate, nextDate, days (typical days of month),
//   count, status: detected|confirmed|ignored|manual, ended, priceUp
//   { from, to, date }, person (whose paycheck), custom fields... }

import { readMonth } from './transactions.js';
import { updateState, familyDay, addMonths, canSee } from './data.js';
import { payeeKey, fromKeywords } from './categorize.js';
import { randomId } from '../recipes.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SCAN_MONTHS = 14;
export const CADENCES = {
  weekly: { days: 7, perMonth: 52 / 12, min: 4, grace: 14, label: 'Every week' },
  biweekly: { days: 14, perMonth: 26 / 12, min: 4, grace: 24, label: 'Every 2 weeks' },
  semimonthly: { days: 15.2, perMonth: 2, min: 4, grace: 25, label: 'Twice a month' },
  monthly: { days: 30.4, perMonth: 1, min: 3, grace: 45, label: 'Every month' },
  quarterly: { days: 91, perMonth: 1 / 3, min: 2, grace: 120, label: 'Every 3 months' },
  yearly: { days: 365, perMonth: 1 / 12, min: 2, grace: 400, label: 'Every year' }
};
const VARIABLE_OK = new Set(['utilities', 'insurance', 'housing', 'paycheck', 'other-income', 'health', 'loans']);

/* ---------- dates (YYYY-MM-DD strings, family time) ---------- */
const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
const fromNum = n => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (d, n) => fromNum(dayNum(d) + n);
function onDay(month, day) {
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  return month + '-' + String(Math.min(day, last)).padStart(2, '0');
}
const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function mode(xs) {
  const c = {};
  xs.forEach(x => { c[x] = (c[x] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a]).map(Number);
}

// The next date after `after` for an item with this cadence, anchored on
// its last date (or its typical days of the month).
export function nextAfter(item, after) {
  const c = item.cadence;
  let d = item.lastDate || item.nextDate || after;
  if (c === 'monthly' || c === 'quarterly' || c === 'yearly') {
    const step = c === 'monthly' ? 1 : c === 'quarterly' ? 3 : 12;
    const day = (item.days && item.days[0]) || +d.slice(8, 10);
    let m = d.slice(0, 7);
    let next = onDay(m, day);
    for (let i = 0; i < 400 && next <= after; i++) { m = addMonths(m, step); next = onDay(m, day); }
    return next;
  }
  if (c === 'semimonthly') {
    const days = (item.days && item.days.length >= 2 ? item.days.slice(0, 2) : [1, 15]).sort((a, b) => a - b);
    let m = after.slice(0, 7);
    for (let i = 0; i < 4; i++) {
      for (const day of days) { const n = onDay(m, day); if (n > after) return n; }
      m = addMonths(m, 1);
    }
  }
  const step = (CADENCES[c] || CADENCES.monthly).days;
  let n = d;
  for (let i = 0; i < 2000 && n <= after; i++) n = addDays(n, Math.round(step));
  return n;
}

/* ---------- detection ---------- */
function cadenceOf(intervals) {
  const m = median(intervals);
  const within = (lo, hi) => intervals.filter(x => x >= lo && x <= hi).length / intervals.length;
  if (m >= 5 && m <= 9 && within(5, 9) >= 0.7) return 'weekly';
  if (m >= 12 && m <= 16 && within(12, 16) >= 0.8 && intervals.every(x => x >= 12 && x <= 16) && intervals.filter(x => x === 14).length / intervals.length >= 0.6) return 'biweekly';
  if (m >= 12 && m <= 18 && within(10, 20) >= 0.75) return 'semimonthly';
  if (m >= 25 && m <= 36 && within(24, 38) >= 0.7) return 'monthly';
  if (m >= 80 && m <= 100 && within(75, 105) >= 0.7) return 'quarterly';
  if (m >= 350 && m <= 380) return 'yearly';
  return null;
}

function kindOf(dir, cat, name) {
  if (dir === 'in') return cat === 'paycheck' ? 'paycheck' : 'income';
  if (cat === 'subscriptions' || fromKeywords(name) === 'subscriptions') return 'subscription';
  return 'bill';
}

// Finds recurring series in a list of transactions.
export function detect(txs, state, today) {
  const transferCats = new Set((state.categories || []).filter(c => c.kind === 'transfer').map(c => c.id));
  const groups = new Map();
  for (const t of txs) {
    if (t.pending || t.hidden || !t.amt || transferCats.has(t.cat)) continue;
    const dir = t.amt < 0 ? 'out' : 'in';
    const key = payeeKey(t.name) || payeeKey(t.raw);
    if (!key) continue;
    const g = groups.get(dir + ':' + key) || { key, dir, list: [] };
    g.list.push(t);
    groups.set(dir + ':' + key, g);
  }
  const found = [];
  for (const g of groups.values()) {
    // One charge per day (two on the same day count as one occurrence).
    const byDay = new Map();
    for (const t of g.list) byDay.set(t.date, (byDay.get(t.date) || []).concat(t));
    const days = [...byDay.keys()].sort();
    if (days.length < 2) continue;
    const intervals = days.slice(1).map((d, i) => dayNum(d) - dayNum(days[i]));
    const cadence = cadenceOf(intervals);
    if (!cadence || days.length < CADENCES[cadence].min) continue;
    const amounts = days.map(d => Math.abs(byDay.get(d).reduce((s, t) => s + t.amt, 0)));
    const typical = median(amounts);
    const stable = amounts.filter(a => Math.abs(a - typical) <= typical * 0.15).length / amounts.length >= 0.7;
    const latest = byDay.get(days[days.length - 1]);
    const t0 = latest[latest.length - 1];
    if (!stable && !VARIABLE_OK.has(t0.cat)) continue;
    const lastDate = days[days.length - 1];
    const ended = dayNum(today) - dayNum(lastDate) > CADENCES[cadence].grace;
    const last = amounts[amounts.length - 1], prev = amounts[amounts.length - 2];
    const domDays = mode(days.map(d => +d.slice(8, 10)));
    // A price rise: the latest amount, against the one before it last
    // changed, if that change happened in the last 75 days.
    let priceUp = null;
    if (stable && g.dir === 'out') {
      let i = amounts.length - 1;
      while (i > 0 && amounts[i - 1] === last) i--;
      const before = i > 0 ? amounts[i - 1] : null;
      if (before && last > before && last - before >= 50 && (last - before) / before >= 0.02 && dayNum(today) - dayNum(days[i]) <= 75) priceUp = { from: before, to: last, date: days[i] };
    }
    const item = {
      key: g.key, dir: g.dir, name: t0.name, cat: t0.cat, acct: t0.acct,
      kind: kindOf(g.dir, t0.cat, t0.name), cadence,
      // Steady ones: what it costs now (after any price change). Varying
      // ones (power, gas): the average of the last three.
      amount: stable ? (Math.abs(last - typical) <= typical * 0.15 ? last : Math.round(typical)) : Math.round(amounts.slice(-3).reduce((s, a) => s + a, 0) / Math.min(3, amounts.length)),
      variable: !stable, last, prev, lastDate, count: days.length, ended,
      days: cadence === 'semimonthly' ? domDays.slice(0, 2) : cadence === 'monthly' || cadence === 'quarterly' || cadence === 'yearly' ? [+lastDate.slice(8, 10)] : null,
      priceUp
    };
    item.nextDate = nextAfter(item, lastDate); // may be a little in the past if it's running late
    found.push(item);
  }
  return found;
}

// Reads the last 14 months, finds the series and merges them into
// state.recurring, keeping the family's decisions and edits.
const USER_FIELDS = ['status', 'customName', 'customAmount', 'customCadence', 'person', 'note'];
export async function scanRecurring() {
  const today = familyDay(), cur = today.slice(0, 7);
  const months = [];
  for (let k = SCAN_MONTHS - 1; k >= 0; k--) months.push(addMonths(cur, -k));
  const txs = (await Promise.all(months.map(readMonth))).flat();
  return updateState(s => {
    const found = detect(txs, s, today);
    const old = new Map((s.recurring || []).filter(r => r.status !== 'manual').map(r => [r.dir + ':' + r.key, r]));
    const next = found.map(f => {
      const prev = old.get(f.dir + ':' + f.key);
      old.delete(f.dir + ':' + f.key);
      const item = { id: prev ? prev.id : 'rc_' + randomId(10), status: 'detected', ...f };
      if (prev) for (const k of USER_FIELDS) if (prev[k] !== undefined) item[k] = prev[k];
      return item;
    });
    // Confirmed or dismissed series that weren't found this time are kept
    // (marked ended), so a decision isn't lost if a payment is skipped.
    for (const r of old.values()) if (r.status !== 'detected') next.push({ ...r, ended: true });
    s.recurring = next.concat((s.recurring || []).filter(r => r.status === 'manual'));
    s.settings = { ...(s.settings || {}), recurringAt: new Date().toISOString() };
  });
}

/* ---------- what the page sees ---------- */
// The effective values, after the family's edits.
export function view(r, today) {
  const cadence = r.customCadence || r.cadence;
  const v = { ...r, name: r.customName || r.name, amount: r.customAmount != null ? r.customAmount : r.amount, cadence };
  if (r.status === 'manual' || r.customCadence) v.nextDate = r.nextDate && r.nextDate > addDays(today, -1) ? r.nextDate : nextAfter(v, addDays(today, -1));
  v.monthly = Math.round(v.amount * (CADENCES[cadence] || CADENCES.monthly).perMonth);
  return v;
}

export function visibleRecurring(state, viewer) {
  const today = familyDay();
  const acct = new Map((state.accounts || []).map(a => [a.id, a]));
  return (state.recurring || []).filter(r => !r.acct || !acct.has(r.acct) || canSee(acct.get(r.acct), viewer)).map(r => view(r, today));
}

// Everything expected in the next `days` days: recurring items (more than
// once if they repeat inside the window) and card/loan payment due dates.
export function upcoming(state, viewer, days = 30) {
  const today = familyDay(), end = addDays(today, days);
  const out = [];
  for (const r of visibleRecurring(state, viewer)) {
    if (r.status === 'ignored' || r.ended) continue;
    let d = r.nextDate, guard = 0;
    // Late but not yet given up on: shown as expected today.
    if (d && d < today) out.push({ id: r.id, date: today, late: true, expected: d, name: r.name, amount: r.amount, dir: r.dir, kind: r.kind, acct: r.acct, status: r.status });
    while (d && d <= end && guard++ < 40) {
      if (d >= today) out.push({ id: r.id, date: d, name: r.name, amount: r.amount, dir: r.dir, kind: r.kind, acct: r.acct, status: r.status, variable: r.variable });
      d = nextAfter({ ...r, lastDate: d }, d);
    }
  }
  for (const a of state.accounts || []) {
    if (!canSee(a, viewer) || a.hidden || !['credit', 'loan', 'mortgage', 'other-debt'].includes(a.type)) continue;
    let due = a.dueDate;
    if (!due && a.dueDay) due = nextAfter({ cadence: 'monthly', days: [a.dueDay], lastDate: addDays(today, -1) }, addDays(today, -1));
    if (!due || due < today || due > end) continue;
    const amount = a.type === 'credit' ? (a.statementBalance != null ? a.statementBalance : a.minPayment) : a.minPayment;
    // A loan payment already showing as a recurring bill near that date
    // (same amount, give or take 10%) isn't listed twice.
    if (a.type !== 'credit' && amount && out.some(u => u.dir === 'out' && u.kind === 'bill' && Math.abs(dayNum(u.date) - dayNum(due)) <= 5 && Math.abs(u.amount - amount) <= amount * 0.1)) continue;
    out.push({ id: 'due_' + a.id, date: due, name: (a.nick || a.name) + ' payment due', amount: amount || null, dir: 'out', kind: 'due', acct: a.id, min: a.minPayment || null });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/* ---------- the family's changes ---------- */
// input: { action: confirm|ignore|restore|edit|add|delete, id, ...fields }
export function changeRecurring(input, state, viewer) {
  input = input || {};
  const cats = new Set((state.categories || []).map(c => c.id));
  const today = familyDay();
  const visible = new Set(visibleRecurring(state, viewer).map(r => r.id));
  const clean = (r, f) => {
    if (f.name !== undefined) { const n = String(f.name || '').trim().slice(0, 60); if (r.status === 'manual') r.name = n || r.name; else r.customName = n || undefined; }
    if (f.amount !== undefined) {
      const a = f.amount === null || f.amount === '' ? null : Math.round(Number(f.amount));
      if (a != null && (!Number.isFinite(a) || a <= 0 || a > 1e11)) throw fail(400, 'The amount should be more than zero.');
      if (r.status === 'manual') { if (a == null) throw fail(400, 'Enter an amount.'); r.amount = a; } else r.customAmount = a == null ? undefined : a;
    }
    if (f.cadence !== undefined) {
      if (!CADENCES[f.cadence]) throw fail(400, 'Pick how often it comes.');
      if (r.status === 'manual') r.cadence = f.cadence; else r.customCadence = f.cadence === r.cadence ? undefined : f.cadence;
    }
    if (f.nextDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.nextDate))) throw fail(400, 'Pick the next date.');
      r.nextDate = f.nextDate; r.lastDate = null;
    }
    if (f.person !== undefined) r.person = f.person || undefined;
    if (f.note !== undefined) r.note = String(f.note || '').slice(0, 300) || undefined;
    if (f.cat !== undefined && r.status === 'manual') r.cat = cats.has(f.cat) ? f.cat : null;
  };
  return updateState(s => {
    s.recurring = s.recurring || [];
    if (input.action === 'add') {
      const dir = input.dir === 'in' ? 'in' : 'out';
      const r = { id: 'rc_' + randomId(10), status: 'manual', key: null, dir, cat: null, acct: null, count: 0, createdBy: viewer };
      if (!String(input.name || '').trim()) throw fail(400, 'Give it a name.');
      clean(r, { name: input.name, amount: input.amount, cadence: input.cadence || 'monthly', nextDate: input.nextDate || today, cat: input.cat });
      r.kind = dir === 'in' ? (r.cat === 'paycheck' ? 'paycheck' : 'income') : r.cat === 'subscriptions' ? 'subscription' : 'bill';
      r.days = ['monthly', 'quarterly', 'yearly'].includes(r.cadence) ? [+r.nextDate.slice(8, 10)] : null;
      s.recurring.push(r);
      return;
    }
    const r = s.recurring.find(x => x.id === input.id);
    if (!r || !visible.has(r.id)) throw fail(404, 'That wasn’t found.');
    switch (input.action) {
      case 'confirm': r.status = 'confirmed'; break;
      case 'ignore': r.status = 'ignored'; break;
      case 'restore': r.status = 'detected'; break;
      case 'delete':
        if (r.status !== 'manual') throw fail(400, 'Only ones you added can be deleted. Use “Not recurring” instead.');
        s.recurring = s.recurring.filter(x => x.id !== r.id);
        break;
      case 'edit':
        clean(r, input);
        if (r.status === 'detected') r.status = 'confirmed';
        if (r.status === 'manual') { r.kind = r.dir === 'in' ? (r.cat === 'paycheck' ? 'paycheck' : 'income') : r.cat === 'subscriptions' ? 'subscription' : 'bill'; r.days = ['monthly', 'quarterly', 'yearly'].includes(r.cadence) ? [+r.nextDate.slice(8, 10)] : null; }
        break;
      default: throw fail(400, 'Unknown change.');
    }
  });
}
