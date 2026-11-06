// The Finance data model (see CLAUDE.md, "Finance"). Every file is
// encrypted through vault.js. Amounts are integer cents; on transactions,
// money out is negative. Account balances are positive numbers, and `side`
// says whether the account is something you own or something you owe.
//
//   finance/state.json       people, Plaid items (no tokens), accounts,
//                            categories (+ budgets), rules, payees, recurring,
//                            goals, credit scores, settings
//   finance/secrets.json     { itemId: { accessToken, cursor } }  (sync only)
//   finance/snapshots.json   per-account balances: daily (last 400 days) and
//                            monthly (month-end, kept forever):
//                            { daily: [{ d, b: { id: cents } }],
//                              monthly: [{ m, b, est }] }  est: true (all
//                            estimated) or the ids whose values were typed
//                            in or rebuilt rather than recorded
//   finance/tx/YYYY-MM.json  one month of transactions
//
// "Only me" accounts (private: true) belong to one spouse, and every route
// filters them out for the other through visibleAccounts().

import { readSecure, updateSecure } from './vault.js';
import { financeEmails } from '../session.js';

export const STATE = 'finance/state.json';
export const SECRETS = 'finance/secrets.json';
export const SNAPSHOTS = 'finance/snapshots.json';
export const txPath = month => `finance/tx/${month}.json`;

// kind: income | expense | transfer. essential: counts toward the
// emergency-fund math in Advice.
export const DEFAULT_CATEGORIES = [
  { id: 'paycheck', name: 'Paycheck', kind: 'income' },
  { id: 'other-income', name: 'Other income', kind: 'income' },
  { id: 'housing', name: 'Housing', kind: 'expense', essential: true },
  { id: 'utilities', name: 'Utilities', kind: 'expense', essential: true },
  { id: 'groceries', name: 'Groceries', kind: 'expense', essential: true },
  { id: 'transport', name: 'Gas & transport', kind: 'expense', essential: true },
  { id: 'insurance', name: 'Insurance', kind: 'expense', essential: true },
  { id: 'health', name: 'Health', kind: 'expense', essential: true },
  { id: 'loans', name: 'Loan payments', kind: 'expense', essential: true },
  { id: 'kids', name: 'Kids', kind: 'expense' },
  { id: 'dining', name: 'Dining out', kind: 'expense' },
  { id: 'shopping', name: 'Shopping', kind: 'expense' },
  { id: 'subscriptions', name: 'Subscriptions', kind: 'expense' },
  { id: 'entertainment', name: 'Entertainment', kind: 'expense' },
  { id: 'travel', name: 'Travel', kind: 'expense' },
  { id: 'personal', name: 'Personal care', kind: 'expense' },
  { id: 'home', name: 'Home & garden', kind: 'expense' },
  { id: 'education', name: 'Education', kind: 'expense' },
  { id: 'gifts', name: 'Gifts & giving', kind: 'expense' },
  { id: 'fees', name: 'Fees & interest', kind: 'expense' },
  { id: 'taxes', name: 'Taxes', kind: 'expense' },
  { id: 'other', name: 'Other', kind: 'expense' },
  { id: 'transfer', name: 'Transfers', kind: 'transfer' },
  { id: 'card-payment', name: 'Credit card payment', kind: 'transfer' },
  { id: 'saving', name: 'Saving & investing', kind: 'transfer' }
];

// Account types, in the order the Accounts tab groups them.
export const ACCOUNT_TYPES = {
  cash: { side: 'asset', group: 'Cash' },
  investment: { side: 'asset', group: 'Investments' },
  retirement: { side: 'asset', group: 'Retirement' },
  property: { side: 'asset', group: 'Property & vehicles' },
  vehicle: { side: 'asset', group: 'Property & vehicles' },
  'other-asset': { side: 'asset', group: 'Other assets' },
  credit: { side: 'liability', group: 'Credit cards' },
  loan: { side: 'liability', group: 'Loans' },
  mortgage: { side: 'liability', group: 'Loans' },
  'other-debt': { side: 'liability', group: 'Other debts' }
};

// Days and months are the family's, not the server's (Vercel runs on UTC,
// so an evening visit would otherwise land on tomorrow).
export const FAMILY_TZ = process.env.FAMILY_TIMEZONE || 'America/Boise';
export function familyDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FAMILY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addMonths(m, n) {
  const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function emptyState() {
  return {
    version: 1,
    people: {},
    items: [],
    itemsUsed: 0,
    accounts: [],
    categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
    rules: [],
    payees: {},
    recurring: [],
    goals: [],
    credit: [],
    settings: {}
  };
}
export const emptySnapshots = () => ({ daily: [], monthly: [] });

export async function loadState() {
  const f = await readSecure(STATE, { etag: false });
  return f ? { ...emptyState(), ...f.data } : emptyState();
}
export async function loadSnapshots() {
  const f = await readSecure(SNAPSHOTS, { etag: false });
  return f ? { ...emptySnapshots(), ...f.data } : emptySnapshots();
}
export const updateState = fn => updateSecure(STATE, fn, emptyState);

export function canSee(account, viewer) {
  return !account.private || account.owner === viewer;
}
export function visibleAccounts(state, viewer) {
  return (state.accounts || []).filter(a => canSee(a, viewer));
}

// The two people Finance is for: everyone on FAMILY_FINANCE_EMAILS, named
// from their Google sign-in once they've visited.
export function peopleList(state) {
  return financeEmails().map(email => ({ email, name: (state.people || {})[email] || email.split('@')[0] }));
}

// Records the viewer's first name the first time they open Finance (or when
// it changes), so owner tags can say "Logan" instead of an email.
export async function rememberViewer(state, user) {
  const email = String(user.email).toLowerCase();
  const name = String(user.name || '').trim().split(/\s+/)[0].slice(0, 40) || email.split('@')[0];
  if ((state.people || {})[email] === name) return state;
  return updateState(s => { s.people = { ...(s.people || {}), [email]: name }; });
}

// Snapshots cut down to the accounts this viewer may see.
export function visibleSnapshots(snaps, ids) {
  const keep = new Set(ids);
  const cut = e => {
    const b = {};
    for (const [id, v] of Object.entries(e.b || {})) if (keep.has(id)) b[id] = v;
    const out = { ...e, b };
    if (Array.isArray(e.est)) {
      const est = e.est.filter(id => keep.has(id));
      if (est.length) out.est = est; else delete out.est;
    }
    return out;
  };
  return { monthly: (snaps.monthly || []).map(cut), daily: (snaps.daily || []).slice(-120).map(cut) };
}
