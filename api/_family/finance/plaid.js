// Plaid's REST API with plain fetch (no SDK), like gcal.js. Read-only
// products only: Transactions, Investments, Liabilities, Balance. Nothing
// here can move money.
//
// Env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production),
// PLAID_REDIRECT_URI (optional; https, registered in the Plaid dashboard,
// for OAuth banks on phones). Errors are logged by code only, never with
// tokens, amounts or merchants.

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

export function plaidConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}
function host() {
  return (process.env.PLAID_ENV || 'sandbox') === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

// Codes that mean the bank needs the person to sign in again (update mode).
export const RELINK_CODES = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'INVALID_CREDENTIALS', 'INVALID_MFA', 'ITEM_NOT_FOUND'];
// Codes that just mean "this bank doesn't have that" - not a problem.
export const SKIP_CODES = ['PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_READY', 'NO_INVESTMENT_ACCOUNTS', 'NO_LIABILITY_ACCOUNTS', 'PRODUCT_NOT_ENABLED', 'ADDITIONAL_CONSENT_REQUIRED', 'NO_ACCOUNTS'];

export async function plaid(path, body = {}) {
  if (!plaidConfigured()) throw fail(503, 'Bank linking isn’t set up yet (PLAID_CLIENT_ID and PLAID_SECRET are missing).');
  let r;
  try {
    r = await fetch(host() + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
        'Plaid-Version': '2020-09-14'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw fail(502, 'Plaid couldn’t be reached. Try again in a minute.', { code: 'NETWORK' });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = data.error_code || 'HTTP_' + r.status;
    console.error('Plaid', path, r.status, data.error_type, code, data.request_id || '');
    const msg = RELINK_CODES.includes(code) ? 'This bank needs you to sign in again.'
      : code === 'RATE_LIMIT_EXCEEDED' || data.error_type === 'RATE_LIMIT_EXCEEDED' ? 'Plaid is busy. Try again in a few minutes.'
      : data.display_message || 'Plaid couldn’t finish that (' + code + ').';
    throw fail(r.status >= 500 ? 502 : 400, msg, { code, plaid: true });
  }
  return data;
}

// A stable, non-identifying Plaid user id for each of the two people.
export async function clientUserId(email) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lb-finance:' + email)));
  return Array.from(bytes.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
}

// A Link token: a new connection, or (with accessToken) update mode for a
// connection whose sign-in has expired. Update mode keeps the same Item,
// so it never uses up another of the Trial plan's 10 slots.
export async function linkToken({ email, accessToken }) {
  const body = {
    client_name: 'Randall Family Hub',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: await clientUserId(email) }
  };
  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
  if (accessToken) body.access_token = accessToken;
  else {
    body.products = ['transactions'];
    body.required_if_supported_products = ['investments', 'liabilities'];
    body.transactions = { days_requested: 730 };
  }
  const r = await plaid('/link/token/create', body);
  return r.link_token;
}

export async function exchange(publicToken) {
  const r = await plaid('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: r.access_token, itemId: r.item_id };
}

// Everything new since the cursor, paged. On a mutation during paging the
// whole loop restarts from the first cursor, as Plaid requires. Stops early
// (keeping what it has and the cursor reached) once deadline passes.
export async function syncTransactions(accessToken, cursor, deadline) {
  const out = { added: [], modified: [], removed: [], cursor, status: null, more: false };
  for (let restart = 0; restart < 3; restart++) {
    let c = cursor, added = [], modified = [], removed = [], status = null, more = true;
    try {
      while (more) {
        const r = await plaid('/transactions/sync', { access_token: accessToken, cursor: c || undefined, count: 500, options: { include_original_description: true } });
        added = added.concat(r.added || []); modified = modified.concat(r.modified || []); removed = removed.concat(r.removed || []);
        c = r.next_cursor; more = !!r.has_more; status = r.transactions_update_status || status;
        if (more && Date.now() > deadline) break;
      }
      return { added, modified, removed, cursor: c, status, more };
    } catch (e) {
      if (e.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') throw e;
    }
  }
  return out;
}

export async function getAccounts(accessToken, live) {
  const r = await plaid(live ? '/accounts/balance/get' : '/accounts/get', { access_token: accessToken });
  return { accounts: r.accounts || [], item: r.item || {} };
}

async function optional(fn) {
  try { return await fn(); } catch (e) { if (SKIP_CODES.includes(e.code)) return null; throw e; }
}
export const getHoldings = accessToken => optional(() => plaid('/investments/holdings/get', { access_token: accessToken }));
export const getLiabilities = accessToken => optional(() => plaid('/liabilities/get', { access_token: accessToken }));

export async function institutionName(id) {
  if (!id) return '';
  try {
    const r = await plaid('/institutions/get_by_id', { institution_id: id, country_codes: ['US'] });
    return (r.institution && r.institution.name) || '';
  } catch (e) { return ''; }
}

// The bank's logo (a base64 PNG) and brand color, when Plaid has them.
export async function institutionLogo(id) {
  const r = await plaid('/institutions/get_by_id', { institution_id: id, country_codes: ['US'], options: { include_optional_metadata: true } });
  const inst = r.institution || {};
  return { logo: inst.logo || null, color: /^#[0-9a-f]{6}$/i.test(inst.primary_color || '') ? inst.primary_color : null };
}

export async function removeItem(accessToken) {
  await plaid('/item/remove', { access_token: accessToken });
}

// Plaid's account type/subtype -> ours (data.js ACCOUNT_TYPES).
export function accountType(a) {
  const sub = String(a.subtype || '').toLowerCase();
  switch (a.type) {
    case 'depository': return 'cash';
    case 'credit': return 'credit';
    case 'loan': return sub === 'mortgage' || sub.startsWith('home equity') ? 'mortgage' : 'loan';
    case 'investment': case 'brokerage':
      return /401|403|457|ira|roth|sep|simple|pension|retirement|keogh|tsp|thrift|profit sharing|rrsp|sipp|lira|rrif/.test(sub) ? 'retirement' : 'investment';
    default: return 'other-asset';
  }
}
