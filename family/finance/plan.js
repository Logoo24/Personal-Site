/* ============================================================
   Finance > Budgets & goals.
   Budgets: a monthly amount per spending category, compared with
   what's been spent, against how far through the month it is
   ("pace"). They can start from the last three months' averages.
   Budgets are household-wide, so they ignore the person filter.
   Goals: save toward a target (following accounts' balances, or
   kept by hand) or pay off a debt, with what it takes a month to
   get there by the date, and an emergency-fund suggestion worked
   out from essential spending.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var view = 'budgets';      // or 'goals'
  var month = null;          // the budget month shown
  var editing = false;
  var fmt = function (v) { return Fin.money(v); };

  function cats() { return Fin.data.categories || []; }
  function expenseCats() { return cats().filter(function (c) { return c.kind === 'expense'; }); }
  function acct(id) { return Fin.data.accounts.filter(function (a) { return a.id === id; })[0]; }
  function monthLabel(m) { return Fin.monthDate(m).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function shift(m, n) { var d = Fin.monthDate(m); return Fin.monthKey(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
  function daysIn(m) { var d = Fin.monthDate(m); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

  // Spending by category in one month, for everyone (budgets are shared):
  // refunds netted, transfers left out, uncategorized counted as spending.
  function spendIn(data, m) {
    var by = {};
    (data.rows || []).forEach(function (r) {
      if (r.m !== m) return;
      var c = cats().filter(function (x) { return x.id === r.c; })[0], k = c ? c.kind : null;
      if (k === 'income' || k === 'transfer') return;
      var v = k === 'expense' ? r.o - r.i : r.o;
      if (v) by[r.c || ''] = (by[r.c || ''] || 0) + v;
    });
    return by;
  }
  function averages(data, n) {
    var cur = Fin.data.today.slice(0, 7), sums = {};
    for (var k = 1; k <= n; k++) {
      var s = spendIn(data, shift(cur, -k));
      Object.keys(s).forEach(function (c) { sums[c] = (sums[c] || 0) + s[c]; });
    }
    Object.keys(sums).forEach(function (c) { sums[c] = Math.round(sums[c] / n); });
    return sums;
  }
  var round10 = function (c) { return Math.max(1000, Math.round(c / 1000) * 1000); }; // to the nearest $10

  /* ---------- budget rows ---------- */
  // Categories that are mostly fixed bills (rent, insurance, a loan) get
  // paid in one go, so "ahead of pace" means nothing for them: a category
  // counts as fixed when its recurring bills make up most of its budget.
  function fixedBills() {
    var by = {};
    (Fin.data.recurring || []).forEach(function (r) {
      if (r.dir === 'out' && r.status !== 'ignored' && !r.ended && r.cat) by[r.cat] = (by[r.cat] || 0) + (r.monthly || 0);
    });
    return by;
  }
  function isFixed(c, fixed) { return (fixed[c.id] || 0) >= c.budget * 0.6; }
  // Status: over budget, ahead of the month's pace (flexible ones only), or fine.
  function status(spent, budget, pace, fixed) {
    if (spent > budget) return { cls: 'over', icon: Hub.icons.x, text: Fin.money(spent - budget) + ' over' };
    if (fixed) return { cls: 'ok', icon: Hub.icons.check, text: spent >= budget * 0.9 ? 'Paid for the month' : Fin.money(budget - spent) + ' left' };
    if (pace < 1 && spent > budget * pace * 1.1 + 1000) return { cls: 'warn', icon: Hub.icons.up, text: 'Ahead of pace · ' + Fin.money(budget - spent) + ' left' };
    return { cls: 'ok', icon: Hub.icons.check, text: Fin.money(budget - spent) + ' left' };
  }
  // The whole budget: where spending "should" be by today counts fixed
  // categories as spent so far (capped at their budget) and flexible ones
  // by the share of the month gone.
  function overall(spentBy, pace) {
    var fixed = fixedBills(), t = { total: 0, spent: 0, expected: 0, over: 0, flexSpent: 0, flexBudget: 0 };
    expenseCats().filter(function (c) { return c.budget; }).forEach(function (c) {
      var s = Math.max(0, spentBy[c.id] || 0), f = isFixed(c, fixed);
      t.total += c.budget; t.spent += s;
      if (s > c.budget) t.over++;
      if (f) t.expected += Math.min(s, c.budget); else { t.expected += c.budget * pace; t.flexSpent += s; t.flexBudget += c.budget; }
    });
    t.cls = t.spent > t.total ? 'over' : pace < 1 && t.flexSpent > t.flexBudget * pace * 1.1 + 1000 ? 'warn' : 'ok';
    t.marker = t.total ? Math.min(1, t.expected / t.total) : pace;
    return t;
  }
  Fin.budgetOverall = overall;
  function meter(spent, budget, pace, cls) {
    var w = budget ? Math.min(100, spent / budget * 100) : 0;
    return '<div class="fin-meter ' + cls + '" role="img" aria-label="' + esc(Fin.money(spent) + ' of ' + Fin.money(budget)) + '">' +
      '<span class="fin-meter-fill" style="width:' + w + '%"></span>' +
      (pace < 1 ? '<span class="fin-meter-pace" style="left:' + (pace * 100) + '%" title="Where spending would be if it were even through the month"></span>' : '') + '</div>';
  }

  function budgetsView(box, data) {
    var cur = Fin.data.today.slice(0, 7);
    month = month || cur;
    var oldest = data.months[0];
    var pace = month === cur ? +Fin.data.today.slice(8, 10) / daysIn(month) : 1;
    var spent = spendIn(data, month);
    var budgeted = expenseCats().filter(function (c) { return c.budget; });
    var head = '<div class="fin-tx-bar"><div class="fin-month">' +
      '<button class="btn btn-ghost btn-icon" type="button" data-bmonth="-1" aria-label="Previous month"' + (month <= oldest ? ' disabled' : '') + '>' + Hub.icons.left + '</button>' +
      '<strong>' + esc(monthLabel(month)) + '</strong>' +
      '<button class="btn btn-ghost btn-icon" type="button" data-bmonth="1" aria-label="Next month"' + (month >= cur ? ' disabled' : '') + '>' + Hub.icons.right + '</button></div>' +
      '<div class="fin-tx-actions"><button class="btn btn-ghost btn-sm" type="button" data-bedit>' + Hub.icons.edit + (budgeted.length ? 'Edit budgets' : 'Set budgets') + '</button></div></div>';

    if (editing) return editView(box, data, head);
    if (!budgeted.length) {
      var avg = averages(data, 3), total = Object.keys(avg).reduce(function (m, k) { return m + (k ? avg[k] : 0); }, 0);
      box.innerHTML = head + '<div class="fin-soon"><h2>No budgets yet</h2><p>Set a monthly amount for the categories you want to keep an eye on. ' +
        (total ? 'Over the last three months you spent about ' + Fin.amt(total) + ' a month.' : '') + '</p>' +
        '<p class="fin-soon-actions">' + (total ? '<button class="btn btn-primary" type="button" data-bfill>Start from my last 3 months</button>' : '') +
        '<button class="btn btn-ghost" type="button" data-bedit>Set them myself</button></p></div>';
      return;
    }
    // Two lists, flexible spending and bills, each with whatever needs a
    // look first: over budget, then ahead of pace, then the most used up.
    var fixed = fixedBills(), RANK = { over: 0, warn: 1, ok: 2 };
    var items = budgeted.map(function (c) {
      var s = spent[c.id] || 0, f = isFixed(c, fixed);
      return { c: c, s: s, f: f, st: status(s, c.budget, pace, f) };
    }).sort(function (a, b) { return RANK[a.st.cls] - RANK[b.st.cls] || b.s / b.c.budget - a.s / a.c.budget; });
    function budgetRow(x) {
      return '<li class="fin-budget"><div class="fin-budget-head"><span class="fin-budget-name">' + esc(x.c.name) + '</span>' +
        '<span class="fin-budget-nums"><b class="fin-amt">' + esc(Fin.money(x.s)) + '</b> <span class="fin-muted">of <span class="fin-amt">' + esc(Fin.money(x.c.budget)) + '</span></span></span></div>' +
        meter(x.s, x.c.budget, x.f ? 1 : pace, x.st.cls) +
        '<span class="fin-budget-status ' + x.st.cls + '">' + x.st.icon + '<span>' + Fin.amtText(x.st.text) + '</span></span></li>';
    }
    function budgetCard(title, note, list) {
      if (!list.length) return '';
      var b = list.reduce(function (m, x) { return m + x.c.budget; }, 0), s = list.reduce(function (m, x) { return m + x.s; }, 0);
      return '<section class="fin-card"><div class="fin-card-head"><div><h2>' + esc(title) + '</h2><p class="fin-muted">' + esc(note) + '</p></div>' +
        '<span class="fin-muted"><span class="fin-amt">' + esc(Fin.money(s)) + '</span> of <span class="fin-amt">' + esc(Fin.money(b)) + '</span></span></div>' +
        '<ul class="fin-budgets">' + list.map(budgetRow).join('') + '</ul></section>';
    }
    var flexCard = budgetCard('Flexible spending', 'Judged against how far into the month it is.', items.filter(function (x) { return !x.f; }));
    var billCard = budgetCard('Bills', 'Mostly regular bills, so only going over counts.', items.filter(function (x) { return x.f; }));
    var lists = flexCard && billCard ? '<div class="fin-row fin-budget-cols">' + flexCard + billCard + '</div>' : flexCard + billCard;
    var loose = Object.keys(spent).filter(function (k) { var c = cats().filter(function (x) { return x.id === k; })[0]; return !(c && c.budget) && spent[k] > 0; })
      .sort(function (a, b) { return spent[b] - spent[a]; });
    var looseTotal = loose.reduce(function (m, k) { return m + spent[k]; }, 0);
    var all = overall(spent, pace), totalB = all.total, totalS = all.spent;
    box.innerHTML = head +
      '<section class="fin-card"><div class="fin-split fin-split--big"><span>Budgeted <b>' + Fin.amt(totalB) + '</b></span><span>Spent <b>' + Fin.amt(totalS) + '</b></span>' +
        '<span>' + (totalS > totalB ? 'Over <b>' + Fin.amt(totalS - totalB) + '</b>' : 'Left <b>' + Fin.amt(totalB - totalS) + '</b>') + '</span></div>' +
        meter(totalS, totalB, pace < 1 ? all.marker : 1, all.cls) +
        '<p class="fin-muted fin-budget-note">' + (pace < 1 ? 'Day ' + Fin.data.today.slice(8, 10).replace(/^0/, '') + ' of ' + daysIn(month) + '. The line marks where spending would be by now: bills already paid, plus the rest spread evenly through the month.' : 'The whole month.') +
        ' Budgets are for the whole household.</p></section>' +
      lists +
      (loose.length ? '<section class="fin-card"><div class="fin-card-head"><h2>Without a budget</h2><span class="fin-muted">' + Fin.amt(looseTotal) + '</span></div>' +
        '<ul class="fin-recent">' + loose.map(function (k) {
          var c = cats().filter(function (x) { return x.id === k; })[0];
          return '<li><span class="fin-acct-name">' + esc(c ? c.name : 'Uncategorized') + '</span><span class="fin-tx-amt">' + Fin.amt(spent[k]) + '</span></li>';
        }).join('') + '</ul></section>' : '');
  }

  function editView(box, data, head) {
    var avg = averages(data, 3), last = spendIn(data, shift(Fin.data.today.slice(0, 7), -1));
    var list = expenseCats().slice().sort(function (a, b) { return (avg[b.id] || 0) - (avg[a.id] || 0); });
    box.innerHTML = head + '<section class="fin-card"><div class="fin-card-head"><div><h2>Monthly budgets</h2><p class="fin-muted">Leave a box empty for no budget. “Use averages” fills the empty ones from the last three months, rounded to $10.</p></div>' +
      '<div class="hub-actions"><button class="btn btn-ghost btn-sm" type="button" data-bavg>Use averages</button></div></div>' +
      '<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>Category</th><th class="num">3-month average</th><th class="num">Last month</th><th class="num">Budget</th></tr></thead><tbody>' +
      list.map(function (c) {
        return '<tr><td>' + esc(c.name) + (c.essential ? '<span class="fin-acct-sub"> essential</span>' : '') + '</td><td class="num fin-amt">' + esc(Fin.money(avg[c.id] || 0)) + '</td><td class="num fin-amt">' + esc(Fin.money(last[c.id] || 0)) + '</td>' +
          '<td class="num"><input class="fin-cell" inputmode="decimal" data-budget="' + esc(c.id) + '" data-avg="' + (avg[c.id] || 0) + '" value="' + esc(Fin.moneyInput(c.budget)) + '" aria-label="Budget for ' + esc(c.name) + '" /></td></tr>';
      }).join('') + '</tbody><tfoot><tr><th>Total</th><td class="num fin-amt">' + esc(Fin.money(list.reduce(function (m, c) { return m + (avg[c.id] || 0); }, 0))) + '</td><td></td><td class="num" data-btotal></td></tr></tfoot></table></div>' +
      '<div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-bcancel>Cancel</button><button class="btn btn-primary" type="button" data-bsave>Save budgets</button></div></section>';
    function total() {
      var t = 0, bad = false;
      $$('[data-budget]', box).forEach(function (i) { var v = Fin.parseMoney(i.value); i.classList.toggle('is-bad', isNaN(v)); if (isNaN(v)) bad = true; else t += v || 0; });
      $('[data-btotal]', box).innerHTML = Fin.amt(t);
      $('[data-bsave]', box).disabled = bad;
    }
    $('.fin-table', box).addEventListener('input', total);
    total();
  }

  function saveBudgets(box, fromAverages) {
    var budgets = {};
    if (fromAverages) {
      var avg = fromAverages;
      expenseCats().forEach(function (c) { if ((avg[c.id] || 0) >= 1000) budgets[c.id] = round10(avg[c.id]); });
    } else {
      $$('[data-budget]', box).forEach(function (i) { var v = Fin.parseMoney(i.value); budgets[i.getAttribute('data-budget')] = v || null; });
    }
    return Fin.save('fin-budgets', { body: { budgets: budgets } }).then(function () { editing = false; Fin.rerender(); Hub.toast('Budgets saved'); })
      .catch(function (e) { Hub.toast(e.message, true); });
  }

  /* ---------- goals ---------- */
  function progressOf(g, balanceOf) {
    balanceOf = balanceOf || function (id) { var a = acct(id); return a ? a.balance || 0 : null; };
    if (g.kind === 'payoff') { var b = balanceOf(g.accounts[0]); return b == null ? null : Math.max(0, g.target - b); }
    if ((g.accounts || []).length) return g.accounts.reduce(function (s, id) { return s + (balanceOf(id) || 0); }, 0);
    return g.saved || 0;
  }
  function monthsBetween(a, b) { return (new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / (30.44 * 864e5); }
  // Everything a goal card says: progress, what it takes a month, pace.
  function goalStatus(g) {
    var today = Fin.data.today, p = progressOf(g) || 0, left = Math.max(0, g.target - p);
    var st = { progress: p, left: left, pct: g.target ? Math.min(1, p / g.target) : 0, done: p >= g.target };
    if (st.done) return st;
    if (g.date) {
      var m = monthsBetween(today, g.date);
      if (m <= 0) st.late = true;
      else st.perMonth = left / Math.max(m, 0.5);
      if (g.startDate && g.startDate < today && g.startValue != null && g.date > g.startDate) {
        var expected = g.startValue + (g.target - g.startValue) * Math.min(1, monthsBetween(g.startDate, today) / monthsBetween(g.startDate, g.date));
        if (expected - p > g.target * 0.02) st.behind = expected - p;
      }
    }
    // Recent pace, for goals that follow accounts: change since three month-ends ago.
    if ((g.accounts || []).length) {
      var byM = {};
      (Fin.data.snapshots.monthly || []).forEach(function (e) { byM[e.m] = e; });
      var then = byM[shift(today.slice(0, 7), -3)];
      if (then) {
        // Months since that month-end (about 2 to 3, depending on today's date).
        var thenDay = Fin.dayKey(new Date(+then.m.slice(0, 4), +then.m.slice(5, 7), 0));
        var span = Math.max(1, monthsBetween(thenDay, today));
        if (g.kind === 'payoff') {
          // Paid down: the debt's balance then minus now (the goal may be newer than that).
          var a = acct(g.accounts[0]), was = then.b[g.accounts[0]];
          if (a && was != null) st.pace = (was - (a.balance || 0)) / span;
        } else {
          var before = progressOf(g, function (id) { return then.b[id] != null ? then.b[id] : null; });
          if (before != null) st.pace = (p - before) / span;
        }
        if (st.pace > 0) st.eta = Math.ceil(left / st.pace);
      }
    }
    return st;
  }
  Fin.goalStatus = goalStatus;
  function whenIn(months) { var d = Fin.monthDate(Fin.data.today.slice(0, 7)); d.setMonth(d.getMonth() + months); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function statusLine(g, st) {
    if (st.done) return '<span class="fin-goal-status ok">' + Hub.icons.check + 'Reached</span>';
    var bits = [];
    if (st.late) bits.push('<span class="fin-goal-status over">' + Hub.icons.x + 'The date has passed</span>');
    else if (st.perMonth != null) bits.push('<span class="fin-goal-status ' + (st.behind ? 'warn' : 'ok') + '">' + (st.behind ? Hub.icons.up : Hub.icons.check) +
      '<span><span class="fin-amt">' + esc(Fin.money(st.perMonth)) + '</span> a month to get there by ' + esc(new Date(g.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })) +
      (st.behind ? ' · behind pace by <span class="fin-amt">' + esc(Fin.money(st.behind)) + '</span>' : '') + '</span></span>');
    if (st.eta) bits.push('<span class="fin-muted">At the last three months’ pace: ' + esc(whenIn(st.eta)) + '</span>');
    else if (st.pace != null && st.pace <= 0) bits.push('<span class="fin-muted">No progress over the last three months</span>');
    return bits.join('');
  }
  function goalCard(g) {
    var st = goalStatus(g);
    var linked = (g.accounts || []).map(acct).filter(Boolean).map(function (a) { return a.nick || a.name; });
    return '<button class="fin-card fin-goal" type="button" data-goal="' + esc(g.id) + '">' +
      '<span class="fin-label">' + (g.kind === 'payoff' ? 'Pay off' : 'Save up') + (linked.length ? ' · ' + esc(linked.join(', ')) : ' · kept by hand') + '</span>' +
      '<span class="fin-goal-name">' + esc(g.name) + '</span>' +
      '<span class="fin-goal-nums"><b class="fin-amt">' + esc(Fin.money(st.progress)) + '</b> <span class="fin-muted">of <span class="fin-amt">' + esc(Fin.money(g.target)) + '</span> · ' + Math.round(st.pct * 100) + '%</span></span>' +
      '<span class="fin-meter ' + (st.done ? 'ok' : st.behind || st.late ? 'warn' : 'ok') + '"><span class="fin-meter-fill" style="width:' + (st.pct * 100) + '%"></span></span>' +
      '<span class="fin-goal-foot">' + statusLine(g, st) + '</span></button>';
  }
  Fin.goalCard = goalCard;

  // An emergency fund of 3 to 6 months of essentials, from the last three months.
  function emergencyHint(data) {
    if ((Fin.data.goals || []).some(function (g) { return g.template === 'emergency'; })) return '';
    var avg = averages(data, 3), essentials = 0;
    cats().forEach(function (c) { if (c.essential) essentials += avg[c.id] || 0; });
    if (!essentials) return '';
    var cash = Fin.data.accounts.filter(function (a) { return a.type === 'cash' && !a.hidden; }).reduce(function (m, a) { return m + (a.balance || 0); }, 0);
    return '<section class="fin-card fin-hint"><div><h2>An emergency fund</h2><p>Your essentials (housing, utilities, groceries, transport, insurance, health, loan payments) come to about ' + Fin.amt(essentials) + ' a month. ' +
      'A common rule of thumb is to keep 3 to 6 months of that set aside: <b>' + Fin.amt(essentials * 3) + ' to ' + Fin.amt(essentials * 6) + '</b>. You have ' + Fin.amt(cash) + ' in cash accounts.</p></div>' +
      '<button class="btn btn-primary btn-sm" type="button" data-emergency="' + essentials * 3 + '">Make it a goal</button></section>';
  }

  function goalsView(box, data) {
    var goals = Fin.data.goals || [];
    box.innerHTML = '<div class="fin-acct-head"><span class="fin-muted">' + (goals.length ? Hub.plural(goals.length, 'goal') : 'No goals yet') + '</span>' +
      '<div class="hub-actions"><button class="btn btn-primary btn-sm" type="button" data-goal-add>' + Hub.icons.plus + 'Add a goal</button></div></div>' +
      emergencyHint(data) +
      (goals.length ? '<div class="fin-goals">' + goals.slice().sort(function (a, b) { return goalStatus(a).done - goalStatus(b).done; }).map(goalCard).join('') + '</div>'
        : '<div class="fin-soon"><h2>Save for something, or pay something off</h2><p>A goal can follow an account’s balance (a savings account for a trip, say), be kept by hand, or track paying down a debt.</p></div>');
  }

  function goalForm(g, preset) {
    g = g || null; preset = preset || {};
    var assets = Fin.data.accounts.filter(function (a) { return Fin.sideOf(a) === 'asset' && !a.hidden; });
    var debts = Fin.data.accounts.filter(function (a) { return Fin.sideOf(a) === 'liability' && !a.hidden && (a.balance || 0) > 0; });
    var kind = g ? g.kind : preset.kind || 'save';
    var chosen = g ? g.accounts || [] : preset.accounts || [];
    var m = document.createElement('div');
    m.className = 'hub-modal';
    m.innerHTML = '<div class="hub-modal-box cal-form" role="dialog" aria-modal="true" aria-labelledby="gf-title"><h3 id="gf-title">' + (g ? 'Edit goal' : 'Add a goal') + '</h3><form novalidate>' +
      '<div class="fin-seg" role="group" aria-label="Kind of goal" data-gkind><button type="button" data-v="save"' + (kind === 'save' ? ' class="on"' : '') + '>Save up</button><button type="button" data-v="payoff"' + (kind === 'payoff' ? ' class="on"' : '') + '>Pay off a debt</button></div>' +
      '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" placeholder="Emergency fund, Hawaii trip, new car…" /></label>' +
      '<div data-for="save"><label class="field"><span>Goal amount</span><input class="input" name="target" inputmode="decimal" placeholder="10,000" /></label></div>' +
      '<div data-for="payoff"><label class="field"><span>Which debt</span><select name="debt">' + debts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc((a.nick || a.name) + (Fin.amountsHidden() ? '' : ' · ' + Fin.money(a.balance))) + '</option>'; }).join('') + '</select></label>' +
        (debts.length ? '' : '<p class="fin-muted">No debts with a balance.</p>') + '</div>' +
      '<label class="field"><span>By when</span><input class="input" type="date" name="date" min="' + Fin.data.today + '" /><small>Optional. With a date, the goal shows what it takes a month.</small></label>' +
      '<div data-for="save"><span class="field-label">Follow these accounts</span><div class="fin-checklist">' + assets.map(function (a) {
        return '<label class="cf-check"><input type="checkbox" name="acct" value="' + esc(a.id) + '"' + (chosen.indexOf(a.id) > -1 ? ' checked' : '') + ' /> ' + esc(a.nick || a.name) + ' · ' + Fin.amt(a.balance) + '</label>';
      }).join('') + '</div><small class="fin-muted">Or leave them all unticked and keep track by hand.</small>' +
      '<label class="field" data-manual><span>Saved so far</span><input class="input" name="saved" inputmode="decimal" placeholder="0" /></label></div>' +
      '<p class="cf-error" role="alert" hidden></p>' +
      '<div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">' + (g ? 'Save' : 'Add goal') + '</button></div></form></div>';
    var form = $('form', m), el = form.elements;
    el.name.value = g ? g.name : preset.name || '';
    el.target.value = g && g.kind === 'save' ? Fin.moneyInput(g.target) : preset.target ? Fin.moneyInput(round10(preset.target)) : '';
    el.date.value = g && g.date ? g.date : '';
    el.saved.value = g && g.saved ? Fin.moneyInput(g.saved) : '';
    if (g && g.kind === 'payoff' && el.debt) el.debt.value = g.accounts[0];
    function sync() {
      $$('[data-for]', m).forEach(function (x) { x.hidden = x.getAttribute('data-for') !== kind; });
      var anyAcct = $$('input[name=acct]', m).some(function (i) { return i.checked; });
      $('[data-manual]', m).hidden = anyAcct;
    }
    $('[data-gkind]', m).addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]'); if (!b) return;
      kind = b.getAttribute('data-v');
      $$('[data-gkind] [data-v]', m).forEach(function (x) { x.classList.toggle('on', x === b); });
      sync();
    });
    form.addEventListener('change', sync);
    sync();
    function close() { m.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    $('[data-cancel]', m).addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('.cf-error', m);
      function bad(t) { err.textContent = t; err.hidden = false; }
      if (!el.name.value.trim()) return bad('Give the goal a name.');
      var body = { id: g ? g.id : undefined, name: el.name.value, kind: kind, date: el.date.value || null, template: preset.template };
      if (kind === 'payoff') {
        if (!el.debt || !el.debt.value) return bad('Pick the debt to pay off.');
        body.accounts = [el.debt.value];
        body.target = g && g.kind === 'payoff' && g.accounts[0] === el.debt.value ? g.target : null;
      } else {
        var t = Fin.parseMoney(el.target.value);
        if (!t || isNaN(t)) return bad('Enter the goal amount, like 10,000.');
        body.target = t;
        body.accounts = $$('input[name=acct]', m).filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
        if (!body.accounts.length) { var s = Fin.parseMoney(el.saved.value); if (isNaN(s)) return bad('“Saved so far” should be an amount.'); body.saved = s || 0; }
      }
      var btn = $('[type=submit]', m); btn.disabled = true;
      Fin.save('fin-goal', { body: body }).then(function () { close(); Hub.toast(g ? 'Saved' : 'Goal added'); if (g && $('#drawer').classList.contains('open')) openGoal(g.id); })
        .catch(function (e2) { bad(e2.message); btn.disabled = false; });
    });
    document.body.appendChild(m);
    el.name.focus();
  }

  function openGoal(id) {
    var g = (Fin.data.goals || []).filter(function (x) { return x.id === id; })[0];
    if (!g) { Fin.closeDrawer(); return; }
    var st = goalStatus(g), manual = g.kind === 'save' && !(g.accounts || []).length;
    var body = Fin.openDrawer(g.name,
      '<div><span class="fin-label">' + (g.kind === 'payoff' ? 'Paid off' : 'Saved') + '</span><div class="fin-kpi-value">' + Fin.amt(st.progress) + '</div>' +
        '<span class="fin-muted">of <span class="fin-amt">' + esc(Fin.money(g.target)) + '</span> · <span class="fin-amt">' + esc(Fin.money(st.left)) + '</span> to go</span></div>' +
      '<span class="fin-meter ok"><span class="fin-meter-fill" style="width:' + (st.pct * 100) + '%"></span></span>' +
      '<div class="fin-goal-foot">' + statusLine(g, st) + '</div>' +
      (manual ? '<form class="fin-balance-form" data-goal-add-money><label class="field"><span>Add to it (or take out, with a minus)</span><span class="fin-inline"><input class="input" name="amt" inputmode="decimal" placeholder="100" /><button class="btn btn-primary btn-sm" type="submit">Add</button></span></label></form>' : '') +
      '<dl class="fin-facts">' + (g.date ? '<div><dt>By</dt><dd>' + esc(new Date(g.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) + '</dd></div>' : '') +
        '<div><dt>Follows</dt><dd>' + esc((g.accounts || []).map(acct).filter(Boolean).map(function (a) { return a.nick || a.name; }).join(', ') || 'Kept by hand') + '</dd></div>' +
        '<div><dt>Started</dt><dd>' + esc(new Date(g.startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) + '</dd></div></dl>' +
      '<div class="fin-drawer-actions"><button class="btn btn-ghost btn-sm" type="button" data-goal-edit>' + Hub.icons.edit + 'Edit</button><button class="btn btn-danger btn-sm" type="button" data-goal-del>' + Hub.icons.trash + 'Delete</button></div>');
    var add = $('[data-goal-add-money]', body);
    if (add) add.addEventListener('submit', function (e) {
      e.preventDefault();
      var raw = add.elements.amt.value.trim(), neg = /^[-−]/.test(raw), v = Fin.parseMoney(raw.replace(/^[-−]/, ''));
      if (!v || isNaN(v)) { Hub.toast('Enter an amount, like 100.', true); return; }
      Fin.save('fin-goal', { body: { id: g.id, add: neg ? -v : v } }).then(function () { Hub.toast('Updated'); openGoal(g.id); }).catch(function (er) { Hub.toast(er.message, true); });
    });
    $('[data-goal-edit]', body).addEventListener('click', function () { goalForm(g); });
    $('[data-goal-del]', body).addEventListener('click', function () {
      Hub.confirm({ title: 'Delete “' + g.name + '”?', danger: true, confirm: 'Delete', body: '<p>Only the goal goes; the accounts it follows stay as they are.</p>' }).then(function (yes) {
        if (yes) Fin.save('fin-goal', { method: 'DELETE', query: { id: g.id } }).then(function () { Fin.closeDrawer(); Hub.toast('Deleted'); }).catch(function (er) { Hub.toast(er.message, true); });
      });
    });
  }

  /* ---------- sections: Budgets and Goals ---------- */
  var lastData = null;
  function section(which) {
    return function (box) {
      if (view !== which) editing = false;
      view = which;
      box.innerHTML = '<div data-plan-box><p class="hub-loading">Adding things up…</p></div>';
      var inner = $('[data-plan-box]', box);
      (Fin.reportData ? Fin.reportData() : Promise.resolve({ months: [], rows: [] })).then(function (data) {
        lastData = data;
        if (view === 'goals') goalsView(inner, data); else { budgetsView(inner, data); if (Fin.ensureRecurring) Fin.ensureRecurring(); }
        inner.className = 'fin-report';
      }).catch(function (e) { inner.innerHTML = '<p class="fin-muted">Couldn’t load the numbers: ' + esc(e.message) + '</p>'; });
    };
  }
  Fin.tab('budgets', section('budgets'));
  Fin.tab('goals', section('goals'));
  document.addEventListener('click', function (e) {
    if (!(Fin.at('budgets') || Fin.at('goals')) || !$('#view').contains(e.target)) return;
    var t = e.target.closest('[data-bmonth],[data-bedit],[data-bcancel],[data-bsave],[data-bavg],[data-bfill],[data-goal],[data-goal-add],[data-emergency]');
    if (!t) return;
    var box = $('[data-plan-box]');
    if (t.hasAttribute('data-bmonth')) { month = shift(month, +t.getAttribute('data-bmonth')); return Fin.rerender(); }
    if (t.hasAttribute('data-bedit')) { editing = true; return Fin.rerender(); }
    if (t.hasAttribute('data-bcancel')) { editing = false; return Fin.rerender(); }
    if (t.hasAttribute('data-bsave')) return saveBudgets(box);
    if (t.hasAttribute('data-bfill')) return saveBudgets(box, averages(lastData, 3));
    if (t.hasAttribute('data-bavg')) {
      $$('[data-budget]', box).forEach(function (i) { var a = +i.getAttribute('data-avg'); if (!i.value.trim() && a >= 1000) { i.value = Fin.moneyInput(round10(a)); } });
      $('.fin-table', box).dispatchEvent(new Event('input'));
      return;
    }
    if (t.hasAttribute('data-goal')) return openGoal(t.getAttribute('data-goal'));
    if (t.hasAttribute('data-goal-add')) return goalForm(null);
    if (t.hasAttribute('data-emergency')) {
      var savings = Fin.data.accounts.filter(function (a) { return a.type === 'cash' && /sav/i.test(a.name || '') && !a.hidden; }).map(function (a) { return a.id; });
      return goalForm(null, { name: 'Emergency fund', target: +t.getAttribute('data-emergency'), accounts: savings, template: 'emergency' });
    }
  });
  Fin.openGoals = function (id) { Fin.go('goals'); if (id) setTimeout(function () { openGoal(id); }, 300); };
})();
