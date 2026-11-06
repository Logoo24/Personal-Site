// Local testing only: fills .family-data/finance/ with a believable year of
// made-up money for two people, so Finance can be built and checked without
// real bank data. It simulates every day: paychecks, rent, bills,
// subscriptions (one with a price rise), groceries and the rest on two cards
// that get paid off each month, savings and investing transfers, market
// swings, a car losing value and two loans paying down. One savings account
// is "Only me" for the second person. The oldest months are marked estimated,
// as if they'd been rebuilt from history.
//
//   node scripts/finance-demo.mjs [--force] [--names Logan,Marisa]
//
// The people are the first two emails in FAMILY_FINANCE_EMAILS (.env.local).
// It refuses to run with a Blob store configured, so it can never touch the
// real one. Everything is encrypted with FINANCE_ENCRYPTION_KEY, like the
// real data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const stop = msg => { console.error(msg); process.exit(1); };
if (process.env.VERCEL || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || process.env.fam_STORE_ID) {
  stop('A Blob store is configured. The demo data only goes in the local .family-data/ folder, so this won’t run.');
}
if (!process.env.FINANCE_ENCRYPTION_KEY) stop('FINANCE_ENCRYPTION_KEY is missing from .env.local.');
const emails = String(process.env.FAMILY_FINANCE_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
if (!emails.length) stop('FAMILY_FINANCE_EMAILS is missing from .env.local.');

const args = process.argv.slice(2);
const namesArg = args.includes('--names') ? args[args.indexOf('--names') + 1] : 'Logan,Marisa';
const [name1, name2 = 'Partner'] = namesArg.split(',');
const P1 = emails[0], P2 = emails[1] || 'partner@example.com';

process.chdir(ROOT);
const dir = path.join(ROOT, '.family-data', 'finance');
if (fs.existsSync(path.join(dir, 'state.json')) && !args.includes('--force')) stop('There is already finance data in .family-data/finance/. Add --force to replace it.');
fs.rmSync(dir, { recursive: true, force: true });

const { writeSecure } = await import(pathToFileURL(path.join(ROOT, 'api/_family/finance/vault.js')).href);
const { emptyState, STATE, SNAPSHOTS, txPath } = await import(pathToFileURL(path.join(ROOT, 'api/_family/finance/data.js')).href);

/* ---------- a repeatable random source ---------- */
let seed = 20261105;
const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100); // dollars -> cents
const pick = list => list[Math.floor(rand() * list.length)];
const id = (p = '') => p + Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(rand() * 31)]).join('');

/* ---------- accounts (balances in cents on the first simulated day) ---------- */
const accounts = {
  chk: { name: 'Joint Checking', inst: 'Demo Credit Union', type: 'cash', owner: 'joint', mask: '4821', balance: 420000 },
  sav: { name: 'High-Yield Savings', inst: 'Demo Online Bank', type: 'cash', owner: 'joint', mask: '9910', balance: 950000, apr: 4.0 },
  msav: { name: 'Personal Savings', inst: 'Demo Credit Union', type: 'cash', owner: P2, private: true, mask: '3307', balance: 210000 },
  card1: { name: 'Rewards Visa', inst: 'Demo Card Co', type: 'credit', owner: P1, mask: '1144', balance: 115000, limit: 1200000, apr: 24.99 },
  card2: { name: 'Cash Back Mastercard', inst: 'Demo Bank', type: 'credit', owner: P2, mask: '7781', balance: 42000, limit: 600000, apr: 21.49 },
  k401: { name: '401(k)', inst: 'Demo Retirement', type: 'retirement', owner: P1, mask: '0042', balance: 1840000 },
  roth: { name: 'Roth IRA', inst: 'Demo Brokerage', type: 'retirement', owner: P2, mask: '5521', balance: 680000 },
  brk: { name: 'Brokerage', inst: 'Demo Brokerage', type: 'investment', owner: 'joint', mask: '5530', balance: 320000 },
  car: { name: '2019 Honda CR-V', inst: '', type: 'vehicle', owner: 'joint', balance: 1950000, src: 'manual' },
  auto: { name: 'Auto loan', inst: 'Demo Credit Union', type: 'loan', owner: 'joint', mask: '6610', balance: 1280000, apr: 5.9, minPayment: 38500 },
  stud: { name: 'Student loan', inst: 'Demo Loan Servicer', type: 'loan', owner: P1, mask: '2208', balance: 1620000, apr: 4.5, minPayment: 21000 }
};
const SIDE = { credit: 'liability', loan: 'liability', mortgage: 'liability' };
for (const [key, a] of Object.entries(accounts)) {
  a.id = 'a_' + key + id();
  a.side = SIDE[a.type] || 'asset';
  a.src = a.src || 'demo';
}

