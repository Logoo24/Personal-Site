// Bringing Plaid data in: linking a bank, the daily (and on-demand) sync,
// reconnecting, removing, and the one-time rebuild of past month-ends from
// a new connection's transaction history.
//
// A sync asks Plaid about every connection in parallel, then merges it all
// in one pass: accounts and their balances (plus card/loan rates and due
// dates), new and changed transactions into their month files (keeping the
// family's edits, and carrying them over when a pending charge posts),
// transfer pairing, categories (Claude for merchants nothing else knows),
// holdings, and today's balance snapshot.

import { readSecure, updateSecure } from './vault.js';
import { SECRETS, loadState, updateState, familyDay, addMonths, ACCOUNT_TYPES, canSee } from './data.js';
import * as P from './plaid.js';
import { categorize, categorizeWithClaude, payeeKey } from './categorize.js';
import { readMonth, updateMonth, detectTransfers } from './transactions.js';
import { snapshotToday, fillHistory } from './snapshots.js';
import { randomId } from '../recipes.js';
import { financeEmails } from '../session.js';

export const HOLDINGS = 'finance/holdings.json';
const MAX_ITEMS = 10; // Plaid Trial: 10 connections, ever
const fail = (status, message) => Object.assign(new Error(message), { status });
const cents = v => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const emptySecrets = () => ({ items: {} });

async function secrets() {
  const f = await readSecure(SECRETS, { etag: false });
  return f ? f.data.items || {} : {};
}

/* ---------- linking ---------- */
export async function newLinkToken(state, viewer, itemId) {
  if (!itemId && (state.itemsUsed || 0) >= MAX_ITEMS) throw fail(400, 'All 10 of Plaid’s free bank connections have been used. Accounts can still be added by hand.');
  let accessToken;
  if (itemId) {
    const it = (state.items || []).find(i => i.id === itemId);
    if (!it || !canSee({ private: it.private, owner: it.owner }, viewer)) throw fail(404, 'That bank connection wasn’t found.');
    accessToken = ((await secrets())[itemId] || {}).accessToken;
    if (!accessToken) throw fail(404, 'That bank connection wasn’t found.');
  }
  return { linkToken: await P.linkToken({ email: viewer, accessToken }) };
}

export async function linkBank({ publicToken, institution, owner, private: priv }, viewer) {
  if (!publicToken) throw fail(400, 'Missing the bank sign-in.');
  const { accessToken, itemId } = await P.exchange(String(publicToken));
  // The token first: if anything after this fails, the connection isn't lost.
  await updateSecure(SECRETS, s => { s.items = s.items || {}; s.items[itemId] = { accessToken, cursor: null }; }, emptySecrets);
  const inst = String((institution && institution.name) || '').slice(0, 80) || await P.institutionName(institution && institution.institution_id);
  const who = priv ? viewer : (owner === 'joint' || financeEmails().includes(String(owner || '').toLowerCase()) ? String(owner).toLowerCase() : 'joint');
  await updateState(s => {
    if ((s.items || []).some(i => i.id === itemId)) return;
    s.itemsUsed = (s.itemsUsed || 0) + 1;
    s.items = (s.items || []).concat({
      id: itemId, inst: inst || 'Bank', instId: (institution && institution.institution_id) || null,
      owner: who, private: !!priv, createdBy: viewer, createdAt: new Date().toISOString(), status: 'ok', lastSync: null
    });
  });
  return syncAll({ only: itemId });
}

// After update mode: the bank is signed in again.
export async function reconnected(itemId) {
  await updateState(s => { const it = (s.items || []).find(i => i.id === itemId); if (it) { it.status = 'ok'; it.error = null; } });
  return syncAll({ only: itemId });
}

// Stops syncing a connection. Its accounts stay, turned into hand-kept
// accounts with their history, so nothing disappears from past months.
export async function removeBank(itemId, viewer) {
  const state = await loadState();
  const it = (state.items || []).find(i => i.id === itemId);
  if (!it || !canSee({ private: it.private, owner: it.owner }, viewer)) throw fail(404, 'That bank connection wasn’t found.');
  const sec = (await secrets())[itemId];
  if (sec && sec.accessToken) await P.removeItem(sec.accessToken).catch(e => { if (e.code !== 'ITEM_NOT_FOUND') throw e; });
  await updateSecure(SECRETS, s => { if (s.items) delete s.items[itemId]; }, emptySecrets);
  return updateState(s => {
    s.items = (s.items || []).filter(i => i.id !== itemId);
    (s.accounts || []).forEach(a => {
      if (a.itemId !== itemId) return;
      a.src = 'manual'; a.unlinkedAt = new Date().toISOString();
      delete a.itemId; delete a.plaidId; delete a.persistentId;
    });
  });
}

