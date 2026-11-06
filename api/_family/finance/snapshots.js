// Balance history: finance/snapshots.json keeps every account's balance for
// each of the last 400 days and at the end of every month (see data.js).
// Today's snapshot is taken by the daily cron and again whenever Finance is
// opened and balances have changed; the month's entry is simply its latest
// snapshot, so it becomes the month-end once the month is over. Past months
// can also be typed in (applyBackfill), and those values are marked
// estimated so the graph draws them dashed.

import { updateSecure } from './vault.js';
import { SNAPSHOTS, emptySnapshots, familyDay, addMonths, canSee } from './data.js';

const DAILY_KEEP = 400;
const BACKFILL_MONTHS = 36;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function balancesOf(state) {
  const b = {};
  for (const a of state.accounts || []) b[a.id] = a.balance || 0;
  return b;
}
function same(x, y) {
  const kx = Object.keys(x || {}), ky = Object.keys(y || {});
  return kx.length === ky.length && kx.every(k => x[k] === y[k]);
}
const byDay = (a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
const byMonth = (a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : 0);

// True when today's snapshot is missing or the balances have moved since.
export function snapshotNeeded(snaps, state) {
  const today = familyDay(), b = balancesOf(state);
  const daily = snaps.daily || [], last = daily[daily.length - 1];
  const month = (snaps.monthly || []).find(e => e.m === today.slice(0, 7));
  return !last || last.d !== today || !same(last.b, b) || !month || !same(month.b, b);
}

export function snapshotToday(state) {
  const today = familyDay(), m = today.slice(0, 7), b = balancesOf(state);
  return updateSecure(SNAPSHOTS, snaps => {
    snaps.daily = (snaps.daily || []).filter(e => e.d !== today).concat({ d: today, b }).sort(byDay).slice(-DAILY_KEEP);
    snaps.monthly = (snaps.monthly || []).filter(e => e.m !== m).concat({ m, b }).sort(byMonth);
  }, emptySnapshots);
}

// A deleted account leaves the history too, so it stops counting in past months.
export function forgetAccount(id) {
  return updateSecure(SNAPSHOTS, snaps => {
    const strip = e => {
      if (!(id in (e.b || {}))) return e;
      const b = { ...e.b };
      delete b[id];
      const out = { ...e, b };
      if (Array.isArray(e.est)) out.est = e.est.filter(x => x !== id);
      if (Array.isArray(out.est) && !out.est.length) delete out.est;
      return out;
    };
    const keep = e => Object.keys(e.b || {}).length > 0;
    snaps.daily = (snaps.daily || []).map(strip).filter(keep);
    snaps.monthly = (snaps.monthly || []).map(strip).filter(keep);
  }, emptySnapshots);
}

// rows: [{ id, m: 'YYYY-MM', v: cents | null }] for finished months in the
// last three years. A value marks that account's month as typed in
// (estimated); null clears it.
export function applyBackfill(rows, state, viewer) {
  if (!Array.isArray(rows) || !rows.length) throw fail(400, 'Nothing to save.');
  if (rows.length > 1000) throw fail(400, 'That’s too many changes at once.');
  const current = familyDay().slice(0, 7), oldest = addMonths(current, -BACKFILL_MONTHS);
  const accounts = new Map((state.accounts || []).map(a => [a.id, a]));
  const clean = rows.map(r => {
    const a = accounts.get(String(r && r.id));
    if (!a || !canSee(a, viewer)) throw fail(404, 'One of those accounts wasn’t found.');
    const m = String(r.m || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || m >= current || m < oldest) throw fail(400, 'Past months can go back three years, up to last month.');
    let v = null;
    if (r.v != null && r.v !== '') {
      v = Math.round(Number(r.v));
      if (!Number.isFinite(v) || v < 0 || v > 1e13) throw fail(400, 'Amounts must be zero or more.');
    }
    return { id: a.id, m, v };
  });
  return updateSecure(SNAPSHOTS, snaps => {
    const monthly = new Map((snaps.monthly || []).map(e => [e.m, { ...e, b: { ...e.b } }]));
    for (const { id, m, v } of clean) {
      const e = monthly.get(m) || { m, b: {} };
      let est = e.est === true ? Object.keys(e.b) : Array.isArray(e.est) ? e.est.slice() : [];
      if (v == null) { delete e.b[id]; est = est.filter(x => x !== id); }
      else { e.b[id] = v; if (!est.includes(id)) est.push(id); }
      if (est.length) e.est = est; else delete e.est;
      monthly.set(m, e);
    }
    snaps.monthly = [...monthly.values()].filter(e => Object.keys(e.b).length).sort(byMonth);
  }, emptySnapshots);
}