/* ---------- simulate each day ---------- */
const today = new Date(); today.setHours(12, 0, 0, 0);
const start = new Date(today.getFullYear(), today.getMonth() - 13, 1, 12);
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local days, like the app's
const tx = {}; // month -> []
const daily = [], monthly = [];
const trackingFrom = new Date(today); trackingFrom.setDate(trackingFrom.getDate() - 120);
const estBefore = new Date(today.getFullYear(), today.getMonth() - 4, 1);

function add(acctKey, d, cents, raw, name, cat, extra = {}) {
  const a = accounts[acctKey];
  // On a card or loan, a purchase raises what's owed; a payment lowers it.
  a.balance += a.side === 'liability' ? -cents : cents;
  const m = key(d).slice(0, 7);
  (tx[m] = tx[m] || []).push({ id: id('demo_'), acct: a.id, date: key(d), amt: cents, name, raw, cat, catSrc: cat ? 'plaid' : null, pending: false, ...extra });
}
function transfer(from, to, d, cents, rawOut, rawIn, cat = 'transfer') {
  add(from, d, -cents, rawOut, rawOut.replace(/\s+\d+$/, ''), cat, { transfer: true });
  add(to, d, cents, rawIn, rawIn.replace(/\s+\d+$/, ''), cat, { transfer: true });
}
const GROCERS = [['SMITHS FOOD #4453 REXBURG ID', "Smith's"], ['WINCO FOODS #91', 'WinCo Foods'], ['COSTCO WHSE #1032', 'Costco'], ['WALMART SUPERCENTER #2061', 'Walmart']];
const DINING = [['CAFE RIO #118', 'Cafe Rio'], ['CHICK-FIL-A #03312', 'Chick-fil-A'], ['OLIVE GARDEN 4410', 'Olive Garden'], ['STARBUCKS STORE 22014', 'Starbucks'], ['CRUMBL COOKIES', 'Crumbl']];
const GAS = [['MAVERIK #412', 'Maverik'], ['CHEVRON 0098812', 'Chevron'], ['SINCLAIR 2210', 'Sinclair']];
const SHOP = [['AMAZON MKTPL*2K4L19', 'Amazon'], ['TARGET 00012345', 'Target'], ['HOBBY LOBBY #233', 'Hobby Lobby'], ['OLD NAVY ON-LINE', 'Old Navy']];
const UNSURE = [['SQ *LOCAL FARMSTAND', null], ['VENMO PAYMENT 1023774', null], ['PAYPAL *EBAY INC', null]];
let card1Statement = 0, card2Statement = 0, lastMonth = null;
let p1Payday = new Date(start); while (p1Payday.getDay() !== 5) p1Payday.setDate(p1Payday.getDate() + 1);

