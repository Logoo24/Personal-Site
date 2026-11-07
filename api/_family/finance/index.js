// Finance routes (?r=fin-*), called from api/family.js once it has checked
// the viewer is on FAMILY_FINANCE_EMAILS. Each handler sees only the
// accounts (and bank connections, and transactions) its viewer may see.
// Routes that change something answer with a fresh summary, so the page
// redraws without a second request.
//
//   GET    fin-summary                  -> everything the Overview and Accounts tabs draw
//   GET    fin-status                   -> the hub home card's one-line status
//   POST   fin-account  {...}           -> add or edit an account
//   POST   fin-balance  {id, balance}   -> update a hand-kept balance
//   DELETE fin-account&id=              -> delete a hand-kept account (and its history)
//   POST   fin-backfill {rows}          -> type in past month-end balances
//   POST   fin-link-token {itemId?}     -> a Plaid Link token (new bank, or reconnect)
//   POST   fin-link {publicToken, institution, owner, private} -> finish linking a bank
//   POST   fin-reconnected {itemId}     -> a bank was signed in again (update mode)
//   DELETE fin-item&id=                 -> stop syncing a bank (its accounts stay, hand-kept)
//   POST   fin-sync {live?}             -> sync now (at most every 10 minutes)
//   GET    fin-holdings                 -> investment holdings
//   GET    fin-transactions&month=      -> one month's transactions
//   GET    fin-review                   -> transactions waiting for a look
//   POST   fin-tx-edit {edits, rule?}   -> recategorize, note, hide, mark reviewed
//   POST   fin-tx {...}                 -> add a transaction to a hand-kept account
//   DELETE fin-tx&id=&month=            -> delete a hand-added transaction
//   GET    fin-export&from=&to=         -> CSV download
//   GET    fin-reports&months=          -> up to 24 months summed up for the Reports tab
//   POST   fin-budgets {budgets}        -> set monthly budgets ({ categoryId: cents | null })
//   POST   fin-goal {...}               -> add / edit a goal, or { id, add } to a hand-kept one
//   DELETE fin-goal&id=                 -> delete a goal
//   GET    fin-advice                   -> facts, rule cards and the cached briefing
//   POST   fin-advice {refresh:true}    -> write a new briefing with Claude (5 a day)
//   POST   fin-advice-ask {question, history} -> Claude answers a question about it, with lookup tools (30 a day)
//   POST   fin-profile {...}            -> save "About you two" (household profile for Advice) -> advice payload
//   POST   fin-credit {...}             -> add / edit a credit score
//   DELETE fin-credit&id=               -> delete one
//   POST   fin-credit-read (image body) -> a score read from a screenshot (nothing saved)
//   POST   fin-recurring {action, ...}  -> scan for recurring money, track a transaction's merchant ({action: track, tx, month}), or confirm /
//                                          dismiss / edit / add / delete one
//   GET    fin-logo&inst=               -> a linked bank's logo (PNG), for banks the viewer can see
//   GET    fin-cron                     -> the daily job (Vercel Cron, CRON_SECRET)

import { vaultReady, readSecure } from './vault.js';
import { loadState, loadSnapshots, visibleAccounts, visibleSnapshots, peopleList, rememberViewer, familyDay, canSee, ACCOUNT_TYPES } from './data.js';
import { snapshotNeeded, snapshotToday, applyBackfill } from './snapshots.js';
import { saveAccount, setBalance, deleteAccount } from './accounts.js';
import { plaidConfigured, institutionLogo } from './plaid.js';
import { updateSecure } from './vault.js';
import { newLinkToken, linkBank, reconnected, removeBank, syncAll, HOLDINGS } from './sync.js';
import { monthList, reviewList, editTransactions, addManual, deleteManual, exportCsv, recentAndReview, reportData } from './transactions.js';
import { scanRecurring, trackRecurring, visibleRecurring, upcoming, changeRecurring } from './recurring.js';
import { setBudgets, saveGoal, deleteGoal, visibleGoals } from './plan.js';
import { visibleCredit, saveCredit, deleteCredit, readScreenshot, MODELS, BUREAUS } from './credit.js';
import { advice, askAdvice } from './advice.js';
import { saveProfile } from './profile.js';
import { safeEqual } from '../session.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SYNC_EVERY_MS = 10 * 60 * 1000;

function setup() {
  return {
    encryption: vaultReady(),
    plaid: plaidConfigured(),
    plaidEnv: process.env.PLAID_ENV || 'sandbox',
    claude: !!process.env.ANTHROPIC_API_KEY,
    cron: !!process.env.CRON_SECRET
  };
}

