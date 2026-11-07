// Transactions: one encrypted file per month (finance/tx/YYYY-MM.json,
// { month, transactions: [...] }, newest first). Amounts are cents, money
// out negative. A transaction counts as a transfer (left out of income and
// spending) when its category's kind is "transfer" (data.js).
//
// Fields: id, acct, date, auth, amt, name, merchant, raw, cat,
// catSrc (plaid | auto | rule | ai | user), pfc, pending, pendingId, pair
// (the other half of a transfer between our own accounts), note, hidden,
// reviewed (false = in the "Needs review" queue).

import { readSecure, updateSecure } from './vault.js';
import { txPath, familyDay, addMonths, canSee, updateState, ACCOUNT_TYPES } from './data.js';
import { payeeKey, ruleFor, applyRule, isGeneric } from './categorize.js';
import { randomId } from '../recipes.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const emptyMonth = m => () => ({ month: m, transactions: [] });
const byNewest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

export function checkMonth(m) {
  if (!MONTH.test(String(m || ''))) throw fail(400, 'Bad month.');
  return m;
}
export async function readMonth(m) {
  const f = await readSecure(txPath(m), { etag: false });
  return f ? f.data.transactions || [] : [];
}
export const updateMonth = (m, fn) => updateSecure(txPath(m), d => { d.transactions = fn(d.transactions || []) || d.transactions; }, emptyMonth(m));

export function isTransferCat(state, cat) {
  const c = (state.categories || []).find(x => x.id === cat);
  return !!(c && c.kind === 'transfer');
}

// What the browser gets: only transactions on accounts this viewer can see.
export function visibleTx(list, state, viewer) {
  const ok = new Set((state.accounts || []).filter(a => canSee(a, viewer)).map(a => a.id));
  return list.filter(t => ok.has(t.acct));
}

/* ---------- transfers between our own accounts ---------- */
// Pairs money leaving one of our accounts with the same amount arriving in
// another within 3 days, and files both as a transfer (or a card payment,
// or saving). Loan and mortgage payments stay as spending. Leaves alone
// anything the family or a rule already categorized.
export function detectTransfers(list, state) {
  const acct = new Map((state.accounts || []).map(a => [a.id, a]));
  const free = t => !t.pair && !t.pending && t.catSrc !== 'user' && t.catSrc !== 'rule' && acct.has(t.acct);
  const day = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
  const outs = list.filter(t => t.amt < 0 && free(t));
  for (const o of outs) {
    if (o.pair) continue;
    const match = list.find(i => i.amt === -o.amt && i.acct !== o.acct && free(i) && !i.pair && Math.abs(day(i.date) - day(o.date)) <= 3);
    if (!match) continue;
    const from = acct.get(o.acct), to = acct.get(match.acct);
    if (['loan', 'mortgage'].includes(from.type) || ['loan', 'mortgage'].includes(to.type)) continue;
    const cat = from.type === 'credit' || to.type === 'credit' ? 'card-payment'
      : ['investment', 'retirement'].includes(to.type) || (to.type === 'cash' && /sav/i.test(to.name || '')) ? 'saving' : 'transfer';
    for (const t of [o, match]) { t.cat = cat; t.catSrc = 'auto'; t.reviewed = true; }
    o.pair = match.id; match.pair = o.id;
  }
  return list;
}

/* ---------- reading ---------- */
export async function monthList(m, state, viewer) {
  checkMonth(m);
  return { month: m, transactions: visibleTx(await readMonth(m), state, viewer) };
}

// Everything waiting for a look, from the last three months.
export async function reviewList(state, viewer) {
  const cur = familyDay().slice(0, 7);
  const months = [cur, addMonths(cur, -1), addMonths(cur, -2)];
  const lists = await Promise.all(months.map(readMonth));
  const out = [];
  lists.forEach((list, i) => visibleTx(list, state, viewer).forEach(t => { if (t.reviewed === false && !t.hidden) out.push({ ...t, month: months[i] }); }));
  return { transactions: out.sort(byNewest) };
}

