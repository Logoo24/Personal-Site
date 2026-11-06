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

  function monthlySeries(accts) {
    var now = new Date(), byMonth = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byMonth[e.m] = e; });
    var labels = [], titles = [], net = [], assets = [], debts = [], est = [];
    for (var k = 12; k >= 1; k--) {
      var d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      var e = byMonth[Fin.monthKey(d)], t = e && totals(e, accts);
      labels.push(d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? ' ’' + String(d.getFullYear()).slice(2) : ''));
      titles.push('End of ' + d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
      net.push(t ? t.net : null); assets.push(t ? t.assets : null); debts.push(t ? t.debts : null);
      est.push(!!(e && e.est));
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
      el.innerHTML = '<p class="fin-muted">The graph fills in month by month. Past months can be added from the Accounts tab.</p>';
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
        '<li><strong>Link your banks</strong><span>Checking, savings, credit cards and investments, through Plaid. Joint accounts only need linking once.</span></li>' +
        '<li><strong>Add what Plaid can’t see</strong><span>A car, a home, a loan or cash, with balances you keep up to date.</span></li>' +
        '<li><strong>Fill in past months</strong><span>So the net-worth graph covers the whole last year.</span></li>' +
      '</ol>' +
      '<div class="fin-card" style="margin-top:1.5rem"><div class="fin-card-head"><h2>Setup status</h2></div><ul class="fin-checks">' +
        check(s.encryption, 'Encryption key', 'set <code>FINANCE_ENCRYPTION_KEY</code>') +
        check(s.plaid, 'Plaid keys' + (s.plaid ? ' (' + esc(s.plaidEnv) + ')' : ''), 'set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code>') +
        check(s.claude, 'Claude, for categories and advice', 'set <code>ANTHROPIC_API_KEY</code>') +
        check(s.cron, 'Daily refresh', 'set <code>CRON_SECRET</code>') +
      '</ul><p class="fin-muted" style="margin-top:1rem">Linking banks and adding accounts arrive in the next updates.</p></div>' +
    '</section>';
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

    view.innerHTML = banner +
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
      '<div class="fin-row fin-row--3">' +
        tile('cash', 'Cash', groups.cash, 'asset') +
        tile('credit', 'Credit cards', groups.credit, 'liability') +
        tile('invest', 'Investments', groups.invest, 'asset') +
      '</div>' +
      '<div class="fin-row">' +
        '<section class="fin-card"><div class="fin-card-head"><h2>What you own</h2><span class="fin-muted">' + Fin.amt(live.assets) + '</span></div><div data-hbars="own"></div></section>' +
        '<section class="fin-card"><div class="fin-card-head"><h2>What you owe</h2><span class="fin-muted">' + Fin.amt(live.debts) + '</span></div><div data-hbars="owe"></div></section>' +
      '</div>';

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