for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
  const day = d.getDate(), month = d.getMonth(), m = key(d).slice(0, 7);
  const winter = [10, 11, 0, 1, 2].includes(month);
  if (m !== lastMonth) { lastMonth = m; card1Statement = accounts.card1.balance; card2Statement = accounts.card2.balance; }

  // Income
  if (key(d) === key(p1Payday)) {
    add('chk', d, between(2030, 2070), 'ACME CORP PAYROLL DIR DEP', 'Acme Corp', 'paycheck');
    accounts.k401.balance += 35000 + 17500; // payroll deduction + employer match
    p1Payday.setDate(p1Payday.getDate() + 14);
  }
  if (day === 1 || day === 15) add('chk', d, 130000, 'NORTHWIND SCHOOLS PAYROLL', 'Northwind Schools', 'paycheck');
  if (day === 28) add('sav', d, Math.round(accounts.sav.balance * 0.04 / 12), 'INTEREST PAYMENT', 'Interest', 'other-income');

  // Housing, bills, loans
  if (day === 1) add('chk', d, -165000, 'RENT SUNSET APARTMENTS', 'Sunset Apartments', 'housing');
  if (day === 1) accounts.car.balance = Math.round(accounts.car.balance * 0.99);
  if (day === 12) add('chk', d, -between(winter ? 95 : 60, winter ? 140 : 110), 'ROCKY MTN POWER', 'Rocky Mountain Power', 'utilities');
  if (day === 13) add('chk', d, -between(winter ? 70 : 25, winter ? 115 : 40), 'DOMINION ENERGY', 'Dominion Energy', 'utilities');
  if (day === 18) add('chk', d, -6500, 'SPARKLIGHT INTERNET', 'Sparklight', 'utilities');
  if (day === 25) add('chk', d, -12800, 'PROGRESSIVE INS PREM', 'Progressive', 'insurance');
  if (day === 10) {
    const interest = Math.round(accounts.auto.balance * 0.059 / 12);
    accounts.chk.balance -= 38500;
    (tx[m] = tx[m] || []).push({ id: id('demo_'), acct: accounts.chk.id, date: key(d), amt: -38500, name: 'Auto loan payment', raw: 'DEMO CU LOAN PMT 6610', cat: 'loans', catSrc: 'plaid', pending: false });
    accounts.auto.balance -= 38500 - interest;
  }
  if (day === 28) {
    const interest = Math.round(accounts.stud.balance * 0.045 / 12);
    accounts.chk.balance -= 21000;
    (tx[m] = tx[m] || []).push({ id: id('demo_'), acct: accounts.chk.id, date: key(d), amt: -21000, name: 'Demo Loan Servicer', raw: 'DEMO LOAN SVCR STUDENT LN', cat: 'loans', catSrc: 'plaid', pending: false });
    accounts.stud.balance -= 21000 - interest;
  }

  // Subscriptions and phone (Spotify went up a dollar 6 months ago)
  const monthsIn = (d.getFullYear() - start.getFullYear()) * 12 + month - start.getMonth();
  if (day === 3) add('card1', d, -299, 'APPLE.COM/BILL', 'iCloud+', 'subscriptions');
  if (day === 8) add('card1', d, -1549, 'NETFLIX.COM', 'Netflix', 'subscriptions');
  if (day === 14) add('card1', d, monthsIn >= 7 ? -1199 : -1099, 'SPOTIFY USA', 'Spotify', 'subscriptions');
  if (day === 22) add('card2', d, -799, 'DISNEYPLUS', 'Disney+', 'subscriptions');
  if (day === 20) add('card1', d, -between(84, 92), 'VERIZON WIRELESS', 'Verizon', 'utilities');
  if (day === 9 && month === 2) add('card1', d, -13900, 'AMAZON PRIME*MEMBERSHIP', 'Amazon Prime', 'subscriptions');

  // Everyday spending, split between the two cards
  const card = rand() < 0.55 ? 'card1' : 'card2';
  if (rand() < 0.22) { const g = pick(GROCERS); add(card, d, -between(38, 185), g[0], g[1], 'groceries'); }
  if (rand() < 0.2) { const g = pick(DINING); add(card, d, -between(9, 62), g[0], g[1], 'dining'); }
  if (rand() < 0.1) { const g = pick(GAS); add(card, d, -between(34, 61), g[0], g[1], 'transport'); }
  if (rand() < 0.12) { const g = pick(SHOP); add(card, d, -between(14, 140), g[0], g[1], 'shopping'); }
  if (rand() < 0.03) add(card, d, -between(15, 90), 'WALGREENS #6612', 'Walgreens', 'health');
  if (rand() < 0.025) add(card, d, -between(12, 60), 'CINEMARK 0123', 'Cinemark', 'entertainment');
  if (rand() < 0.03) { const g = pick(UNSURE); add(card, d, -between(10, 75), g[0], g[0], null); }
  if (month === 11 && day > 1 && day < 23 && rand() < 0.25) add(card, d, -between(25, 120), 'AMAZON MKTPL*GIFTS', 'Amazon', 'gifts');
  if (month === 6 && day === 9) add('card1', d, -between(780, 820), 'DELTA AIR LINES', 'Delta', 'travel');

  // Card payments, saving and investing (transfers: not spending)
  if (day === 16 && card1Statement > 0) transfer('chk', 'card1', d, card1Statement, 'DEMO CARD CO PAYMENT', 'PAYMENT THANK YOU', 'card-payment');
  if (day === 24 && card2Statement > 0) transfer('chk', 'card2', d, card2Statement, 'DEMO BANK CARD PAYMENT', 'PAYMENT RECEIVED THANK YOU', 'card-payment');
  if (day === 2) transfer('chk', 'sav', d, 150000, 'TRANSFER TO SAVINGS 9910', 'TRANSFER FROM CHECKING 4821', 'saving');
  if (day === 16) transfer('chk', 'msav', d, 10000, 'TRANSFER TO SAVINGS 3307', 'TRANSFER FROM CHECKING 4821', 'saving');
  if (day === 5) { add('chk', d, -30000, 'TRANSFER TO DEMO BROKERAGE ROTH', 'Demo Brokerage', 'saving', { transfer: true }); accounts.roth.balance += 30000; }
  if (day === 6) { add('chk', d, -50000, 'TRANSFER TO DEMO BROKERAGE', 'Demo Brokerage', 'saving', { transfer: true }); accounts.brk.balance += 50000; }

  // Markets move every weekday
  if (d.getDay() > 0 && d.getDay() < 6) {
    const r = 0.0003 + (rand() - 0.5) * 0.018;
    for (const k of ['k401', 'roth', 'brk']) accounts[k].balance = Math.round(accounts[k].balance * (1 + r));
  }

  const b = {};
  for (const a of Object.values(accounts)) b[a.id] = a.balance;
  if (d >= trackingFrom) daily.push({ d: key(d), b });
  const tomorrow = new Date(d); tomorrow.setDate(day + 1);
  if (tomorrow.getMonth() !== month && d < today) monthly.push({ m, b, ...(d < estBefore ? { est: true } : {}) });
}

