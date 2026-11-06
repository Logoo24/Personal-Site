// Finance routes (?r=fin-*), called from api/family.js once it has checked
// the viewer is on FAMILY_FINANCE_EMAILS. Each handler sees only the
// accounts its viewer may see (visibleAccounts). Routes that change
// something answer with a fresh summary, so the page redraws without a
// second request.
//
//   GET    fin-summary            -> everything the Overview and Accounts tabs draw
//   GET    fin-status             -> the hub home card's one-line status
//   POST   fin-account  {...}     -> add or edit an account
//   POST   fin-balance  {id, balance}  -> update a hand-kept balance
//   DELETE fin-account&id=        -> delete a hand-kept account (and its history)
//   POST   fin-backfill {rows}    -> type in past month-end balances
//   GET    fin-cron               -> the daily job (Vercel Cron, CRON_SECRET)

import { vaultReady } from './vault.js';
import { loadState, loadSnapshots, visibleAccounts, visibleSnapshots, peopleList, rememberViewer, familyDay, ACCOUNT_TYPES } from './data.js';
import { snapshotNeeded, snapshotToday, applyBackfill } from './snapshots.js';
import { saveAccount, setBalance, deleteAccount } from './accounts.js';
import { safeEqual } from '../session.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

function setup() {
  return {
    encryption: vaultReady(),
    plaid: !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
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

async function summary(user, viewer, state, snaps) {
  state = await rememberViewer(state || await loadState(), user);
  snaps = snaps || await loadSnapshots();
  // Opening Finance doubles as the snapshot when the cron hasn't run yet
  // today or a balance just changed.
  if ((state.accounts || []).length && snapshotNeeded(snaps, state)) snaps = await snapshotToday(state);
  const accounts = visibleAccounts(state, viewer);
  return {
    viewer: { email: viewer, name: state.people[viewer] },
    people: peopleList(state),
    today: familyDay(),
    setup: setup(),
    demo: !!(state.settings && state.settings.demo),
    accounts: accounts.map(publicAccount),
    snapshots: visibleSnapshots(snaps, accounts.map(a => a.id)),
    items: (state.items || []).map(({ id, inst, status, error, lastSync }) => ({ id, inst, status, error, lastSync })),
    itemsUsed: state.itemsUsed || 0,
    lastSync: (state.items || []).reduce((m, i) => (i.lastSync && (!m || i.lastSync > m) ? i.lastSync : m), null)
  };
}

async function status(viewer) {
  const state = await loadState();
  const items = state.items || [];
  return {
    accounts: visibleAccounts(state, viewer).length,
    reconnect: items.filter(i => i.status === 'reconnect').length,
    lastSync: items.reduce((m, i) => (i.lastSync && (!m || i.lastSync > m) ? i.lastSync : m), null)
  };
}

async function body(request) {
  return request.json().catch(() => ({}));
}

export async function financeRoute(request, url, user, r) {
  if (!vaultReady()) throw fail(503, 'Finance isn’t set up yet (FINANCE_ENCRYPTION_KEY is missing).');
  const viewer = String(user.email).toLowerCase();
  switch (`${request.method} ${r}`) {
    case 'GET fin-summary': return summary(user, viewer);
    case 'GET fin-status': return status(viewer);
    case 'POST fin-account': return summary(user, viewer, await saveAccount(await body(request), viewer));
    case 'POST fin-balance': {
      const { id, balance } = await body(request);
      return summary(user, viewer, await setBalance(String(id || ''), balance, viewer));
    }
    case 'DELETE fin-account': return summary(user, viewer, await deleteAccount(url.searchParams.get('id') || '', viewer));
    case 'POST fin-backfill': {
      const state = await loadState();
      const snaps = await applyBackfill((await body(request)).rows, state, viewer);
      return summary(user, viewer, state, snaps);
    }
  }
  throw fail(404, 'Unknown request');
}

// The daily job, called by Vercel Cron (vercel.json -> /api/finance-cron,
// rewritten to ?r=fin-cron) with "Authorization: Bearer <CRON_SECRET>".
export async function financeCron(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw fail(503, 'The daily job isn’t set up (CRON_SECRET is missing).');
  if (!safeEqual(request.headers.get('authorization') || '', 'Bearer ' + secret)) throw fail(401, 'Unauthorized');
  if (!vaultReady()) return { ok: true, skipped: 'Finance isn’t set up (FINANCE_ENCRYPTION_KEY is missing).' };
  const state = await loadState();
  if (!(state.accounts || []).length) return { ok: true, day: familyDay(), accounts: 0 };
  await snapshotToday(state);
  return { ok: true, day: familyDay(), accounts: state.accounts.length };
}
