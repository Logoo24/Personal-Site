// Sorting transactions into the family's categories (data.js).
//
// Which one wins, first to last:
//   1. a rule the family made ("always put Costco in Groceries")
//   2. a known subscription brand (Plaid has no "subscriptions" category)
//   3. Plaid's own category (personal_finance_category), through PFC_MAP,
//      unless Plaid itself is unsure (LOW / UNKNOWN confidence)
//   4. a keyword list, for anything without a Plaid category
//   5. Claude, once per unfamiliar merchant (merchant text only, never
//      account numbers or balances), remembered in state.payees
// Anything Claude decides lands in the "Needs review" queue.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';

// Plaid's detailed codes first, then its primary codes as the fallback.
const PFC_DETAILED = {
  INCOME_WAGES: 'paycheck',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'card-payment',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'housing',
  TRANSFER_IN_SAVINGS: 'saving', TRANSFER_OUT_SAVINGS: 'saving',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'saving', TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'saving',
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'gifts',
  GENERAL_SERVICES_AUTOMOTIVE: 'transport',
  GENERAL_SERVICES_CHILDCARE: 'kids',
  GENERAL_SERVICES_EDUCATION: 'education',
  GENERAL_SERVICES_INSURANCE: 'insurance',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'gifts',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'taxes',
  RENT_AND_UTILITIES_RENT: 'housing',
  BANK_FEES_INTEREST_CHARGE: 'fees'
};
const PFC_PRIMARY = {
  INCOME: 'other-income',
  TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer',
  LOAN_PAYMENTS: 'loans',
  BANK_FEES: 'fees',
  ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK: 'dining',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'home',
  MEDICAL: 'health',
  PERSONAL_CARE: 'personal',
  GENERAL_SERVICES: 'other',
  GOVERNMENT_AND_NON_PROFIT: 'other',
  TRANSPORTATION: 'transport',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES: 'utilities'
};
export function fromPlaid(pfc) {
  if (!pfc || !pfc.detailed) return null;
  return PFC_DETAILED[pfc.detailed] || PFC_PRIMARY[pfc.primary || String(pfc.detailed).split('_').slice(0, 2).join('_')] || PFC_PRIMARY[String(pfc.detailed).split('_')[0]] || null;
}
export const plaidSure = pfc => !!(pfc && pfc.detailed && !['LOW', 'UNKNOWN'].includes(pfc.confidence_level));

const SUBSCRIPTIONS = /\b(netflix|spotify|hulu|disney ?(plus|\+)|max\.com|hbo ?max|paramount|peacock|youtube ?(premium|tv)|apple\.com\/bill|icloud|google \*?(storage|one)|amazon prime|prime video|audible|kindle unlimited|dropbox|microsoft ?365|adobe|chatgpt|openai|anthropic|claude\.ai|patreon|siriusxm|nytimes|wsj|duolingo|canva|1password|lastpass|nordvpn|playstation ?plus|xbox ?(game ?pass|live)|nintendo online)\b/i;