/* ---------- editing ---------- */
// edits: [{ id, month, cat?, note?, hidden?, reviewed? }]. rule: { id, month, cat }
// means "always put this merchant in cat": it's saved for future
// transactions and applied to the last six months now.
export async function editTransactions({ edits, rule }, state, viewer) {
  edits = Array.isArray(edits) ? edits.slice(0, 500) : [];
  const cats = new Set((state.categories || []).map(c => c.id));
  const visible = new Set((state.accounts || []).filter(a => canSee(a, viewer)).map(a => a.id));
  const byMonth = {};
  for (const e of edits) {
    checkMonth(e.month);
    if (e.cat !== undefined && e.cat !== null && !cats.has(e.cat)) throw fail(400, 'Unknown category.');
    (byMonth[e.month] = byMonth[e.month] || []).push(e);
  }
  // Picking a category, or confirming one ("Looks right", Done), teaches
  // the payee memory: merchant key -> { cat, name }.
  const learned = {};
  const learn = (t, cat) => { const k = payeeKey(t.raw || t.name); if (k && cat) learned[k] = { cat, name: t.name }; };
  const edited = new Set();
  for (const [m, list] of Object.entries(byMonth)) {
    await updateMonth(m, txs => {
      for (const e of list) {
        const t = txs.find(x => x.id === e.id);
        if (!t || !visible.has(t.acct)) throw fail(404, 'That transaction wasn’t found.');
        edited.add(t.id);
        if (e.cat !== undefined) { t.cat = e.cat; t.catSrc = 'user'; t.reviewed = true; learn(t, e.cat); }
        if (e.note !== undefined) t.note = String(e.note || '').slice(0, 500);
        if (e.hidden !== undefined) t.hidden = !!e.hidden;
        if (e.reviewed !== undefined) { t.reviewed = !!e.reviewed; if (t.reviewed && e.cat === undefined) learn(t, t.cat); }
      }
      return txs;
    });
  }

  // The same merchant's other transactions still waiting for review (the
  // last three months) are sorted the same way now, rather than asking
  // again. Payment apps and checks are left: one name, many purposes.
  let sortedToo = 0;
  const teach = Object.keys(learned).filter(k => !isGeneric(k));
  if (teach.length) {
    const cur = familyDay().slice(0, 7);
    for (const m of [cur, addMonths(cur, -1), addMonths(cur, -2)]) {
      await updateMonth(m, txs => {
        for (const t of txs) {
          if (edited.has(t.id) || t.reviewed !== false || t.hidden || !visible.has(t.acct) || t.catSrc === 'user' || t.catSrc === 'rule') continue;
          const l = learned[payeeKey(t.raw || t.name)];
          if (!l || isGeneric(payeeKey(t.raw || t.name))) continue;
          t.cat = l.cat; t.catSrc = 'learned'; t.reviewed = true; sortedToo++;
        }
        return txs;
      });
    }
  }

  let ruleSaved = null;
  if (rule && rule.id) {
    checkMonth(rule.month);
    if (!cats.has(rule.cat)) throw fail(400, 'Unknown category.');
    const src = (await readMonth(rule.month)).find(t => t.id === rule.id);
    if (!src || !visible.has(src.acct)) throw fail(404, 'That transaction wasn’t found.');
    const text = payeeKey(src.name) || payeeKey(src.raw);
    if (!text) throw fail(400, 'That merchant’s name is too short to make a rule from.');
    ruleSaved = { id: 'r_' + randomId(8), text, label: src.name, cat: rule.cat, createdBy: viewer, createdAt: new Date().toISOString() };
    const cur = familyDay().slice(0, 7);
    for (let k = 0; k < 6; k++) {
      await updateMonth(addMonths(cur, -k), txs => {
        // Only accounts its maker can see: not the other person's "Only me" ones.
        txs.forEach(t => { if (visible.has(t.acct) && t.catSrc !== 'user' && ruleFor(t, [ruleSaved])) applyRule(t, ruleSaved); });
        return txs;
      });
    }
  }

  const saved = await updateState(s => {
    if (ruleSaved) s.rules = (s.rules || []).filter(r => r.text !== ruleSaved.text).concat(ruleSaved);
    s.payees = s.payees || {};
    // Remembered even when Plaid (not Claude) picked it: from now on the
    // family's answer beats Plaid's for this merchant (categorize.js).
    for (const [k, l] of Object.entries(learned)) {
      const prev = s.payees[k] || {};
      s.payees[k] = { name: prev.name || String(l.name || '').slice(0, 60), cat: l.cat, reviewed: true, src: 'user' };
    }
  });
  return { state: saved, sortedToo };
}

