// Budgets and goals, household-wide (both of you plan together).
//
// Budgets: a monthly amount on a spending category (state.categories[].budget,
// cents). The page compares them with the month's spending.
//
// Goals (state.goals): { id, name, kind: save | payoff, target, date,
//   accounts: [account ids], saved, startDate, startValue, createdBy, ... }
//   - save, with accounts: progress is those accounts' balances added up
//     (an emergency fund in the high-yield savings, say)
//   - save, without accounts: progress is `saved`, kept by hand
//   - payoff: one debt account; progress is how much of `target` (its
//     balance when the goal was made) has been paid down
// A goal tied to an account the viewer can't see ("Only me") is hidden
// from them, so it can't give that account's balance away.

import { updateState, canSee, familyDay, ACCOUNT_TYPES } from './data.js';
import { randomId } from '../recipes.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_GOALS = 30;

function cents(v, { allowZero = false } = {}) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 1e11) return NaN;
  return n;
}

export function setBudgets(input, viewer) {
  const budgets = (input && input.budgets) || {};
  return updateState(s => {
    const byId = new Map((s.categories || []).map(c => [c.id, c]));
    for (const [id, v] of Object.entries(budgets)) {
      const c = byId.get(id);
      if (!c || c.kind !== 'expense') throw fail(400, 'Budgets go on spending categories.');
      const amt = cents(v, { allowZero: true });
      if (Number.isNaN(amt)) throw fail(400, 'Budgets should be amounts, like 600.');
      if (amt) c.budget = amt; else delete c.budget;
    }
    s.settings = { ...(s.settings || {}), budgetsBy: viewer, budgetsAt: new Date().toISOString() };
  });
}

// What the progress is right now, for the "pace" baseline of a new goal.
function progressOf(goal, accounts) {
  if (goal.kind === 'payoff') {
    const a = accounts.get(goal.accounts[0]);
    return a ? Math.max(0, goal.target - (a.balance || 0)) : 0;
  }
  if (goal.accounts && goal.accounts.length) return goal.accounts.reduce((sum, id) => sum + ((accounts.get(id) || {}).balance || 0), 0);
  return goal.saved || 0;
}

export function visibleGoals(state, viewer) {
  const accts = new Map((state.accounts || []).map(a => [a.id, a]));
  return (state.goals || []).filter(g => (g.accounts || []).every(id => !accts.has(id) || canSee(accts.get(id), viewer)));
}

// input: { id?, name, kind, target, date, accounts, saved } to add or edit;
// { id, add } to add to a hand-kept goal's savings.
export function saveGoal(input, viewer) {
  input = input || {};
  return updateState(s => {
    s.goals = s.goals || [];
    const accts = new Map((s.accounts || []).map(a => [a.id, a]));
    const visible = new Set(visibleGoals(s, viewer).map(g => g.id));
    let g = input.id ? s.goals.find(x => x.id === input.id) : null;
    if (input.id && (!g || !visible.has(g.id))) throw fail(404, 'That goal wasn’t found.');

    if (g && input.add != null) {
      if (g.kind !== 'save' || (g.accounts || []).length) throw fail(400, 'This goal follows its accounts’ balances.');
      const add = Math.round(Number(input.add));
      if (!Number.isFinite(add) || add === 0 || Math.abs(add) > 1e11) throw fail(400, 'Enter an amount.');
      g.saved = Math.max(0, (g.saved || 0) + add);
      g.updatedAt = new Date().toISOString();
      return;
    }

    const isNew = !g;
    if (isNew) {
      if (s.goals.length >= MAX_GOALS) throw fail(400, 'That’s a lot of goals. Finish or delete one first.');
      g = { id: 'g_' + randomId(10), createdBy: viewer, createdAt: new Date().toISOString(), startDate: familyDay() };
    }
    const name = String(input.name || '').trim().slice(0, 60);
    if (!name) throw fail(400, 'Give the goal a name.');
    const kind = input.kind === 'payoff' ? 'payoff' : 'save';
    const ids = (Array.isArray(input.accounts) ? input.accounts : []).map(String).filter((id, i, all) => all.indexOf(id) === i);
    for (const id of ids) {
      const a = accts.get(id);
      if (!a || !canSee(a, viewer)) throw fail(404, 'One of those accounts wasn’t found.');
      const side = (ACCOUNT_TYPES[a.type] || {}).side;
      if (kind === 'payoff' ? side !== 'liability' : side !== 'asset') throw fail(400, kind === 'payoff' ? 'Pick the debt to pay off.' : 'Savings goals follow accounts you own.');
    }
    if (kind === 'payoff' && ids.length !== 1) throw fail(400, 'Pick the one debt this goal pays off.');
    let target = cents(input.target);
    if (kind === 'payoff' && (target == null || Number.isNaN(target))) target = (accts.get(ids[0]).balance || 0) || NaN;
    if (target == null || Number.isNaN(target)) throw fail(400, 'Enter the goal amount, like 10,000.');
    const date = input.date ? String(input.date) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Pick a date for the goal, or leave it empty.');
    const saved = kind === 'save' && !ids.length ? cents(input.saved, { allowZero: true }) : null;
    if (Number.isNaN(saved)) throw fail(400, 'The amount saved so far should be an amount.');

    const changedBasis = isNew || g.kind !== kind || JSON.stringify(g.accounts || []) !== JSON.stringify(ids);
    Object.assign(g, { name, kind, target, date, accounts: ids, saved: saved == null ? (ids.length ? null : g.saved || 0) : saved, updatedAt: new Date().toISOString(), updatedBy: viewer });
    // An emergency fund is remembered as one, so the page stops suggesting it.
    if (input.template === 'emergency') g.template = 'emergency';
    // Where it started, so the page can tell whether it's on pace.
    if (changedBasis) { g.startDate = familyDay(); g.startValue = progressOf(g, accts); }
    if (isNew) s.goals.push(g);
  });
}

export function deleteGoal(id, viewer) {
  return updateState(s => {
    const visible = new Set(visibleGoals(s, viewer).map(g => g.id));
    if (!visible.has(id)) throw fail(404, 'That goal wasn’t found.');
    s.goals = (s.goals || []).filter(g => g.id !== id);
  });
}
