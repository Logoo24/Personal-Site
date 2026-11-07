/* ============================================================
   Finance > Overview: net worth (hero figure + 12-month chart),
   cash / cards / investments tiles, and where it all sits.
   Before anything is set up, a setup guide instead.
   ============================================================ */
(function () {
  'use strict';
  var esc = Hub.esc;
  var chartMode = 'net';

  // Totals for a snapshot entry ({ b: { accountId: cents } }) over the given
  // accounts. null when none of them has a balance in it.
  function totals(entry, accts) {
    var t = { net: 0, assets: 0, debts: 0, any: false };
    accts.forEach(function (a) {
      var v = entry.b ? entry.b[a.id] : null;
      if (v == null) return;
      t.any = true;
      if (Fin.sideOf(a) === 'liability') { t.debts += v; t.net -= v; } else { t.assets += v; t.net += v; }
    });
    return t.any ? t : null;
  }
  function liveTotals(accts) {
    var b = {};
    accts.forEach(function (a) { b[a.id] = a.balance || 0; });
    return totals({ b: b }, accts) || { net: 0, assets: 0, debts: 0 };
  }

  // Value pick for a set of accounts (assets positive, cards/loans as owed).
  function groupValue(t, side) { return side === 'liability' ? t.debts : t.assets; }

  // The balance about 30 days ago, from the daily snapshots.
  function thirtyDaysAgo(accts, pick) {
    var cut = new Date(); cut.setDate(cut.getDate() - 30);
    var key = Fin.dayKey(cut), daily = Fin.data.snapshots.daily || [], hit = null;
    for (var i = daily.length - 1; i >= 0; i--) if (daily[i].d <= key) { hit = daily[i]; break; }
    var t = hit && totals(hit, accts);
    return t ? pick(t) : null;
  }

  function deltaHTML(change, upIsGood) {
    if (change == null) return '';
    var dir = Math.abs(change) < 100 ? 'flat' : (change > 0) === upIsGood ? 'good' : 'bad';
    var icon = Math.abs(change) < 100 ? '' : change > 0 ? Hub.icons.up : Hub.icons.down;
    return '<span class="fin-delta ' + dir + '">' + icon + Fin.amt(change, { sign: true }) + ' <small>in 30 days</small></span>';
  }

  // A month is estimated (dashed) when any of these accounts' values in it
  // was typed in or rebuilt rather than recorded.
  function isEst(e, accts) {
    if (!e || !e.est) return false;
    if (e.est === true) return true;
    return accts.some(function (a) { return e.est.indexOf(a.id) > -1; });
  }

  function monthlySeries(accts) {
    var now = Fin.monthDate(Fin.data.today.slice(0, 7)), byMonth = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byMonth[e.m] = e; });
    var labels = [], titles = [], net = [], assets = [], debts = [], est = [];
    for (var k = 12; k >= 1; k--) {
      var d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      var e = byMonth[Fin.monthKey(d)], t = e && totals(e, accts);
      labels.push(d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? ' ’' + String(d.getFullYear()).slice(2) : ''));
      titles.push('End of ' + d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
      net.push(t ? t.net : null); assets.push(t ? t.assets : null); debts.push(t ? t.debts : null);
      est.push(isEst(e, accts));
    }
    var live = liveTotals(accts);
    labels.push('Now'); titles.push('Today');
    net.push(live.net); assets.push(live.assets); debts.push(live.debts); est.push(false);
    return { labels: labels, titles: titles, net: net, assets: assets, debts: debts, est: est };
  }

  function dailySeries(accts, pick) {
    var vals = (Fin.data.snapshots.daily || []).slice(-90).map(function (e) { var t = totals(e, accts); return t ? pick(t) : null; });
    vals.push(pick(liveTotals(accts)));
    return vals;
  }

  function drawNetChart(el, s) {
    var fmt = function (v) { return Fin.money(v); }, axis = function (v) { return Fin.money(v, { compact: true }); };
    if (s.net.filter(function (v) { return v != null; }).length < 2) {
      el.innerHTML = '<p class="fin-muted">The graph fills in month by month. <button class="fin-link" type="button">Type in past months</button> to see the whole year now.</p>';
      el.querySelector('.fin-link').addEventListener('click', function () { Fin.openHistory(); });
      return;
    }
    if (chartMode === 'net') {
      FinCharts.line(el, { labels: s.labels, titles: s.titles, est: s.est, format: fmt, axisFormat: axis, height: 260,
        series: [{ name: 'Net worth', color: 'var(--accent)', values: s.net, area: true }],
        ariaLabel: 'Net worth at the end of each of the last 12 months, and today' });
    } else {
      FinCharts.line(el, { labels: s.labels, titles: s.titles, est: s.est, format: fmt, axisFormat: axis, height: 260, zero: true,
        series: [{ name: 'What you own', color: 'var(--fc-1)', values: s.assets }, { name: 'What you owe', color: 'var(--fc-2)', values: s.debts }],
        ariaLabel: 'What you own and what you owe at the end of each of the last 12 months, and today' });
    }
  }

  function setupGuide(view, F) {
    var s = F.data.setup;
    var check = function (ok, label, hint) {
      return '<li class="' + (ok ? 'ok' : 'no') + '">' + (ok ? Hub.icons.check : Hub.icons.x) + '<span>' + label + (ok ? '' : ' <span class="fin-muted">· ' + hint + '</span>') + '</span></li>';
    };
    view.innerHTML = '<section class="fin-setup">' +
      '<h2>Let’s set up your money dashboard</h2>' +
      '<p>Finance brings your bank accounts, cards, investments and loans into one view for the two of you. It only reads balances and transactions: nothing here can move money.</p>' +
      '<ol class="fin-steps">' +
        '<li><strong>Link your banks</strong><span>Checking, savings, credit cards and investments, through Plaid. Joint accounts only need linking once.' + (s.plaid ? '' : ' Needs the Plaid keys below first.') + '</span>' +
          (s.plaid ? '<span class="fin-step-action"><button class="btn btn-primary btn-sm" type="button" data-setup="link">' + Hub.icons.bank + 'Link a bank</button></span>' : '') + '</li>' +
        '<li><strong>Add what Plaid can’t see</strong><span>A car, a home, a loan or cash, with balances you keep up to date.</span>' +
          '<span class="fin-step-action"><button class="btn btn-ghost btn-sm" type="button" data-setup="add">' + Hub.icons.plus + 'Add an asset or debt</button></span></li>' +
        '<li><strong>Fill in past months</strong><span>So the net-worth graph covers the whole last year. Do this once your accounts are in.</span></li>' +
      '</ol>' +
      '<div class="fin-card" style="margin-top:1.5rem"><div class="fin-card-head"><h2>Setup status</h2></div><ul class="fin-checks">' +
        check(s.encryption, 'Encryption key', 'set <code>FINANCE_ENCRYPTION_KEY</code>') +
        check(s.plaid, 'Plaid keys' + (s.plaid ? ' (' + esc(s.plaidEnv) + ')' : ''), 'set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code>') +
        check(s.claude, 'Claude, for categories and advice', 'set <code>ANTHROPIC_API_KEY</code>') +
        check(s.cron, 'Daily refresh', 'set <code>CRON_SECRET</code>') +
      '</ul></div>' +
    '</section>';
    view.querySelector('[data-setup="add"]').addEventListener('click', function () { Fin.openAccountForm(); });
    var link = view.querySelector('[data-setup="link"]');
    if (link) link.addEventListener('click', function () { Fin.go('accounts'); Fin.linkBank(); });
  }

  // Only when something needs doing: a bank to sign in to again, transactions to look over.
  function alertsHTML(F) {
    var out = [];
    var reconnect = (F.data.items || []).filter(function (i) { return i.status === 'reconnect'; });
    if (reconnect.length) out.push('<button class="fin-alert fin-alert--bad" type="button" data-alert="accounts">' + Hub.icons.bank + '<span>' +
      esc(reconnect.map(function (i) { return i.inst; }).join(', ')) + (reconnect.length === 1 ? ' needs' : ' need') + ' you to sign in again</span>' + Hub.icons.right + '</button>');
    if (F.data.toReview) out.push('<button class="fin-alert" type="button" data-alert="review">' + Hub.icons.sparkle + '<span>' +
      Hub.plural(F.data.toReview, 'transaction') + ' to look over</span>' + Hub.icons.right + '</button>');
    // A monthly nudge for the viewer's own credit score, once they've started tracking it.
    var mine = (F.data.credit || []).filter(function (c) { return c.person === F.data.viewer.email; });
    var last = mine[mine.length - 1];
    if (last && (new Date(F.data.today + 'T12:00:00') - new Date(last.date + 'T12:00:00')) / 864e5 > 30) {
      out.push('<button class="fin-alert" type="button" data-alert-score>' + Hub.icons.plus + '<span>Time for this month’s credit score (last one: ' +
        esc(new Date(last.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })) + ')</span>' + Hub.icons.right + '</button>');
    }
    (F.data.recurring || []).filter(function (r) {
      if (!r.priceUp || r.status === 'ignored' || r.ended) return false;
      var a = r.acct && F.data.accounts.filter(function (x) { return x.id === r.acct; })[0];
      return !a || F.matches(a);
    }).forEach(function (r) {
      out.push('<button class="fin-alert fin-alert--up" type="button" data-alert-rc="' + esc(r.id) + '">' + Hub.icons.up + '<span>' + esc(r.name) + ' went up from ' +
        Fin.amt(r.priceUp.from, { cents: true }) + ' to ' + Fin.amt(r.priceUp.to, { cents: true }) + '</span>' + Hub.icons.right + '</button>');
    });
    // One card, a row each, instead of a stack of separate bars.
    return out.length ? '<section class="fin-card fin-attn"><div class="fin-card-head"><h2>Needs attention</h2><span class="fin-muted">' + out.length + '</span></div>' +
      '<div class="fin-attn-list">' + out.join('') + '</div></section>' : '';
  }

  // Paychecks and other regular income still expected later this month,
  // for the accounts on screen.
  function expectedIn(F) {
    var cur = F.data.today.slice(0, 7);
    return (F.data.upcoming || []).filter(function (u) {
      if (u.dir !== 'in' || u.kind === 'due' || !u.amount || u.date.slice(0, 7) !== cur) return false;
      var r = (F.data.recurring || []).filter(function (x) { return x.id === u.id; })[0];
      if (r && r.person) return F.person === 'all' || r.person === F.person;
      var a = u.acct && F.data.accounts.filter(function (x) { return x.id === u.acct; })[0];
      return !a || F.matches(a);
    }).reduce(function (m, u) { return m + u.amount; }, 0);
  }

  // This month so far: money in, spent, what's left, the pace against the
  // same point last month, and where it went. Transfers aren't counted.
  function thisMonthHTML(F) {
    var tx = (F.data.monthTx || []).filter(function (t) {
      var a = F.data.accounts.filter(function (x) { return x.id === t.acct; })[0];
      return a && F.matches(a);
    });
    if (!tx.length && !(F.data.recent || []).length) return '';
    var cur = F.data.today.slice(0, 7), dom = +F.data.today.slice(8, 10);
    var mine = tx.filter(function (t) { return t.date.slice(0, 7) === cur; });
    var prev = tx.filter(function (t) { return t.date.slice(0, 7) !== cur; });
    var inn = mine.filter(function (t) { return t.amt > 0; }).reduce(function (m, t) { return m + t.amt; }, 0);
    var out = mine.filter(function (t) { return t.amt < 0; }).reduce(function (m, t) { return m - t.amt; }, 0);
    var prevToDate = prev.filter(function (t) { return t.amt < 0 && +t.date.slice(8, 10) <= dom; }).reduce(function (m, t) { return m - t.amt; }, 0);
    var diff = out - prevToDate, pace;
    if (!prev.length) pace = '';
    else if (Math.abs(diff) < Math.max(2000, prevToDate * 0.05)) pace = '<p class="fin-pace">About the same as this time last month.</p>';
    else pace = '<p class="fin-pace ' + (diff < 0 ? 'good' : 'bad') + '">' + (diff < 0 ? Hub.icons.down : Hub.icons.up) +
      '<span>' + Fin.amt(Math.abs(diff)) + (diff < 0 ? ' less' : ' more') + ' spent than by this time last month</span></p>';
    var byCat = {};
    mine.filter(function (t) { return t.amt < 0; }).forEach(function (t) { byCat[t.cat || ''] = (byCat[t.cat || ''] || 0) - t.amt; });
    var names = {};
    (F.data.categories || []).forEach(function (c) { names[c.id] = c.name; });
    var rows = Object.keys(byCat).map(function (k) { return { label: names[k] || 'Uncategorized', value: byCat[k] }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 5);
    var start = new Date(cur + '-01T12:00:00');
    // Early in the month, before payday, "left" would read as a loss; count
    // the regular income still on its way, and say so.
    var coming = expectedIn(F);
    return '<section class="fin-card"><div class="fin-card-head"><h2>This month</h2><span class="fin-muted">' +
      esc(start.toLocaleDateString('en-US', { month: 'long' }) + ' 1–' + dom) + '</span></div>' +
      '<div class="fin-split fin-split--big"><span>In <b>' + Fin.amt(inn) + '</b></span><span>Spent <b>' + Fin.amt(out) + '</b></span>' +
        '<span>' + (coming ? 'Left after payday' : 'Left') + ' <b>' + Fin.amt(inn + coming - out, { sign: true }) + '</b></span></div>' +
      (coming ? '<p class="fin-muted fin-tm-coming">Counts ' + Fin.amt(coming) + ' in regular income still expected this month.</p>' : '') +
      pace + budgetLine(F) + (rows.length ? '<div class="fin-tm-cats" data-hbars="cats"></div>' : '<p class="fin-muted">No spending yet this month.</p>') +
      '<button class="fin-link" type="button" data-alert="transactions">See transactions</button></section>';
  }

  // Budgets are household-wide: this month's spending in budgeted
  // categories for everyone, against the total budget and the month's pace.
  function budgetLine(F) {
    var budgeted = (F.data.categories || []).filter(function (c) { return c.kind === 'expense' && c.budget; });
    if (!budgeted.length) return '';
    if (!Fin.budgetOverall) return '';
    var cur = F.data.today.slice(0, 7), byCat = {};
    (F.data.monthTx || []).forEach(function (t) { if (t.date.slice(0, 7) === cur && t.cat) byCat[t.cat] = (byCat[t.cat] || 0) - t.amt; });
    var d = new Date(cur + '-01T12:00:00'), pace = +F.data.today.slice(8, 10) / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    var b = Fin.budgetOverall(byCat, pace);
    return '<div class="fin-tm-budget"><div class="fin-budget-head"><span class="fin-label">Budgets</span><span><b class="fin-amt">' + esc(Fin.money(b.spent)) + '</b> <span class="fin-muted">of <span class="fin-amt">' + esc(Fin.money(b.total)) + '</span>' + (b.over ? ' · ' + b.over + ' over' : '') + '</span></span></div>' +
      '<span class="fin-meter ' + b.cls + '"><span class="fin-meter-fill" style="width:' + Math.min(100, b.total ? b.spent / b.total * 100 : 0) + '%"></span><span class="fin-meter-pace" style="left:' + b.marker * 100 + '%"></span></span>' +
      '<button class="fin-link" type="button" data-alert="budgets">Budgets</button></div>';
  }

  // Each person's latest credit score.
  function creditHTML(F) {
    var rows = (F.data.people || []).map(function (p) {
      var list = (F.data.credit || []).filter(function (c) { return c.person === p.email; });
      return list.length ? { p: p, c: list[list.length - 1] } : null;
    }).filter(Boolean);
    if (!rows.length) return '';
    return '<section class="fin-card"><div class="fin-card-head"><h2>Credit scores</h2><button class="fin-link" type="button" data-alert="credit">Credit</button></div>' +
      '<ul class="fin-mini-scores">' + rows.map(function (x) {
        var band = Fin.creditBandOf ? Fin.creditBandOf(x.c.score, x.c.model).name : '';
        return '<li><span><span class="fin-budget-name">' + esc(x.p.name) + '</span> <span class="fin-muted">' + esc(band) + '</span></span>' +
          '<span><b class="fin-amt">' + x.c.score + '</b> <span class="fin-muted">' + esc(new Date(x.c.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span></span></li>';
      }).join('') + '</ul></section>';
  }

  // The goals still in progress, nearest date first.
  function goalsHTML(F) {
    if (!Fin.goalStatus) return '';
    var list = (F.data.goals || []).map(function (g) { return { g: g, st: Fin.goalStatus(g) }; }).filter(function (x) { return !x.st.done; })
      .sort(function (a, b) { return (a.g.date || '9999') < (b.g.date || '9999') ? -1 : 1; }).slice(0, 4);
    if (!list.length) return '';
    return '<section class="fin-card"><div class="fin-card-head"><h2>Goals</h2><button class="fin-link" type="button" data-alert="goals">All goals</button></div>' +
      '<ul class="fin-mini-goals">' + list.map(function (x) {
        return '<li><button type="button" data-alert-goal="' + esc(x.g.id) + '"><span class="fin-budget-head"><span class="fin-budget-name">' + esc(x.g.name) + '</span><span><span class="fin-amt">' + esc(Fin.money(x.st.progress)) + '</span> of <span class="fin-amt">' + esc(Fin.money(x.g.target)) + '</span></span></span>' +
          '<span class="fin-meter ' + (x.st.behind || x.st.late ? 'warn' : 'ok') + '"><span class="fin-meter-fill" style="width:' + x.st.pct * 100 + '%"></span></span></button></li>';
      }).join('') + '</ul></section>';
  }

  function comingUpHTML(F) {
    if (!(F.data.upcoming || []).length && !(F.data.recurring || []).length) return '';
    return '<section class="fin-card"><div class="fin-card-head"><h2>Coming up</h2><span class="fin-muted">The next 7 days</span></div>' +
      (Fin.upcomingHTML ? Fin.upcomingHTML(F.data.recurring || [], 7) : '') +
      '<button class="fin-link" type="button" data-alert="recurring">See all</button></section>';
  }

  function recentHTML(F) {
    var list = (F.data.recent || []).filter(function (t) {
      var a = F.data.accounts.filter(function (x) { return x.id === t.acct; })[0];
      return a && F.matches(a);
    }).slice(0, 6);
    if (!list.length) return '';
    var cat = {};
    (F.data.categories || []).forEach(function (c) { cat[c.id] = c; });
    return '<section class="fin-card"><div class="fin-card-head"><h2>Recent transactions</h2><button class="fin-link" type="button" data-alert="transactions">See all</button></div>' +
      '<ul class="fin-recent">' + list.map(function (t) {
        var c = cat[t.cat], d = new Date(t.date + 'T12:00:00');
        var muted = (c && c.kind === 'transfer') || t.hidden;
        return '<li>' + Fin.catIcon(t.cat) + '<span class="fin-acct-main"><span class="fin-acct-name">' + esc(Fin.niceName(t.name)) + (t.pending ? '<span class="fin-tag">Pending</span>' : '') + '</span>' +
          '<span class="fin-acct-sub">' + esc((c ? c.name : 'Uncategorized') + ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span></span>' +
          '<span class="fin-tx-amt' + (t.amt > 0 ? ' is-in' : '') + (muted ? ' is-muted' : '') + '">' + Fin.amt(t.amt, { cents: true, sign: true }) + '</span></li>';
      }).join('') + '</ul></section>';
  }

  Fin.tab('overview', function (view, F) {
    if (!F.data.accounts.length) return setupGuide(view, F);
    var accts = F.accounts();
    var who = F.person === 'all' ? '' : F.ownerName(F.person);
    var banner = F.data.demo ? '<div class="fin-banner">' + Hub.icons.sparkle + '<span>This is demo data for trying Finance out. It isn’t your real money.</span></div>' : '';
    if (!accts.length) {
      view.innerHTML = banner + '<div class="fin-soon"><h2>No accounts for ' + esc(who || 'this view') + ' yet</h2><p>Accounts are tagged Joint or with one of your names. Pick Everyone to see them all.</p></div>';
      return;
    }

    var live = liveTotals(accts);
    var netThen = thirtyDaysAgo(accts, function (t) { return t.net; });
    var groups = {
      cash: accts.filter(function (a) { return a.type === 'cash'; }),
      credit: accts.filter(function (a) { return a.type === 'credit'; }),
      invest: accts.filter(function (a) { return a.type === 'investment' || a.type === 'retirement'; })
    };
    function tile(key, label, list, side) {
      var t = liveTotals(list), value = groupValue(t, side);
      var then = list.length ? thirtyDaysAgo(list, function (x) { return groupValue(x, side); }) : null;
      var extra = '';
      if (key === 'credit') {
        var limit = list.reduce(function (m, a) { return m + (a.limit || 0); }, 0);
        if (limit) extra = '<p class="fin-muted">' + Math.round(value / limit * 100) + '% of ' + Fin.amt(limit) + ' in limits</p>';
      }
      return '<div class="fin-card fin-kpi"><span class="fin-label">' + esc(label) + '</span>' +
        '<div class="fin-kpi-value">' + Fin.amt(value) + '</div>' +
        (list.length ? deltaHTML(then == null ? null : value - then, side !== 'liability') : '<span class="fin-muted">None added yet</span>') + extra +
        (list.length ? '<div class="fc-spark-wrap" data-spark="' + key + '"></div>' : '') + '</div>';
    }

    // Where it sits: each group's total, largest first.
    function breakdown(side) {
      var by = {};
      accts.filter(function (a) { return Fin.sideOf(a) === side; }).forEach(function (a) {
        var g = (Fin.TYPES[a.type] || {}).group || 'Other';
        by[g] = by[g] || { label: g, value: 0, n: 0 };
        by[g].value += a.balance || 0; by[g].n++;
      });
      return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.value - a.value; })
        .map(function (r) { return { label: r.label, value: r.value, sub: Hub.plural(r.n, 'account') }; });
    }
    var owned = breakdown('asset'), owed = breakdown('liability');

    view.innerHTML = banner + alertsHTML(F) +
      '<section class="fin-card">' +
        '<div class="fin-hero"><div><span class="fin-label">Net worth' + (who ? ' · ' + esc(who) : '') + '</span>' +
          '<div class="fin-hero-value">' + Fin.amt(live.net) + '</div></div>' +
          '<div class="fin-hero-side">' + deltaHTML(netThen == null ? null : live.net - netThen, true) +
            '<div class="fin-split"><span>Own <b>' + Fin.amt(live.assets) + '</b></span><span>Owe <b>' + Fin.amt(live.debts) + '</b></span></div></div>' +
        '</div>' +
        '<div class="fin-card-head"><h2>The last 12 months</h2>' +
          '<div class="fin-seg" role="group" aria-label="Chart"><button type="button" data-mode="net">Net worth</button><button type="button" data-mode="split">Own &amp; owe</button></div></div>' +
        '<div data-chart="net"></div>' +
        '<p class="fin-note" data-est hidden><span class="fin-dash"></span>Dashed months are estimated from transactions or typed in.</p>' +
      '</section>' +
      '<div class="fin-row fin-row--3 fin-tiles">' +
        tile('cash', 'Cash', groups.cash, 'asset') +
        tile('credit', 'Credit cards', groups.credit, 'liability') +
        tile('invest', 'Investments', groups.invest, 'asset') +
      '</div>' +
      (function () { var a = thisMonthHTML(F), b = comingUpHTML(F); return a || b ? '<div class="fin-row">' + a + b + '</div>' : ''; })() +
      // Cards paired so each row's halves are about the same height: what
      // you own beside what you owe plus credit scores; recent transactions
      // beside goals.
      '<div class="fin-row">' +
        '<section class="fin-card"><div class="fin-card-head"><h2>What you own</h2><span class="fin-muted">' + Fin.amt(live.assets) + '</span></div><div data-hbars="own"></div></section>' +
        '<div class="fin-side-col"><section class="fin-card"><div class="fin-card-head"><h2>What you owe</h2><span class="fin-muted">' + Fin.amt(live.debts) + '</span></div><div data-hbars="owe"></div></section>' + creditHTML(F) + '</div>' +
      '</div>' + (function () {
        var r = recentHTML(F), g = goalsHTML(F);
        return r && g ? '<div class="fin-row">' + r + g + '</div>' : r + g;
      })();
    Hub.$$('[data-alert]', view).forEach(function (b) {
      b.addEventListener('click', function () {
        var go = b.getAttribute('data-alert');
        if (go === 'review') Fin.showReview(); else if (go === 'goals') Fin.openGoals(); else Fin.go(go);
      });
    });
    Hub.$$('[data-alert-score]', view).forEach(function (b) {
      b.addEventListener('click', function () { Fin.go('credit'); if (Fin.addScore) Fin.addScore(F.data.viewer.email); });
    });
    Hub.$$('[data-alert-goal]', view).forEach(function (b) {
      b.addEventListener('click', function () { Fin.openGoals(b.getAttribute('data-alert-goal')); });
    });
    Hub.$$('[data-alert-rc]', view).forEach(function (b) {
      b.addEventListener('click', function () { Fin.openRecurring(b.getAttribute('data-alert-rc')); });
    });
    var catsEl = view.querySelector('[data-hbars="cats"]');
    if (catsEl) {
      var cur = F.data.today.slice(0, 7), byCat = {}, names = {};
      (F.data.categories || []).forEach(function (c) { names[c.id] = c.name; });
      (F.data.monthTx || []).forEach(function (t) {
        var a = F.data.accounts.filter(function (x) { return x.id === t.acct; })[0];
        if (!a || !F.matches(a) || t.amt >= 0 || t.date.slice(0, 7) !== cur) return;
        byCat[t.cat || ''] = (byCat[t.cat || ''] || 0) - t.amt;
      });
      FinCharts.hbars(catsEl, { rows: Object.keys(byCat).map(function (k) { return { label: names[k] || 'Uncategorized', value: byCat[k] }; })
        .sort(function (a, b) { return b.value - a.value; }).slice(0, 5), format: function (v) { return Fin.money(v); }, color: 'var(--fc-1)', ariaLabel: 'This month’s spending by category, largest first' });
    }

    var series = monthlySeries(accts);
    var chartEl = view.querySelector('[data-chart="net"]');
    view.querySelector('[data-est]').hidden = !series.est.some(Boolean);
    function setMode(m) {
      chartMode = m;
      Hub.$$('[data-mode]', view).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === m)); });
      drawNetChart(chartEl, series);
    }
    view.querySelector('.fin-card-head .fin-seg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]');
      if (b) setMode(b.getAttribute('data-mode'));
    });
    setMode(chartMode);

    Hub.$$('[data-spark]', view).forEach(function (el) {
      var key = el.getAttribute('data-spark'), side = key === 'credit' ? 'liability' : 'asset';
      FinCharts.sparkline(el, { values: dailySeries(groups[key], function (t) { return groupValue(t, side); }) });
    });
    var fmt = function (v) { return Fin.money(v); };
    var own = view.querySelector('[data-hbars="own"]'), owe = view.querySelector('[data-hbars="owe"]');
    if (owned.length) FinCharts.hbars(own, { rows: owned, format: fmt, color: 'var(--fc-1)', ariaLabel: 'What you own, by kind' });
    else own.innerHTML = '<p class="fin-muted">Nothing here yet.</p>';
    if (owed.length) FinCharts.hbars(owe, { rows: owed, format: fmt, color: 'var(--fc-1)', ariaLabel: 'What you owe, by kind' });
    else owe.innerHTML = '<p class="fin-muted">No debts. Nice.</p>';
  });
})();