// What the browser gets for an account: no Plaid internals.
function publicAccount(a) {
  const { plaidId, persistentId, ...rest } = a;
  return { ...rest, side: rest.side || (ACCOUNT_TYPES[rest.type] || {}).side || 'asset' };
}
const visibleItems = (state, viewer) => (state.items || []).filter(i => canSee({ private: i.private, owner: i.owner }, viewer));
const lastSyncOf = items => items.reduce((m, i) => (i.lastSync && (!m || i.lastSync > m) ? i.lastSync : m), null);

async function summary(user, viewer, state, snaps) {
  state = await rememberViewer(state || await loadState(), user);
  snaps = snaps || await loadSnapshots();
  // Opening Finance doubles as the snapshot when the cron hasn't run yet
  // today or a balance just changed.
  if ((state.accounts || []).length && snapshotNeeded(snaps, state)) snaps = await snapshotToday(state);
  const accounts = visibleAccounts(state, viewer);
  const items = visibleItems(state, viewer);
  const tx = await recentAndReview(state, viewer);
  return {
    viewer: { email: viewer, name: state.people[viewer] },
    people: peopleList(state),
    today: familyDay(),
    setup: setup(),
    demo: !!(state.settings && state.settings.demo),
    accounts: accounts.map(publicAccount),
    snapshots: visibleSnapshots(snaps, accounts.map(a => a.id)),
    categories: state.categories,
    recent: tx.recent,
    toReview: tx.toReview,
    monthTx: tx.monthTx,
    recurring: visibleRecurring(state, viewer),
    upcoming: upcoming(state, viewer, 30),
    recurringAt: (state.settings && state.settings.recurringAt) || null,
    goals: visibleGoals(state, viewer),
    credit: visibleCredit(state, viewer),
    creditModels: MODELS,
    creditBureaus: BUREAUS,
    items: items.map(({ id, inst, instId, status, error, lastSync, owner, private: p, historyComplete, createdAt }) => ({ id, inst, instId: instId || null, status, error, lastSync, owner, private: !!p, historyComplete: !!historyComplete, createdAt })),
    itemsUsed: state.itemsUsed || 0,
    itemsMax: 10,
    lastSync: lastSyncOf(items)
  };
}

async function status(viewer) {
  const state = await loadState();
  const items = visibleItems(state, viewer);
  return {
    accounts: visibleAccounts(state, viewer).length,
    reconnect: items.filter(i => i.status === 'reconnect').length,
    lastSync: lastSyncOf(items)
  };
}

// A bank's logo, asked of Plaid once and kept (encrypted, like everything
// under finance/) in logos.json. Only for a bank the viewer can see, so the
// other spouse's "Only me" bank isn't given away. No logo: a 404, and the
// page shows the bank's initials instead.
const LOGOS = 'finance/logos.json';
async function logo(state, viewer, inst) {
  const none = () => new Response('No logo', { status: 404, headers: { 'Cache-Control': 'private, max-age=86400' } });
  if (!/^ins_\w{1,40}$/.test(inst) || !visibleItems(state, viewer).some(i => i.instId === inst)) return none();
  let entry = ((await readSecure(LOGOS, { etag: false }).catch(() => null)) || { data: {} }).data[inst];
  if (!entry && plaidConfigured()) {
    let found = { logo: null, color: null };
    try { found = await institutionLogo(inst); } catch (e) { return none(); } // try again another day
    entry = { logo: found.logo, color: found.color, at: new Date().toISOString() };
    await updateSecure(LOGOS, d => { d[inst] = entry; }, () => ({}));
  }
  if (!entry || !entry.logo) return none();
  return new Response(Buffer.from(entry.logo, 'base64'), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' }
  });
}

async function body(request) {
  return request.json().catch(() => ({}));
}

async function holdings(state, viewer) {
  const f = await readSecure(HOLDINGS, { etag: false });
  const ok = new Set(visibleAccounts(state, viewer).map(a => a.id));
  const out = { holdings: [], securities: {} };
  for (const it of Object.values((f && f.data.items) || {})) {
    const held = new Set();
    for (const h of it.holdings || []) if (ok.has(h.acct)) { out.holdings.push(h); held.add(h.security); }
    // Only what the viewer's own holdings refer to: the list itself would
    // name what's in the other spouse's "Only me" accounts.
    for (const s of it.securities || []) if (held.has(s.id)) out.securities[s.id] = s;
  }
  return out;
}

