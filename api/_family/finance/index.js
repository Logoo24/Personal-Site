// Finance routes (?r=fin-*), called from api/family.js once it has checked
// the viewer is on FAMILY_FINANCE_EMAILS. Each handler sees only the
// accounts its viewer may see (visibleAccounts).
//
//   GET fin-summary   -> everything the Overview tab draws
//   GET fin-status    -> the hub home card's one-line status

import { vaultReady } from './vault.js';
import { loadState, loadSnapshots, visibleAccounts, visibleSnapshots, peopleList, rememberViewer, ACCOUNT_TYPES } from './data.js';

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

async function summary(user, viewer) {
  let state = await loadState();
  state = await rememberViewer(state, user);
  const accounts = visibleAccounts(state, viewer);
  const snaps = await loadSnapshots();
  return {
    viewer: { email: viewer, name: state.people[viewer] },
    people: peopleList(state),
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

export async function financeRoute(request, url, user, r) {
  if (!vaultReady()) throw fail(503, 'Finance isn’t set up yet (FINANCE_ENCRYPTION_KEY is missing).');
  const viewer = String(user.email).toLowerCase();
  switch (`${request.method} ${r}`) {
    case 'GET fin-summary': return summary(user, viewer);
    case 'GET fin-status': return status(viewer);
  }
  throw fail(404, 'Unknown request');
}
