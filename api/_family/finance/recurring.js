// Recurring money, found in the last 14 months of transactions and kept in
// state.recurring. Three shapes, because bills don't all behave alike:
//
//   fixed  - subscriptions and fixed bills: the same price, on the same day
//            (a regular rhythm), like Netflix on the 8th. Charges are grouped
//            by merchant AND price, so Apple's $2.99 and $10.99 are two
//            subscriptions. When one stops and the same merchant carries on
//            at a new price a period later, it's the same subscription with
//            a price change (priceChange, shown until someone taps "Got it").
//   month  - bills that change from month to month (rent, power, gas, water):
//            the merchant's total each month, whatever the number of payments
//            or their days. "Usually about $1,650, in 2 payments around the
//            1st and 15th", and how much of this month's is paid so far.
//            Only for bill categories (BILL_CATS), so groceries aren't one.
//   varies - paychecks and other income, and bills that come every two or
//            three months: a regular rhythm, amounts that may move.
//
// Merchants are matched by seriesKey(): the statement text with numbers and
// banking words dropped ("SPOTIFY P2C4F81A9E" and "SPOTIFY P8D2..." are one).
// The family confirms or dismisses what's found, can add their own (rent by
// check), and can ask for any transaction's merchant to be tracked ("Track
// as recurring", a pinned item: always shown, from whatever's there). A scan
// keeps those decisions, names, amounts and "whose" choices; it refreshes
// the numbers. Scans match items to last time's by shared transactions
// (txIds), then by key, so a price change or a sliding window keeps the id.
//
// Item: { id, v: 2, key, gk (merchant group), dir: in|out, pattern, name,
//   cat, acct, kind: subscription|bill|paycheck|income, cadence, amount
//   (cents, positive: the price now, or the usual month), variable, last,
//   lastDate, nextDate, days (usual days of the month), count, ended,
//   status: detected|confirmed|ignored|manual, txIds, priceChange { from,
//   to, date }, prices [{ amount, since }], (month) low, high, parts,
//   thisMonth, thisMonthCount, thisMonthKey, history [{ m, total }],
//   custom fields... }

import { readMonth } from './transactions.js';
import { updateState, familyDay, addMonths, canSee } from './data.js';
import { payeeKey, fromKeywords } from './categorize.js';
import { randomId } from '../recipes.js';
import { financeEmails } from '../session.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SCAN_MONTHS = 14;
export const CADENCES = {
  weekly: { days: 7, perMonth: 52 / 12, min: 4, grace: 14, window: [5, 9], label: 'Every week' },
  biweekly: { days: 14, perMonth: 26 / 12, min: 3, grace: 24, window: [12, 16], label: 'Every 2 weeks' },
  semimonthly: { days: 15.2, perMonth: 2, min: 4, grace: 25, window: [11, 20], label: 'Twice a month' },
  monthly: { days: 30.4, perMonth: 1, min: 3, grace: 45, window: [24, 38], label: 'Every month' },
  bimonthly: { days: 61, perMonth: 1 / 2, min: 3, grace: 80, window: [52, 70], label: 'Every 2 months' },
  quarterly: { days: 91, perMonth: 1 / 3, min: 3, grace: 120, window: [80, 102], label: 'Every 3 months' },
  yearly: { days: 365, perMonth: 1 / 12, min: 2, grace: 400, window: [350, 380], label: 'Every year' }
};
// Own keys only: a stored "constructor" must not look like a cadence.
const cadenceOrMonthly = c => (Object.hasOwn(CADENCES, c) ? CADENCES[c] : CADENCES.monthly);
const MONTH_STEPS = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };
// Spending that's a bill even when the amount moves around.
const BILL_CATS = new Set(['housing', 'utilities', 'insurance', 'loans', 'kids', 'education']);
// Income that may vary (overtime, interest).
const VARIABLE_IN = new Set(['paycheck', 'other-income']);
// Everyday spending: a same-price repeat once or twice a year isn't a subscription.
const EVERYDAY = new Set(['groceries', 'dining', 'shopping', 'transport']);