export async function financeRoute(request, url, user, r) {
  if (!vaultReady()) throw fail(503, 'Finance isn’t set up yet (FINANCE_ENCRYPTION_KEY is missing).');
  const viewer = String(user.email).toLowerCase();
  const q = k => url.searchParams.get(k) || '';
  switch (`${request.method} ${r}`) {
    case 'GET fin-summary': return summary(user, viewer);
    case 'GET fin-status': return status(viewer);

    case 'POST fin-account': return summary(user, viewer, await saveAccount(await body(request), viewer));
    case 'POST fin-balance': {
      const { id, balance } = await body(request);
      return summary(user, viewer, await setBalance(String(id || ''), balance, viewer));
    }
    case 'DELETE fin-account': return summary(user, viewer, await deleteAccount(q('id'), viewer));
    case 'POST fin-backfill': {
      const state = await loadState();
      const snaps = await applyBackfill((await body(request)).rows, state, viewer);
      return summary(user, viewer, state, snaps);
    }

    case 'POST fin-link-token': return newLinkToken(await loadState(), viewer, (await body(request)).itemId || null);
    case 'POST fin-link': return summary(user, viewer, await linkBank(await body(request), viewer));
    case 'POST fin-reconnected': {
      const { itemId } = await body(request);
      const state = await loadState();
      const it = visibleItems(state, viewer).find(i => i.id === itemId);
      if (!it) throw fail(404, 'That bank connection wasn’t found.');
      return summary(user, viewer, await reconnected(it.id));
    }
    case 'DELETE fin-item': return summary(user, viewer, await removeBank(q('id'), viewer));
    case 'POST fin-sync': {
      const { live } = await body(request);
      const state = await loadState();
      const last = state.settings && state.settings.lastSyncAt;
      if (last && Date.now() - new Date(last) < SYNC_EVERY_MS) return { ...(await summary(user, viewer, state)), synced: false };
      return { ...(await summary(user, viewer, await syncAll({ live: !!live }))), synced: true };
    }
    case 'GET fin-holdings': return holdings(await loadState(), viewer);
    case 'GET fin-logo': return logo(await loadState(), viewer, q('inst'));

    case 'GET fin-transactions': return monthList(q('month'), await loadState(), viewer);
    case 'GET fin-review': return reviewList(await loadState(), viewer);
    case 'POST fin-tx-edit': {
      const r = await editTransactions(await body(request), await loadState(), viewer);
      return { ...(await summary(user, viewer, r.state)), sortedToo: r.sortedToo };
    }
    case 'POST fin-tx': return summary(user, viewer, await addManual(await body(request), await loadState(), viewer));
    case 'DELETE fin-tx': return summary(user, viewer, await deleteManual(q('id'), q('month'), await loadState(), viewer));
    case 'GET fin-export': return exportCsv(q('from'), q('to'), await loadState(), viewer);
    case 'GET fin-reports': return reportData(await loadState(), viewer, q('months') || 24);

    case 'POST fin-budgets': return summary(user, viewer, await setBudgets(await body(request), viewer));
    case 'POST fin-goal': return summary(user, viewer, await saveGoal(await body(request), viewer));
    case 'DELETE fin-goal': return summary(user, viewer, await deleteGoal(q('id'), viewer));

    case 'GET fin-advice': return advice(await loadState(), viewer);
    case 'POST fin-advice': return advice(await loadState(), viewer, { refresh: !!(await body(request)).refresh });
    case 'POST fin-advice-ask': return askAdvice(await loadState(), viewer, await body(request));
    case 'POST fin-profile': return advice(await saveProfile(await body(request), viewer), viewer);

    case 'POST fin-credit': return summary(user, viewer, await saveCredit(await body(request), viewer));
    case 'DELETE fin-credit': return summary(user, viewer, await deleteCredit(q('id'), viewer));
    case 'POST fin-credit-read':
      return readScreenshot(Buffer.from(await request.arrayBuffer()), (request.headers.get('content-type') || '').split(';')[0]);

    case 'POST fin-recurring': {
      const input = await body(request);
      if (input.action === 'scan') return summary(user, viewer, await scanRecurring());
      if (input.action === 'track') {
        const r = await trackRecurring(input, await loadState(), viewer);
        return { ...(await summary(user, viewer, r.state)), trackedId: r.id };
      }
      return summary(user, viewer, await changeRecurring(input, await loadState(), viewer));
    }
  }
  throw fail(404, 'Unknown request');
}

// The daily job, called by Vercel Cron (vercel.json -> /api/finance-cron,
// rewritten to ?r=fin-cron) with "Authorization: Bearer <CRON_SECRET>":
// syncs every bank and takes today's balance snapshot.
export async function financeCron(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw fail(503, 'The daily job isn’t set up (CRON_SECRET is missing).');
  if (!safeEqual(request.headers.get('authorization') || '', 'Bearer ' + secret)) throw fail(401, 'Unauthorized');
  if (!vaultReady()) return { ok: true, skipped: 'Finance isn’t set up (FINANCE_ENCRYPTION_KEY is missing).' };
  let state = await loadState();
  if ((state.items || []).length && plaidConfigured()) state = await syncAll({ budgetMs: 40000 });
  else if ((state.accounts || []).length) { await snapshotToday(state); state = await scanRecurring(); }
  const items = state.items || [];
  return { ok: true, day: familyDay(), accounts: (state.accounts || []).length, banks: items.length, reconnect: items.filter(i => i.status === 'reconnect').length };
}
