// Adding, editing and deleting accounts. Accounts added by hand (cars,
// homes, loans, cash...) can change everything; linked bank accounts only
// their settings (nickname, kind, whose, rates, hidden), since Plaid keeps
// their names and balances current.
//
// "Only me" makes an account private to the person who sets it: it becomes
// theirs, and the other spouse stops seeing it anywhere.

import { randomId } from '../recipes.js';
import { financeEmails } from '../session.js';
import { updateState, canSee, ACCOUNT_TYPES } from './data.js';
import { forgetAccount } from './snapshots.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
function cents(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 1e13 ? n : NaN;
}
function rate(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 1000) / 1000 : NaN;
}
const editable = a => a.src !== 'plaid';

function findVisible(s, id, viewer) {
  const a = (s.accounts || []).find(x => x.id === id);
  if (!a || !canSee(a, viewer)) throw fail(404, 'That account wasn’t found.');
  return a;
}

export function saveAccount(input, viewer) {
  input = input || {};
  return updateState(s => {
    const now = new Date().toISOString();
    let a = input.id ? findVisible(s, input.id, viewer) : null;
    const isNew = !a;
    if (isNew) a = { id: 'a_' + randomId(12), src: 'manual', createdAt: now, createdBy: viewer };

    const type = String(input.type || a.type || '');
    const kind = ACCOUNT_TYPES[type];
    if (!kind) throw fail(400, 'Pick what kind of account this is.');
    if (!isNew && !editable(a) && kind.side !== ACCOUNT_TYPES[a.type].side) throw fail(400, 'A linked account can’t switch between something you own and something you owe.');

    if (editable(a)) {
      const name = str(input.name, 80);
      if (!name) throw fail(400, 'Give it a name.');
      const balance = cents(input.balance);
      if (balance == null || Number.isNaN(balance)) throw fail(400, 'Enter the balance, or 0.');
      a.name = name;
      a.inst = str(input.inst, 80);
      if (a.balance !== balance) a.asOf = now;
      a.balance = balance;
    } else {
      a.nick = str(input.nick, 80) || null;
    }
    a.type = type;
    a.side = kind.side;

    if (input.private) { a.private = true; a.owner = viewer; }
    else {
      a.private = false;
      const owner = String(input.owner || 'joint').toLowerCase();
      a.owner = owner === 'joint' || financeEmails().includes(owner) ? owner : 'joint';
    }

    const apr = rate(input.apr), limit = cents(input.limit), minPayment = cents(input.minPayment);
    if ([apr, limit, minPayment].some(Number.isNaN)) throw fail(400, 'Check the rate and amounts: they should be numbers.');
    a.apr = apr;
    a.limit = type === 'credit' ? limit : null;
    a.minPayment = kind.side === 'liability' ? minPayment : null;
    a.notes = str(input.notes, 500);
    a.hidden = !!input.hidden;
    a.inNetWorth = input.inNetWorth !== false;
    a.updatedAt = now;
    a.updatedBy = viewer;
    if (isNew) s.accounts.push(a);
  });
}

export function setBalance(id, balance, viewer) {
  return updateState(s => {
    const a = findVisible(s, id, viewer);
    if (!editable(a)) throw fail(400, 'Linked accounts update their own balances.');
    const v = cents(balance);
    if (v == null || Number.isNaN(v)) throw fail(400, 'Enter the balance, or 0.');
    if (a.balance !== v) { a.balance = v; a.asOf = new Date().toISOString(); a.updatedBy = viewer; }
  });
}

export async function deleteAccount(id, viewer) {
  const state = await updateState(s => {
    const a = findVisible(s, id, viewer);
    if (!editable(a)) throw fail(400, 'Linked accounts go away when their bank connection is removed. You can hide this one instead.');
    s.accounts = s.accounts.filter(x => x.id !== id);
  });
  await forgetAccount(id);
  return state;
}