/* ---------- write it all (encrypted) ---------- */
const nowIso = new Date().toISOString();
const state = emptyState();
state.people = { [P1]: name1, [P2]: name2 };
state.settings = { demo: true };
const carHistory = monthly.map(e => ({ date: e.m + '-28', balance: e.b[accounts.car.id] }));
state.accounts = Object.values(accounts).map(a => ({
  id: a.id, src: a.src, inst: a.inst, name: a.name, mask: a.mask || null, type: a.type, side: a.side,
  owner: a.owner, private: !!a.private, balance: a.balance, limit: a.limit || null, apr: a.apr || null,
  minPayment: a.minPayment || null, asOf: nowIso, hidden: false, inNetWorth: true,
  ...(a.src === 'manual' ? { history: carHistory } : {})
}));
state.credit = [];
for (let k = 11; k >= 0; k--) {
  const d = new Date(today.getFullYear(), today.getMonth() - k, 4);
  state.credit.push({ id: id('c_'), person: P1, score: 712 + Math.round((11 - k) * 2.6 + (rand() - 0.5) * 6), model: 'FICO 8', bureau: 'Experian', date: key(d), source: 'Card issuer' });
  state.credit.push({ id: id('c_'), person: P2, score: 760 + Math.round((11 - k) * 1.1 + (rand() - 0.5) * 6), model: 'VantageScore 3.0', bureau: 'TransUnion', date: key(d), source: 'Credit Karma' });
}

await writeSecure(STATE, state);
await writeSecure(SNAPSHOTS, { daily, monthly });
let count = 0;
for (const [m, list] of Object.entries(tx)) {
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  count += list.length;
  await writeSecure(txPath(m), { month: m, transactions: list });
}
console.log(`Wrote ${state.accounts.length} accounts, ${count} transactions over ${Object.keys(tx).length} months, ${monthly.length} month-ends and ${daily.length} daily snapshots for ${name1} (${P1}) and ${name2} (${P2}).`);