/* ---------- pieces of a sync ---------- */
async function fetchItem(item, secret, deadline, live) {
  try {
    const tx = await P.syncTransactions(secret.accessToken, secret.cursor, deadline);
    const { accounts } = await P.getAccounts(secret.accessToken, live);
    const types = new Set(accounts.map(a => a.type));
    const holdings = types.has('investment') || types.has('brokerage') ? await P.getHoldings(secret.accessToken) : null;
    const liabilities = types.has('credit') || types.has('loan') ? await P.getLiabilities(secret.accessToken) : null;
    return { item, tx, accounts, holdings, liabilities };
  } catch (e) {
    return { item, error: e.code || 'ERROR', relink: P.RELINK_CODES.includes(e.code) };
  }
}

function titleCase(s) {
  return String(s || '').split(' ').filter(Boolean).slice(0, 4).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function toTx(t, acctId) {
  const raw = t.original_description || t.name || '';
  return {
    id: t.transaction_id, acct: acctId, date: t.date, auth: t.authorized_date || null,
    amt: -cents(t.amount), // Plaid: positive = money out. Ours: money out is negative.
    name: t.merchant_name || titleCase(payeeKey(raw)) || 'Transaction', merchant: t.merchant_name || null,
    raw, pfc: t.personal_finance_category ? t.personal_finance_category.detailed : null,
    pending: !!t.pending, pendingId: t.pending_transaction_id || null, channel: t.payment_channel || null
  };
}
// The family's own edits survive a modified transaction and a pending charge posting.
const KEEP = ['note', 'hidden', 'reviewed'];
function keepEdits(next, prev) {
  if (!prev) return next;
  if (prev.catSrc === 'user' || prev.catSrc === 'rule') { next.cat = prev.cat; next.catSrc = prev.catSrc; next.reviewed = true; }
  for (const k of KEEP) if (prev[k] !== undefined && (k !== 'reviewed' || prev.catSrc === 'user')) next[k] = prev[k];
  if (prev.pair) next.pair = prev.pair;
  return next;
}

function mergeAccounts(s, item, list, liabilities, now) {
  const map = {};
  for (const pa of list) {
    let a = s.accounts.find(x => x.src === 'plaid' && x.itemId === item.id && (x.plaidId === pa.account_id || (pa.persistent_account_id && x.persistentId === pa.persistent_account_id)));
    const type = P.accountType(pa);
    if (!a) {
      a = { id: 'a_' + randomId(12), src: 'plaid', itemId: item.id, type, side: ACCOUNT_TYPES[type].side, owner: item.owner, private: !!item.private,
        hidden: false, inNetWorth: true, notes: '', createdAt: now };
      // The same joint account linked from both logins: keep one, hide the copy.
      const twin = s.accounts.find(x => x.src === 'plaid' && x.itemId !== item.id && x.mask && x.mask === pa.mask && x.inst === item.inst && x.type === type);
      if (twin) { a.hidden = true; a.inNetWorth = false; a.dupOf = twin.id; a.notes = 'Looks like the same account as ' + (twin.nick || twin.name) + ', linked twice.'; }
      s.accounts.push(a);
    }
    a.plaidId = pa.account_id; a.persistentId = pa.persistent_account_id || a.persistentId || null;
    a.inst = item.inst; a.name = pa.name || pa.official_name || 'Account'; a.mask = pa.mask || null; a.subtype = pa.subtype || null;
    if (!a.typeSet) { a.type = type; a.side = ACCOUNT_TYPES[type].side; }
    const b = pa.balances || {};
    a.balance = cents(b.current != null ? b.current : b.available) || 0;
    a.available = cents(b.available);
    if (b.limit != null) a.limit = cents(b.limit);
    a.asOf = now;
    map[pa.account_id] = a.id;
  }
  const L = (liabilities && liabilities.liabilities) || {};
  const byPlaid = id => s.accounts.find(x => x.src === 'plaid' && x.plaidId === id);
  for (const c of L.credit || []) {
    const a = byPlaid(c.account_id); if (!a) continue;
    const apr = (c.aprs || []).find(x => x.apr_type === 'purchase_apr') || (c.aprs || [])[0];
    if (apr && apr.apr_percentage != null) a.apr = apr.apr_percentage;
    a.minPayment = cents(c.minimum_payment_amount); a.dueDate = c.next_payment_due_date || null;
    a.statementBalance = cents(c.last_statement_balance); a.overdue = !!c.is_overdue;
  }
  for (const l of L.student || []) {
    const a = byPlaid(l.account_id); if (!a) continue;
    if (l.interest_rate_percentage != null) a.apr = l.interest_rate_percentage;
    a.minPayment = cents(l.minimum_payment_amount); a.dueDate = l.next_payment_due_date || null;
  }
  for (const m of L.mortgage || []) {
    const a = byPlaid(m.account_id); if (!a) continue;
    if (m.interest_rate && m.interest_rate.percentage != null) a.apr = m.interest_rate.percentage;
    a.minPayment = cents(m.next_monthly_payment); a.dueDate = m.next_payment_due_date || null;
  }
  return map;
}

/* ---------- the sync ---------- */
// opts: only (one item id), live (real-time balances, for "Refresh now"),
// budgetMs (how long to spend asking Plaid).
export async function syncAll(opts = {}) {
  const started = Date.now(), deadline = started + (opts.budgetMs || 35000);
  const sec = await secrets();
  let state = await loadState();
  const items = (state.items || []).filter(i => (!opts.only || i.id === opts.only) && sec[i.id]);
  if (!items.length) return state;

  const results = await Promise.all(items.map(it => fetchItem(it, sec[it.id], deadline, opts.live)));
  const ok = results.filter(r => !r.error);
  const now = new Date().toISOString();

  // 1. Accounts, item status, and new transactions categorized.
  const added = [], modified = [], removed = new Set();
  const pfcById = {};
  state = await updateState(s => {
    added.length = 0; modified.length = 0; removed.clear();
    for (const r of results) {
      const it = (s.items || []).find(i => i.id === r.item.id);
      if (!it) continue;
      if (r.error) { it.status = r.relink ? 'reconnect' : 'error'; it.error = r.error; continue; }
      it.status = 'ok'; it.error = null; it.lastSync = now;
      if (r.tx.status === 'HISTORICAL_UPDATE_COMPLETE') it.historyComplete = true;
      const map = mergeAccounts(s, it, r.accounts, r.liabilities, now);
      for (const t of r.tx.added) if (map[t.account_id]) { const x = toTx(t, map[t.account_id]); pfcById[x.id] = t.personal_finance_category; added.push(x); }
      for (const t of r.tx.modified) if (map[t.account_id]) { const x = toTx(t, map[t.account_id]); pfcById[x.id] = t.personal_finance_category; modified.push(x); }
      for (const t of r.tx.removed) removed.add(t.transaction_id);
    }
    added.concat(modified).forEach(t => categorize(t, s, pfcById[t.id]));
  });

  // 2. Claude, for merchants nothing else recognized (remembered in payees).
  const unsure = added.filter(t => !t.cat || t.reviewed === false);
  if (unsure.length && process.env.ANTHROPIC_API_KEY && Date.now() < started + 45000) {
    const copy = JSON.parse(JSON.stringify(state));
    if (await categorizeWithClaude(unsure, copy)) state = await updateState(s => { s.payees = { ...(s.payees || {}), ...copy.payees }; });
  }

  // 3. Transactions into their months. Removals are looked for in this
  //    month, the two before it, and any month being written anyway.
  // New transactions are paired with each other first, so a card payment
  // that leaves checking on the 31st and lands on the card on the 1st still
  // matches; each month then pairs what's left against what it already had.
  detectTransfers(added.concat(modified), state);
  const changes = {};
  for (const t of added.concat(modified)) (changes[t.date.slice(0, 7)] = changes[t.date.slice(0, 7)] || []).push(t);
  const cur = familyDay().slice(0, 7);
  const months = new Set(Object.keys(changes));
  if (removed.size) [cur, addMonths(cur, -1), addMonths(cur, -2)].forEach(m => months.add(m));
  const carried = {}; // removed pending charge id -> the family's edits on it
  for (const m of [...months].sort()) {
    await updateMonth(m, txs => {
      const byId = new Map(txs.map(t => [t.id, t]));
      for (const id of removed) {
        const old = byId.get(id);
        if (old) { carried[id] = old; byId.delete(id); }
      }
      for (const t of changes[m] || []) {
        const prev = byId.get(t.id) || (t.pendingId && (carried[t.pendingId] || byId.get(t.pendingId)));
        if (t.pendingId) byId.delete(t.pendingId);
        byId.set(t.id, keepEdits(t, prev));
      }
      return detectTransfers([...byId.values()], state).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    });
  }

  // 4. Holdings, for the Investments views and Advice.
  const withHoldings = ok.filter(r => r.holdings);
  if (withHoldings.length) {
    await updateSecure(HOLDINGS, h => {
      h.items = h.items || {};
      for (const r of withHoldings) {
        const map = {};
        (state.accounts || []).forEach(a => { if (a.itemId === r.item.id) map[a.plaidId] = a.id; });
        h.items[r.item.id] = {
          asOf: now,
          holdings: (r.holdings.holdings || []).filter(x => map[x.account_id]).map(x => ({
            acct: map[x.account_id], security: x.security_id, qty: x.quantity, price: x.institution_price, value: cents(x.institution_value), cost: cents(x.cost_basis)
          })),
          securities: (r.holdings.securities || []).map(x => ({ id: x.security_id, name: x.name, ticker: x.ticker_symbol, type: x.type, cash: !!x.is_cash_equivalent }))
        };
      }
    }, () => ({ items: {} }));
  }

  // 5. Cursors, so the next sync picks up where this one stopped.
  await updateSecure(SECRETS, s => {
    for (const r of ok) if (s.items && s.items[r.item.id]) s.items[r.item.id].cursor = r.tx.cursor;
  }, emptySecrets);

  // 6. Today's balances, and (once per connection, when Plaid has the full
  //    history) past month-ends rebuilt from its transactions.
  await snapshotToday(state);
  const ready = (state.items || []).filter(i => i.historyComplete && !i.rebuilt && ok.some(r => r.item.id === i.id));
  if (ready.length && Date.now() < started + 50000) {
    await rebuildFromHistory(state, ready.map(i => i.id));
    state = await updateState(s => { (s.items || []).forEach(i => { if (ready.some(r => r.id === i.id)) i.rebuilt = true; }); });
  }
  return updateState(s => { s.settings = { ...(s.settings || {}), lastSyncAt: now }; });
}

// Month-end balances for a new connection's cash and card accounts, walked
// back from today's balance through its transactions (up to 24 months).
// Only empty months are filled, and they're marked estimated. Investment
// accounts can't be rebuilt this way (prices move), so their first known
// value is carried back a year, also marked estimated, to be corrected in
// "Edit past months".
async function rebuildFromHistory(state, itemIds) {
  const accts = (state.accounts || []).filter(a => a.src === 'plaid' && itemIds.includes(a.itemId));
  if (!accts.length) return;
  const cur = familyDay().slice(0, 7);
  const months = [];
  for (let k = 24; k >= 0; k--) months.push(addMonths(cur, -k));
  const lists = await Promise.all(months.map(readMonth));
  const txs = lists.flat().filter(t => !t.pending);
  const values = []; // { id, m, v }
  for (const a of accts) {
    if (a.type === 'investment' || a.type === 'retirement') {
      for (let k = 1; k <= 12; k++) values.push({ id: a.id, m: addMonths(cur, -k), v: a.balance || 0 });
      continue;
    }
    if (!['cash', 'credit'].includes(a.type)) continue;
    const mine = txs.filter(t => t.acct === a.id);
    if (!mine.length) continue;
    const first = mine.reduce((m, t) => (t.date < m ? t.date : m), mine[0].date).slice(0, 7);
    const owe = ACCOUNT_TYPES[a.type].side === 'liability';
    for (let m = first; m < cur; m = addMonths(m, 1)) {
      const end = addMonths(m, 1) + '-01';
      const after = mine.reduce((sum, t) => sum + (t.date >= end ? t.amt : 0), 0);
      values.push({ id: a.id, m, v: owe ? (a.balance || 0) + after : (a.balance || 0) - after });
    }
  }
  if (values.length) await fillHistory(values);
}