/* ---------- hand-added transactions (accounts kept by hand only) ---------- */
export async function addManual(input, state, viewer) {
  const a = (state.accounts || []).find(x => x.id === input.acct);
  if (!a || !canSee(a, viewer)) throw fail(404, 'That account wasn’t found.');
  if (a.src === 'plaid') throw fail(400, 'Linked accounts get their transactions from the bank.');
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > familyDay()) throw fail(400, 'Pick a date, today or earlier.');
  const amt = Math.round(Number(input.amt));
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1e12) throw fail(400, 'Enter an amount.');
  const cats = new Set((state.categories || []).map(c => c.id));
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw fail(400, 'Say what it was for.');
  const t = {
    id: 'm_' + randomId(12), acct: a.id, date, amt, name, raw: name, merchant: null,
    cat: cats.has(input.cat) ? input.cat : null, catSrc: 'user', pending: false, reviewed: true,
    note: String(input.note || '').slice(0, 500), adjusted: input.adjust !== false, createdBy: viewer
  };
  await updateMonth(date.slice(0, 7), txs => txs.concat(t).sort(byNewest));
  if (!t.adjusted) return state;
  // Money in raises what you own and lowers what you owe.
  return updateState(s => {
    const acc = s.accounts.find(x => x.id === a.id);
    if (acc) { acc.balance = (acc.balance || 0) + (ACCOUNT_TYPES[acc.type].side === 'liability' ? -amt : amt); acc.asOf = new Date().toISOString(); }
  });
}

export async function deleteManual(id, month, state, viewer) {
  checkMonth(month);
  if (!String(id).startsWith('m_')) throw fail(400, 'Only transactions added by hand can be deleted.');
  let removed = null;
  await updateMonth(month, txs => {
    const t = txs.find(x => x.id === id);
    const a = t && (state.accounts || []).find(x => x.id === t.acct);
    if (!t || !a || !canSee(a, viewer)) throw fail(404, 'That transaction wasn’t found.');
    removed = t;
    return txs.filter(x => x.id !== id);
  });
  if (!removed.adjusted) return state;
  return updateState(s => {
    const acc = s.accounts.find(x => x.id === removed.acct);
    if (acc) { acc.balance = (acc.balance || 0) - (ACCOUNT_TYPES[acc.type].side === 'liability' ? -removed.amt : removed.amt); acc.asOf = new Date().toISOString(); }
  });
}

/* ---------- export ---------- */
export async function exportCsv(from, to, state, viewer) {
  checkMonth(from); checkMonth(to);
  if (from > to) [from, to] = [to, from];
  const months = [];
  for (let m = from; m <= to && months.length < 36; m = addMonths(m, 1)) months.push(m);
  const lists = await Promise.all(months.map(readMonth));
  const acct = new Map((state.accounts || []).map(a => [a.id, a]));
  const cat = new Map((state.categories || []).map(c => [c.id, c.name]));
  // Text that a spreadsheet would run as a formula (=, +, -, @) gets a
  // leading apostrophe; amounts stay plain numbers.
  const cell = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['Date', 'Account', 'Merchant', 'Description', 'Category', 'Amount', 'Pending', 'Hidden', 'Note']];
  lists.flatMap(l => visibleTx(l, state, viewer)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach(t => {
    const a = acct.get(t.acct);
    rows.push([t.date, a ? (a.nick || a.name) + (a.mask ? ' ••' + a.mask : '') : '', t.name, t.raw, cat.get(t.cat) || '', (t.amt / 100).toFixed(2), t.pending ? 'yes' : '', t.hidden ? 'yes' : '', t.note || '']);
  });
  return new Response('﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="transactions-${from}-to-${to}.csv"`,
      'Cache-Control': 'no-store'
    }
  });
}