// For transactions with no Plaid category (hand-added, or Plaid didn't know).
const KEYWORDS = [
  [/\b(payroll|direct dep|dir dep|salary)\b/i, 'paycheck'],
  [/\b(interest (paid|payment|earned)|dividend)\b/i, 'other-income'],
  [/\b(payment thank you|autopay payment|card ?payment|payment received)\b/i, 'card-payment'],
  [/\b(transfer|xfer|zelle|venmo cashout)\b/i, 'transfer'],
  [/\b(rent|apartments?|property mgmt|mortgage)\b/i, 'housing'],
  [/\b(power|energy|electric|water|sewer|gas co|internet|sparklight|comcast|xfinity|verizon|t-mobile|at&t)\b/i, 'utilities'],
  [/\b(grocery|groceries|market|foods?|winco|smith'?s|kroger|safeway|albertsons|costco|trader joe|whole foods|aldi|walmart neighborhood)\b/i, 'groceries'],
  [/\b(restaurant|cafe|coffee|starbucks|dutch bros|mcdonald|chick-fil-a|cafe rio|taco|pizza|grill|burger|crumbl|doordash|uber eats|grubhub)\b/i, 'dining'],
  [/\b(gas|fuel|chevron|shell|maverik|sinclair|exxon|conoco|parking|uber|lyft|jiffy lube|car wash)\b/i, 'transport'],
  [/\b(insurance|geico|progressive|state farm|allstate)\b/i, 'insurance'],
  [/\b(pharmacy|walgreens|cvs|dental|doctor|clinic|hospital|medical|optometr)\b/i, 'health'],
  [/\b(loan pmt|loan payment|student ln|navient|nelnet|mohela|sallie mae)\b/i, 'loans'],
  [/\b(amazon|target|walmart|old navy|best buy|hobby lobby|etsy|ebay|kohl'?s)\b/i, 'shopping'],
  [/\b(airline|air lines|delta|united|southwest|hotel|marriott|hilton|airbnb|expedia)\b/i, 'travel'],
  [/\b(cinema|theater|theatre|cinemark|steam|ticketmaster|fandango)\b/i, 'entertainment'],
  [/\b(fee|overdraft|finance charge|interest charge)\b/i, 'fees'],
  [/\b(tithing|donation|charity|church)\b/i, 'gifts'],
  [/\b(irs|tax)\b/i, 'taxes']
];
export function fromKeywords(text) {
  if (SUBSCRIPTIONS.test(text)) return 'subscriptions';
  for (const [re, cat] of KEYWORDS) if (re.test(text)) return cat;
  return null;
}

// "SQ *BLUE BOTTLE COFFEE #123 OAKLAND CA" -> "sq blue bottle coffee oakland ca":
// the merchant key that rules and the payee memory match on.
export function payeeKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[#*]+\s*\w*\d\w*/g, ' ')   // store numbers like #4453 or *2K4L19
    .replace(/\b\d[\d-]{2,}\b/g, ' ')     // long numbers, phone numbers
    .replace(/[^a-z0-9&' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
}

// A rule matches when its text appears in the transaction's merchant key,
// its cleaned name or its raw description.
export function ruleFor(tx, rules) {
  const hay = [payeeKey(tx.raw), payeeKey(tx.name), String(tx.name || '').toLowerCase()].join(' | ');
  return (rules || []).find(r => r.text && hay.includes(r.text)) || null;
}
export function applyRule(tx, rule) {
  if (rule.cat) { tx.cat = rule.cat; tx.catSrc = 'rule'; tx.reviewed = true; }
  if (rule.transfer != null) tx.transfer = !!rule.transfer;
  if (rule.hide != null) tx.hidden = !!rule.hide;
  if (rule.rename) tx.name = rule.rename;
}

// Picks a category for a new transaction without asking Claude. Returns
// true when it found one; false leaves it for categorizeWithClaude.
export function categorize(tx, state, pfc) {
  const rule = ruleFor(tx, state.rules);
  if (rule) { applyRule(tx, rule); if (rule.cat) return true; }
  const text = `${tx.name || ''} ${tx.raw || ''}`;
  if (SUBSCRIPTIONS.test(text) && tx.amt < 0) { tx.cat = 'subscriptions'; tx.catSrc = 'auto'; return true; }
  if (plaidSure(pfc)) { tx.cat = fromPlaid(pfc); tx.catSrc = 'plaid'; if (tx.cat) return true; }
  const known = state.payees && state.payees[payeeKey(tx.raw || tx.name)];
  if (known && known.cat) { tx.cat = known.cat; tx.catSrc = 'ai'; if (known.name && !tx.merchant) tx.name = known.name; tx.reviewed = known.reviewed !== false; return true; }
  const kw = fromKeywords(text);
  if (kw) { tx.cat = kw; tx.catSrc = 'auto'; return true; }
  const guess = fromPlaid(pfc);
  if (guess) { tx.cat = guess; tx.catSrc = 'plaid'; tx.reviewed = false; return false; }
  tx.cat = null; tx.catSrc = null; tx.reviewed = false;
  return false;
}

// One Claude call for every merchant still unsure after categorize(). It
// sees each merchant's raw text, Plaid's guess and whether money came in or
// went out, and answers with a clean name and a category. The answers are
// remembered in state.payees, so each merchant is asked about once.
export async function categorizeWithClaude(txs, state) {
  if (!process.env.ANTHROPIC_API_KEY || !txs.length) return 0;
  const cats = (state.categories || []).map(c => c.id);
  const byKey = new Map();
  for (const tx of txs) {
    const key = payeeKey(tx.raw || tx.name);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { key, text: String(tx.raw || tx.name).slice(0, 120), plaid_guess: tx.cat || null, direction: tx.amt < 0 ? 'out' : 'in' });
    if (byKey.size >= 80) break;
  }
  if (!byKey.size) return 0;
  const schema = {
    type: 'object', additionalProperties: false, required: ['merchants'],
    properties: { merchants: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['key', 'name', 'category'],
      properties: { key: { type: 'string' }, name: { type: 'string' }, category: { type: 'string', enum: cats } }
    } } }
  };
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  let out;
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: 'You sort bank and card transactions for a US family\'s budget. For each merchant, give a short, clean merchant name as people say it (e.g. "Blue Bottle Coffee", not "SQ *BLUE BOTTLE 123") and the best category from the list. "in" means money came into the account, "out" means it went out. Use "transfer" for moves between their own accounts, "card-payment" for paying a credit card, "saving" for moving money to savings or investments, and "other" only when nothing fits.\n\nCategories: ' +
        (state.categories || []).map(c => `${c.id} (${c.name})`).join(', '),
      messages: [{ role: 'user', content: JSON.stringify([...byKey.values()]) }]
    });
    const block = res.content.find(b => b.type === 'text');
    out = JSON.parse(block ? block.text : '{}');
  } catch (e) {
    // The error class only: the request held merchant names.
    console.error('Finance categorize: Claude request failed', e && e.constructor && e.constructor.name, e && e.status);
    return 0;
  }
  state.payees = state.payees || {};
  let n = 0;
  for (const m of out.merchants || []) {
    if (!byKey.has(m.key) || !cats.includes(m.category)) continue;
    state.payees[m.key] = { name: String(m.name || '').slice(0, 60), cat: m.category, reviewed: false };
    n++;
  }
  for (const tx of txs) {
    const p = state.payees[payeeKey(tx.raw || tx.name)];
    if (!p) continue;
    tx.cat = p.cat; tx.catSrc = 'ai'; tx.reviewed = false;
    if (p.name && !tx.merchant) tx.name = p.name;
  }
  return n;
}