/* ---------- dates (YYYY-MM-DD strings, family time) ---------- */
const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
const fromNum = n => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (d, n) => fromNum(dayNum(d) + n);
const gap = (a, b) => dayNum(b) - dayNum(a);
function onDay(month, day) {
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  return month + '-' + String(Math.min(day, last)).padStart(2, '0');
}
const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return !s.length ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function mode(xs) {
  const c = {};
  xs.forEach(x => { c[x] = (c[x] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a]).map(Number);
}
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const dom = d => +d.slice(8, 10);
// Days of the month apart, the short way round (the 30th and the 2nd are 3).
const domDist = (a, b) => { const x = Math.abs(a - b); return Math.min(x, 31 - x); };
// The usual day of the month: the one closest to all the others (so the
// 30th, 31st and 1st give the 31st, not the 16th).
const usualDay = doms => doms.reduce((best, d) => {
  const cost = doms.reduce((s, x) => s + domDist(x, d), 0);
  return cost < best.cost ? { d, cost } : best;
}, { d: doms[0], cost: Infinity }).d;

// The next date after `after` for an item with this cadence, anchored on
// its last date (or its usual days of the month).
export function nextAfter(item, after) {
  const c = item.cadence;
  const d = item.lastDate || item.nextDate || after;
  if (MONTH_STEPS[c]) {
    const day = (item.days && item.days[0]) || dom(d);
    let m = d.slice(0, 7);
    let next = onDay(m, day);
    for (let i = 0; i < 400 && next <= after; i++) { m = addMonths(m, MONTH_STEPS[c]); next = onDay(m, day); }
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
  const step = cadenceOrMonthly(c).days;
  let n = d;
  for (let i = 0; i < 2000 && n <= after; i++) n = addDays(n, Math.round(step));
  return n;
}

/* ---------- merchants ---------- */
// Banking words and anything with a digit in it (reference codes, store and
// phone numbers, dates) vary from one statement line to the next.
const NOISE = new Set(['pos', 'ach', 'debit', 'purchase', 'recurring', 'autopay', 'pymt', 'pmt', 'payment', 'web', 'online', 'ppd', 'ccd', 'ref', 'conf', 'des', 'indn', 'www', 'com', 'to', 'from']);
export function seriesKey(t) {
  const base = payeeKey(t.raw || t.name);
  const words = base.split(' ').filter(w => w && !/\d/.test(w) && !NOISE.has(w));
  return (words.length ? words.join(' ') : base).slice(0, 60);
}
// The merchant group a transaction belongs to: an "Only me" account's
// never shares a series with anyone else's.
export const groupKey = (t, a) => { const k = seriesKey(t); return k && (a && a.private ? k + '~' + a.owner : k); };
// What scans before this one keyed items by (for matching old decisions).
const legacyKey = (t, a) => { const k = payeeKey(t.name) || payeeKey(t.raw); return a && a.private ? k + '~' + a.owner : k; };

/* ---------- fixed: same price, same day ---------- */
// The same price: to the cent, give or take 2 (or a quarter of a percent
// on big ones, for tax rounding). Looser and random purchases start to match.
const samePrice = (a, b) => Math.abs(a - b) <= Math.max(2, Math.round(Math.max(a, b) * 0.0025));
const FREQUENT = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
const fitsWindow = (g, c) => g >= CADENCES[c].window[0] && g <= CADENCES[c].window[1];

// A strict rhythm: every gap fits, allowing a skipped period now and then.
function rhythmOf(dates) {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => gap(dates[i], d));
  const fits = (lo, hi, skips) => {
    let ok = 0, skipped = 0;
    for (const g of gaps) {
      if (g >= lo && g <= hi) ok++;
      else if (skips && g >= lo * 2 && g <= hi * 2) skipped++;
      else return false;
    }
    return ok >= 1 && skipped <= Math.max(1, Math.floor(gaps.length / 4)) && (skipped === 0 || skips);
  };
  const doms = dates.map(dom);
  const steadyDay = () => { const ref = usualDay(doms); return doms.filter(d => domDist(d, ref) <= 4).length >= doms.length * 0.75; };
  if (fits(6, 8)) return 'weekly';
  if (fits(13, 15, true) && gaps.filter(g => g === 14).length >= gaps.length * 0.6) return 'biweekly';
  if (fits(26, 35, true) && steadyDay()) return 'monthly';
  if (fits(11, 20)) {
    const two = mode(doms).slice(0, 2);
    if (two.length === 2 && doms.every(d => two.some(x => domDist(x, d) <= 3))) return 'semimonthly';
  }
  if (fits(56, 66)) return 'bimonthly';
  if (fits(84, 98)) return 'quarterly';
  if (fits(355, 376)) return 'yearly';
  return null;
}

// Every same-price series in one merchant's charges (money out). Returns
// [{ list, amount, cadence, priceChange, prices }].
function fixedSeries(list, subLike) {
  // 1. Charges at the same price, grouped (two on one day count once).
  const pieces = [];
  for (const t of list.slice().sort(byDate)) {
    const a = Math.abs(t.amt);
    let p = pieces.find(x => samePrice(x.amount, a));
    if (!p) pieces.push(p = { amount: a, list: [] });
    if (!p.list.some(x => x.date === t.date)) p.list.push(t);
  }
  pieces.forEach(p => { p.cadence = rhythmOf(p.list.map(t => t.date)); });
  // 2. A price change: a series that stops, and the same merchant one period
  //    later at a new price (not wildly different) that carries on in step.
  const used = new Set();
  const series = pieces.filter(p => p.cadence).sort((a, b) => byDate(a.list[0], b.list[0]));
  for (const s of series) {
    if (used.has(s)) continue;
    s.prices = [{ amount: s.amount, since: s.list[0].date }];
    // Everyday spending (a gas station, a grocer) only counts with a long
    // run at one price, never pieced together from price "changes".
    if (EVERYDAY.has(s.list[0].cat)) continue;
    for (let guard = 0; guard < 6; guard++) {
      const last = s.list[s.list.length - 1].date;
      const next = pieces.filter(p => p !== s && !used.has(p) && p.list[0].date > last &&
        fitsWindow(gap(last, p.list[0].date), s.cadence) &&
        p.amount >= s.amount * 0.5 && p.amount <= s.amount * 2 &&
        (p.cadence === s.cadence || (p.list.length <= 2 && (p.list.length === 1 || fitsWindow(gap(p.list[0].date, p.list[1].date), s.cadence)))))
        .sort((a, b) => byDate(a.list[0], b.list[0]))[0];
      if (!next) break;
      used.add(next);
      s.priceChange = { from: s.amount, to: next.amount, date: next.list[0].date };
      s.prices.push({ amount: next.amount, since: next.list[0].date });
      s.list = s.list.concat(next.list);
      s.amount = next.amount;
    }
  }
  return series.filter(s => {
    if (used.has(s)) return false;
    const c = s.cadence, n = s.list.length, everyday = EVERYDAY.has(s.list[n - 1].cat);
    if (everyday) return FREQUENT.has(c) && n >= Math.max(4, CADENCES[c].min);
    if (c === 'monthly') return n >= (subLike ? 2 : 3);
    return n >= CADENCES[c].min;
  });
}

/* ---------- month: a bill's total each month ---------- */
const billShare = list => list.filter(t => BILL_CATS.has(t.cat)).length / (list.length || 1);
// relaxed: a merchant the family asked to track, shown from even one payment.
function monthTotals(list, today, relaxed) {
  if (!list.length || (!relaxed && billShare(list) < 0.6)) return null;
  const cur = today.slice(0, 7), lastFull = addMonths(cur, -1);
  const by = new Map();
  for (const t of list) {
    const m = t.date.slice(0, 7);
    const e = by.get(m) || { total: 0, list: [] };
    e.total += Math.abs(t.amt); e.list.push(t);
    by.set(m, e);
  }
  const first = [...by.keys()].sort()[0];
  // The last six full months (or since it started), most of them paid.
  const window = [];
  for (let k = 5; k >= 0; k--) { const m = addMonths(lastFull, -k); if (m >= first) window.push(m); }
  const have = window.filter(m => by.has(m));
  if (!relaxed && (have.length < 3 || have.length < window.length * 0.75)) return null;
  const sample = have.length ? have : [cur].filter(m => by.has(m));
  if (!sample.length) return null;
  const recent = sample.slice(-3);
  const amount = Math.round(recent.reduce((s, m) => s + by.get(m).total, 0) / recent.length);
  const totals = sample.map(m => by.get(m).total);
  const parts = Math.max(1, Math.round(median(sample.map(m => by.get(m).list.length))));
  // Usual days: from months paid in that many parts, each part's median day.
  const shaped = sample.map(m => by.get(m).list.slice().sort(byDate)).filter(l => l.length === parts);
  const days = parts > 3 || !shaped.length ? null : Array.from({ length: parts }, (_, i) => Math.round(median(shaped.map(l => dom(l[i].date)))));
  const sorted = list.slice().sort(byDate), t0 = sorted[sorted.length - 1];
  // The usual range, from months paid the usual way (a part paid early, in
  // the month before, would make one month look tiny and the next huge).
  const usual = shaped.length >= 2 ? shaped.map(l => l.reduce((s, t) => s + Math.abs(t.amt), 0)) : totals;
  return {
    list: sorted, t0, amount, parts, days,
    low: Math.min(...usual), high: Math.max(...usual),
    history: window.concat(cur).slice(-7).map(m => ({ m, total: by.has(m) ? by.get(m).total : 0 })),
    thisMonth: by.has(cur) ? by.get(cur).total : 0, thisMonthCount: by.has(cur) ? by.get(cur).list.length : 0, thisMonthKey: cur,
    count: sample.length
  };
}

/* ---------- varies: a rhythm, amounts that may move ---------- */
function cadenceOf(intervals) {
  const m = median(intervals);
  const within = (lo, hi) => intervals.filter(x => x >= lo && x <= hi).length / intervals.length;
  if (m >= 5 && m <= 9 && within(5, 9) >= 0.7) return 'weekly';
  if (m >= 12 && m <= 16 && within(12, 16) >= 0.8 && intervals.every(x => x >= 12 && x <= 16) && intervals.filter(x => x === 14).length / intervals.length >= 0.6) return 'biweekly';
  if (m >= 12 && m <= 18 && within(10, 20) >= 0.75) return 'semimonthly';
  if (m >= 25 && m <= 36 && within(24, 38) >= 0.7) return 'monthly';
  if (m >= 55 && m <= 68 && within(52, 70) >= 0.7) return 'bimonthly';
  if (m >= 80 && m <= 100 && within(75, 105) >= 0.7) return 'quarterly';
  if (m >= 350 && m <= 380) return 'yearly';
  return null;
}
function intervalSeries(list, only) {
  const byDay = new Map();
  for (const t of list) byDay.set(t.date, (byDay.get(t.date) || []).concat(t));
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return null;
  const cadence = cadenceOf(days.slice(1).map((d, i) => gap(days[i], d)));
  if (!cadence || days.length < CADENCES[cadence].min || (only && !only.includes(cadence))) return null;
  const amounts = days.map(d => Math.abs(byDay.get(d).reduce((s, t) => s + t.amt, 0)));
  const typical = median(amounts);
  const stable = amounts.filter(a => Math.abs(a - typical) <= typical * 0.15).length / amounts.length >= 0.7;
  const latest = byDay.get(days[days.length - 1]);
  const t0 = latest[latest.length - 1];
  if (!stable && !VARIABLE_IN.has(t0.cat) && !BILL_CATS.has(t0.cat)) return null;
  const last = amounts[amounts.length - 1];
  return {
    list: list.slice().sort(byDate), t0, cadence, stable, last,
    // Steady ones: what it is now. Varying ones: the average of the last three.
    amount: stable ? (Math.abs(last - typical) <= typical * 0.15 ? last : Math.round(typical)) : Math.round(amounts.slice(-3).reduce((s, a) => s + a, 0) / Math.min(3, amounts.length)),
    count: days.length,
    days: cadence === 'semimonthly' ? mode(days.map(dom)).slice(0, 2) : MONTH_STEPS[cadence] ? [dom(days[days.length - 1])] : null
  };
}

/* ---------- detection ---------- */
const kindIn = cat => (cat === 'paycheck' ? 'paycheck' : 'income');
const isSubLike = t => t.cat === 'subscriptions' || fromKeywords(`${t.name || ''} ${t.raw || ''}`) === 'subscriptions';

// Finds recurring series in a list of transactions. pins: [{ gk, dir }] the
// family asked to track, shown even when nothing else would find them.
export function detect(txs, state, today, pins = []) {
  const transferCats = new Set((state.categories || []).filter(c => c.kind === 'transfer').map(c => c.id));
  const accts = new Map((state.accounts || []).map(a => [a.id, a]));
  const groups = new Map();
  for (const t of txs) {
    if (t.pending || t.hidden || !t.amt || transferCats.has(t.cat)) continue;
    // A deleted account's leftover transactions are skipped.
    const a = accts.get(t.acct);
    if (!a) continue;
    const dir = t.amt < 0 ? 'out' : 'in';
    const gk = groupKey(t, a);
    if (!gk) continue;
    const g = groups.get(dir + ':' + gk) || { gk, dir, list: [] };
    g.list.push(t);
    groups.set(dir + ':' + gk, g);
  }
  const pinned = new Set(pins.map(p => p.dir + ':' + p.gk));
  const found = [];
  const base = (g, s, extra) => {
    const t0 = s.t0 || s.list[s.list.length - 1];
    const lastDate = s.list[s.list.length - 1].date;
    return {
      v: 2, gk: g.gk, dir: g.dir, name: t0.name, cat: t0.cat, acct: t0.acct, lastDate,
      last: Math.abs(s.list[s.list.length - 1].amt), count: s.count || s.list.length,
      txIds: s.list.slice(-4).map(t => t.id), legacyKey: legacyKey(t0, accts.get(t0.acct)),
      _ids: new Set(s.list.map(t => t.id)), ...extra
    };
  };
  for (const [id, g] of groups) {
    const before = found.length;
    let rest = g.list;
    if (g.dir === 'out') {
      let fixed = fixedSeries(g.list, g.list.some(isSubLike));
      // A bill paid every month (power, phone) that happens to repeat a
      // price a few months apart is still one monthly bill.
      if (fixed.some(s => !FREQUENT.has(s.cadence)) && monthTotals(g.list, today, false)) fixed = fixed.filter(s => FREQUENT.has(s.cadence));
      for (const s of fixed) {
        const t0 = s.list[s.list.length - 1];
        const lastDate = t0.date;
        const item = base(g, s, {
          key: g.gk + '@' + s.amount, pattern: 'fixed', variable: false,
          kind: BILL_CATS.has(t0.cat) ? 'bill' : 'subscription', cadence: s.cadence, amount: s.amount,
          ended: gap(lastDate, today) > CADENCES[s.cadence].grace,
          days: s.cadence === 'semimonthly' ? mode(s.list.map(t => dom(t.date))).slice(0, 2) : MONTH_STEPS[s.cadence] ? [usualDay(s.list.slice(-4).map(t => dom(t.date)))] : null,
          priceChange: s.priceChange || null, prices: s.prices.slice(-4)
        });
        // Several at one merchant (Apple): the price tells them apart.
        if (fixed.length > 1) item.name = t0.name + ' (' + (s.amount / 100).toFixed(2) + ')';
        item.nextDate = nextAfter(item, lastDate);
        found.push(item);
      }
      const claimed = new Set(fixed.flatMap(s => s.list.map(t => t.id)));
      rest = g.list.filter(t => !claimed.has(t.id));
    }
    const month = g.dir === 'out' && monthTotals(rest, today, false);
    if (month) found.push(monthItem(g, month, base, today));
    else if (rest.length) {
      const s = g.dir === 'in' ? intervalSeries(rest) : billShare(rest) >= 0.6 ? intervalSeries(rest, ['bimonthly', 'quarterly', 'yearly']) : null;
      if (s) {
        const item = base(g, s, {
          key: g.gk + '@' + (g.dir === 'in' ? 'in' : s.cadence), pattern: 'varies', variable: !s.stable,
          kind: g.dir === 'in' ? kindIn(s.t0.cat) : 'bill', cadence: s.cadence, amount: s.amount, days: s.days,
          ended: gap(s.list[s.list.length - 1].date, today) > CADENCES[s.cadence].grace
        });
        item.nextDate = nextAfter(item, item.lastDate); // may be a little in the past if it's running late
        found.push(item);
      }
    }
    // Something the family asked to track: shown from whatever's there.
    if (found.length === before && pinned.has(id)) {
      const m = monthTotals(g.list, today, true);
      if (m) found.push(monthItem(g, m, base, today));
    }
  }
  return found;
}
function monthItem(g, m, base, today) {
  return base(g, m, {
    key: g.gk + '@month', pattern: 'month', variable: true, cadence: 'monthly',
    kind: g.dir === 'in' ? kindIn(m.t0.cat) : 'bill', amount: m.amount, low: m.low, high: m.high,
    parts: m.parts, days: m.days, history: m.history, thisMonth: m.thisMonth, thisMonthCount: m.thisMonthCount,
    thisMonthKey: m.thisMonthKey, ended: !m.thisMonth && gap(m.list[m.list.length - 1].date, today) > 45
  });
}

// Reads the last 14 months, finds the series and merges them into
// state.recurring, keeping the family's decisions and edits.
const USER_FIELDS = ['status', 'customName', 'customAmount', 'customCadence', 'person', 'note', 'priceSeen', 'pinned'];
export async function scanRecurring() {
  const today = familyDay(), cur = today.slice(0, 7);
  const months = [];
  for (let k = SCAN_MONTHS - 1; k >= 0; k--) months.push(addMonths(cur, -k));
  const txs = (await Promise.all(months.map(readMonth))).flat();
  return updateState(s => {
    const all = s.recurring || [];
    const found = detect(txs, s, today, all.filter(r => r.pinned && r.gk));
    const pool = all.filter(r => r.status !== 'manual');
    const used = new Set();
    // Last time's item for this series: one sharing a transaction, else the
    // same key, else a pinned one for the merchant, else (items from before
    // this version) the old merchant key.
    const match = f => {
      const free = pool.filter(r => !used.has(r.id) && r.dir === f.dir);
      return free.find(r => (r.txIds || []).some(id => f._ids.has(id))) ||
        free.find(r => r.v === 2 && r.key === f.key) ||
        free.find(r => r.pinned && r.gk === f.gk) ||
        free.find(r => !r.v && r.key === f.legacyKey) || null;
    };
    const next = found.map(f => {
      const prev = match(f);
      if (prev) used.add(prev.id);
      const { _ids, legacyKey: _old, ...fields } = f;
      const item = { id: prev ? prev.id : 'rc_' + randomId(10), status: 'detected', ...fields };
      if (prev) for (const k of USER_FIELDS) if (prev[k] !== undefined) item[k] = prev[k];
      return item;
    });
    // Confirmed or dismissed series that weren't found this time are kept
    // (marked ended), so a decision isn't lost if a payment is skipped.
    // Items from the old detector (no v) that the new one doesn't find at
    // all were mostly its mistakes, so they go.
    for (const r of pool) if (!used.has(r.id) && r.status !== 'detected' && r.v === 2) next.push({ ...r, ended: true });
    s.recurring = next.concat(all.filter(r => r.status === 'manual'));
    s.settings = { ...(s.settings || {}), recurringAt: new Date().toISOString() };
  });
}

// "Track as recurring" on a transaction: its merchant is always shown on
// the Recurring tab (confirmed), then a scan fills in the numbers.
export async function trackRecurring(input, state, viewer) {
  const m = String((input && input.month) || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw fail(400, 'Bad month.');
  const t = (await readMonth(m)).find(x => x.id === input.tx);
  const a = t && (state.accounts || []).find(x => x.id === t.acct);
  if (!t || !a || !canSee(a, viewer)) throw fail(404, 'That transaction wasn’t found.');
  const gk = groupKey(t, a), dir = t.amt < 0 ? 'out' : 'in';
  if (!gk) throw fail(400, 'That merchant’s name is too short to follow.');
  let id = null;
  await updateState(s => {
    s.recurring = s.recurring || [];
    const have = s.recurring.find(r => r.gk === gk && r.dir === dir && r.status !== 'manual');
    if (have) { have.pinned = true; if (have.status !== 'manual') have.status = 'confirmed'; id = have.id; return; }
    id = 'rc_' + randomId(10);
    s.recurring.push({ id, v: 2, status: 'confirmed', pinned: true, gk, key: gk + '@month', dir, pattern: 'month', name: t.name, cat: t.cat || null, acct: t.acct, kind: dir === 'in' ? kindIn(t.cat) : 'bill', cadence: 'monthly', amount: Math.abs(t.amt), variable: true, count: 1, lastDate: t.date, txIds: [t.id] });
  });
  return { state: await scanRecurring(), id };
}

/* ---------- what the page sees ---------- */
// A monthly-total bill's expected payments: what's left of this month's
// usual total on the usual days still to come (or late, if they've passed),
// then the next months. [{ date, amount, late, expected }]
function monthDue(r, today, end) {
  const out = [];
  if (!r.days || !r.days.length || r.ended || !r.amount) return out;
  const days = r.days.slice().sort((a, b) => a - b), cur = today.slice(0, 7);
  for (let k = 0; k < 3; k++) {
    const m = addMonths(cur, k);
    const paid = k === 0 ? r.thisMonth || 0 : 0, count = k === 0 ? r.thisMonthCount || 0 : 0;
    const left = r.amount - paid;
    // Paid for the month (give or take $5 or a tenth), or every part is in.
    if (left <= Math.max(500, r.amount * 0.1) || count >= days.length) continue;
    const dates = days.slice(count).map(d => onDay(m, d));
    const per = Math.round(left / dates.length);
    // Parts whose day has passed: one "late" line for today.
    const late = dates.filter(d => d < today);
    if (late.length) out.push({ date: today, late: true, expected: late[0], amount: per * late.length });
    for (const d of dates) if (d >= today && d <= end) out.push({ date: d, amount: per });
  }
  return out;
}

// The effective values, after the family's edits.
export function view(r, today) {
  const cadence = r.pattern === 'month' ? 'monthly' : r.customCadence || r.cadence;
  const v = { ...r, name: r.customName || r.name, amount: r.customAmount != null ? r.customAmount : r.amount, cadence };
  delete v.txIds; delete v.gk;
  if (r.pattern === 'month') {
    if (r.thisMonthKey !== today.slice(0, 7)) { v.thisMonth = 0; v.thisMonthCount = 0; }
    const due = monthDue(v, today, addDays(today, 100))[0];
    v.nextDate = due ? due.expected || due.date : null;
  } else if (r.status === 'manual' || r.customCadence) v.nextDate = r.nextDate && r.nextDate > addDays(today, -1) ? r.nextDate : nextAfter(v, addDays(today, -1));
  v.monthly = Math.round(v.amount * cadenceOrMonthly(cadence).perMonth);
  // A price change worth mentioning: in the last 90 days, and not yet seen.
  v.priceAlert = !!(r.priceChange && r.priceSeen !== r.priceChange.date && !r.ended && r.status !== 'ignored' && gap(r.priceChange.date, today) <= 90);
  return v;
}

// An item tied to an account the viewer can't see, or to one that's been
// deleted (it may have been someone's "Only me"), stays hidden.
export function visibleRecurring(state, viewer) {
  const today = familyDay();
  const acct = new Map((state.accounts || []).map(a => [a.id, a]));
  return (state.recurring || []).filter(r => !r.acct || (acct.has(r.acct) && canSee(acct.get(r.acct), viewer))).map(r => view(r, today));
}

// Everything expected in the next `days` days: recurring items (more than
// once if they repeat inside the window) and card/loan payment due dates.
export function upcoming(state, viewer, days = 30) {
  const today = familyDay(), end = addDays(today, days);
  const out = [];
  for (const r of visibleRecurring(state, viewer)) {
    if (r.status === 'ignored' || r.ended) continue;
    const entry = { id: r.id, name: r.name, dir: r.dir, kind: r.kind, acct: r.acct, status: r.status, variable: r.variable };
    if (r.pattern === 'month') {
      for (const d of monthDue(r, today, end)) out.push({ ...entry, ...d });
      continue;
    }
    let d = r.nextDate, guard = 0;
    // Late but not yet given up on: shown as expected today.
    if (d && d < today) out.push({ ...entry, date: today, late: true, expected: d, amount: r.amount });
    while (d && d <= end && guard++ < 40) {
      if (d >= today) out.push({ ...entry, date: d, amount: r.amount });
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
    if (a.type !== 'credit' && amount && out.some(u => u.dir === 'out' && u.kind === 'bill' && Math.abs(gap(u.date, due)) <= 5 && Math.abs(u.amount - amount) <= amount * 0.1)) continue;
    out.push({ id: 'due_' + a.id, date: due, name: (a.nick || a.name) + ' payment due', amount: amount || null, dir: 'out', kind: 'due', acct: a.id, min: a.minPayment || null });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/* ---------- the family's changes ---------- */
// input: { action: confirm|ignore|restore|edit|add|delete|price-ok|confirm-all, id, ...fields }
export function changeRecurring(input, state, viewer) {
  input = input || {};
  const cats = new Set((state.categories || []).map(c => c.id));
  const today = familyDay();
  const visible = new Set(visibleRecurring(state, viewer).map(r => r.id));
  const kindOf = r => (r.dir === 'in' ? kindIn(r.cat) : r.cat === 'subscriptions' ? 'subscription' : 'bill');
  const clean = (r, f) => {
    if (f.name !== undefined) { const n = String(f.name || '').trim().slice(0, 60); if (r.status === 'manual') r.name = n || r.name; else r.customName = n || undefined; }
    if (f.amount !== undefined) {
      const a = f.amount === null || f.amount === '' ? null : Math.round(Number(f.amount));
      if (a != null && (!Number.isFinite(a) || a <= 0 || a > 1e11)) throw fail(400, 'The amount should be more than zero.');
      if (r.status === 'manual') { if (a == null) throw fail(400, 'Enter an amount.'); r.amount = a; } else r.customAmount = a == null || a === r.amount ? undefined : a;
    }
    if (f.cadence !== undefined && r.pattern !== 'month') {
      if (!Object.hasOwn(CADENCES, f.cadence)) throw fail(400, 'Pick how often it comes.');
      if (r.status === 'manual') r.cadence = f.cadence; else r.customCadence = f.cadence === r.cadence ? undefined : f.cadence;
    }
    if (f.nextDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.nextDate))) throw fail(400, 'Pick the next date.');
      r.nextDate = f.nextDate; r.lastDate = null;
    }
    if (f.person !== undefined) {
      const p = String(f.person || '').toLowerCase();
      if (p && !financeEmails().includes(p)) throw fail(400, 'Pick whose it is.');
      r.person = p || undefined;
    }
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
      r.kind = kindOf(r);
      r.days = MONTH_STEPS[r.cadence] ? [dom(r.nextDate)] : null;
      s.recurring.push(r);
      return;
    }
    // Everything found that the viewer can see, confirmed in one save.
    if (input.action === 'confirm-all') {
      for (const x of s.recurring) if (visible.has(x.id) && x.status === 'detected' && !x.ended) x.status = 'confirmed';
      return;
    }
    const r = s.recurring.find(x => x.id === input.id);
    if (!r || !visible.has(r.id)) throw fail(404, 'That wasn’t found.');
    switch (input.action) {
      case 'confirm': r.status = 'confirmed'; break;
      case 'ignore': r.status = 'ignored'; delete r.pinned; break;
      case 'restore': r.status = 'detected'; break;
      case 'price-ok': if (r.priceChange) r.priceSeen = r.priceChange.date; break;
      case 'delete':
        if (r.status !== 'manual') throw fail(400, 'Only ones you added can be deleted. Use “Not recurring” instead.');
        s.recurring = s.recurring.filter(x => x.id !== r.id);
        break;
      case 'edit':
        clean(r, input);
        if (r.status === 'detected') r.status = 'confirmed';
        if (r.status === 'manual') { r.kind = kindOf(r); r.days = MONTH_STEPS[r.cadence] ? [dom(r.nextDate)] : null; }
        break;
      default: throw fail(400, 'Unknown change.');
    }
  });
}