/* ---------- for the Reports tab ---------- */
// Up to 24 months boiled down, so the page can draw every report (and
// switch between them) from one request: per month, account and category
// the money in and out; per month and merchant the totals; and each
// month's biggest purchases. Hidden and pending transactions are left out;
// transfers are kept (with their category) and the page leaves them out
// where they'd double count. Computed from the month files each time
// rather than kept as a separate file, so it's never out of date.
export async function reportData(state, viewer, n = 24) {
  n = Math.min(Math.max(Math.round(Number(n)) || 24, 1), 24);
  const cur = familyDay().slice(0, 7);
  const months = [];
  for (let k = n - 1; k >= 0; k--) months.push(addMonths(cur, -k));
  const lists = await Promise.all(months.map(readMonth));
  const rows = [], merchants = [], big = [];
  lists.forEach((list, i) => {
    const m = months[i];
    const byCat = new Map(), byMerch = new Map(), purchases = [];
    for (const t of visibleTx(list, state, viewer)) {
      if (t.hidden || t.pending) continue;
      const k = t.acct + '|' + (t.cat || '');
      const r = byCat.get(k) || { m, a: t.acct, c: t.cat || null, i: 0, o: 0, n: 0 };
      if (t.amt > 0) r.i += t.amt; else r.o -= t.amt;
      r.n++;
      byCat.set(k, r);
      if (isTransferCat(state, t.cat)) continue;
      const mk = t.acct + '|' + t.name;
      const mm = byMerch.get(mk) || { m, a: t.acct, name: t.name, c: t.cat || null, i: 0, o: 0, n: 0, last: t.date };
      if (t.amt > 0) mm.i += t.amt; else mm.o -= t.amt;
      mm.n++;
      if (t.date > mm.last) mm.last = t.date;
      byMerch.set(mk, mm);
      if (t.amt < 0) purchases.push({ m, a: t.acct, name: t.name, c: t.cat || null, amt: -t.amt, date: t.date });
    }
    rows.push(...byCat.values());
    merchants.push(...[...byMerch.values()].sort((x, y) => (y.o + y.i) - (x.o + x.i)).slice(0, 60));
    big.push(...purchases.sort((x, y) => y.amt - x.amt).slice(0, 5));
  });
  return { months, rows, merchants, big };
}

/* ---------- for the Overview ---------- */
// The ten newest, how many are waiting in the review queue (the same three
// months reviewList looks at), and this month's and last month's counted
// transactions in short form ({ acct, date, amt, cat }), so the Overview's
// "This month" card can total them for whichever person is picked.
export async function recentAndReview(state, viewer) {
  if (!(state.accounts || []).length) return { recent: [], toReview: 0, monthTx: [] };
  const cur = familyDay().slice(0, 7);
  const months = [cur, addMonths(cur, -1), addMonths(cur, -2)];
  const lists = await Promise.all(months.map(readMonth));
  const list = visibleTx(lists.flatMap((l, i) => l.map(t => ({ ...t, month: months[i] }))), state, viewer);
  return {
    recent: list.filter(t => !t.hidden).sort(byNewest).slice(0, 10),
    toReview: list.filter(t => t.reviewed === false && !t.hidden).length,
    monthTx: list.filter(t => t.month !== months[2] && !t.hidden && !t.pending && !isTransferCat(state, t.cat))
      .map(t => ({ acct: t.acct, date: t.date, amt: t.amt, cat: t.cat }))
  };
}
