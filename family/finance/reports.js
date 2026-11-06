/* ============================================================
   Finance > Reports. Ten reports drawn from one request
   (?r=fin-reports: up to 24 months summed by month, account,
   category and merchant), plus the summary already on the page
   (balance history, recurring items) and holdings. Every report
   follows the person filter; the period row scopes the ones that
   look back over time.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var REPORTS = [
    ['cashflow', 'Cash flow'], ['spending', 'Spending'], ['trend', 'Category trend'], ['income', 'Income'],
    ['merchants', 'Merchants'], ['networth', 'Net worth'], ['bills', 'Bills & subscriptions'],
    ['debt', 'Debt payoff'], ['investments', 'Investments'], ['review', 'Year in review']
  ];
  var TIMELESS = { bills: 1, debt: 1, investments: 1, review: 1 };
  var PERIODS = [['3', 'Last 3 months'], ['6', 'Last 6 months'], ['12', 'Last 12 months'], ['ytd', 'This year'], ['ly', 'Last year'], ['24', 'Last 24 months']];
  var ui = { report: 'cashflow', period: '12', cat: null, extra: 20000, strategy: 'avalanche', review: null };
  var data = null, loadedAt = 0, loading = null, holdingsP = null;
  var fmt = function (v) { return Fin.money(v); }, axis = function (v) { return Fin.money(v, { compact: true }); };

  function load() {
    if (data && Date.now() - loadedAt < 5 * 60 * 1000) return Promise.resolve(data);
    return loading || (loading = Hub.api('fin-reports', { query: { months: 24 } }).then(function (d) {
      data = d; loadedAt = Date.now(); loading = null; return d;
    }, function (e) { loading = null; throw e; }));
  }
  // Edits elsewhere (Transactions) make the numbers stale.
  var oldInvalidate = Fin.invalidateTx;
  Fin.invalidateTx = function () { data = null; if (oldInvalidate) oldInvalidate(); };

  /* ---------- helpers ---------- */
  function cat(id) { return (Fin.data.categories || []).filter(function (c) { return c.id === id; })[0]; }
  function catName(id) { var c = cat(id); return c ? c.name : 'Uncategorized'; }
  function kind(id) { var c = cat(id); return c ? c.kind : null; }
  function acctOk(id) { var a = Fin.data.accounts.filter(function (x) { return x.id === id; })[0]; return a && Fin.matches(a); }
  function monthLabel(m, long) {
    var d = Fin.monthDate(m);
    return long ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? ' ’' + String(d.getFullYear()).slice(2) : '');
  }
  function periodMonths(p) {
    var all = data ? data.months : allMonthsFromSnapshots(), cur = Fin.data.today.slice(0, 7), y = cur.slice(0, 4);
    p = p || ui.period;
    if (p === 'ytd') return all.filter(function (m) { return m.slice(0, 4) === y; });
    if (p === 'ly') return all.filter(function (m) { return m.slice(0, 4) === String(+y - 1); });
    return all.slice(-Number(p));
  }
  function previousMonths(months) {
    var i = data.months.indexOf(months[0]);
    return i <= 0 ? [] : data.months.slice(Math.max(0, i - months.length), i);
  }
  function rowsIn(months) {
    var set = {};
    months.forEach(function (m) { set[m] = 1; });
    return data.rows.filter(function (r) { return set[r.m] && acctOk(r.a) && kind(r.c) !== 'transfer'; });
  }
  // Income and spending, refunds netted: income categories count in minus
  // out, spending categories out minus in, uncategorized in as income and
  // out as spending. Transfers are already left out.
  function totals(rows) {
    var t = { inc: 0, out: 0 };
    rows.forEach(function (r) {
      var k = kind(r.c);
      if (k === 'income') t.inc += r.i - r.o;
      else if (k === 'expense') t.out += r.o - r.i;
      else { t.inc += r.i; t.out += r.o; }
    });
    return t;
  }
  function spendByCat(rows) {
    var by = {};
    rows.forEach(function (r) {
      var k = kind(r.c);
      if (k === 'income') return;
      var v = k === 'expense' ? r.o - r.i : r.o;
      if (v) by[r.c || ''] = (by[r.c || ''] || 0) + v;
    });
    return by;
  }
  function merchantsIn(months) {
    var set = {}, by = {};
    months.forEach(function (m) { set[m] = 1; });
    data.merchants.forEach(function (x) {
      if (!set[x.m] || !acctOk(x.a)) return;
      var k = x.name;
      var o = by[k] || (by[k] = { name: x.name, c: x.c, o: 0, i: 0, n: 0, last: x.last });
      o.o += x.o; o.i += x.i; o.n += x.n;
      if (x.last > o.last) o.last = x.last;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function sortedEntries(obj) { return Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }); }
  // value is HTML (an amount) or, with isText, a name like "Sunset Apartments" (drawn smaller).
  function tile(label, value, sub, isText) {
    return '<div class="fin-card fin-kpi"><span class="fin-label">' + esc(label) + '</span><div class="fin-kpi-value' + (isText ? ' is-text' : '') + '">' + value + '</div>' + (sub ? '<span class="fin-muted">' + sub + '</span>' : '') + '</div>';
  }
  function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '–'; }
  function change(now, before) {
    if (!before) return '<span class="fin-muted">–</span>';
    var d = (now - before) / before;
    var cls = Math.abs(d) < 0.05 ? 'flat' : d > 0 ? 'bad' : 'good';
    return '<span class="fin-delta ' + cls + '">' + (d > 0 ? '+' : '') + Math.round(d * 100) + '%</span>';
  }
  function card(title, body, extra) {
    return '<section class="fin-card"><div class="fin-card-head"><h2>' + esc(title) + '</h2>' + (extra || '') + '</div>' + body + '</section>';
  }
  function table(head, rows, cls) {
    return '<div class="fin-table-wrap"><table class="fin-table ' + (cls || '') + '"><thead><tr>' + head.map(function (h, i) { return '<th' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (r.attr || '') + '>' + r.cells.map(function (c, i) { return '<td' + (i ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function empty(text) { return '<div class="fin-soon"><h2>Not enough to show yet</h2><p>' + esc(text) + '</p></div>'; }

  /* ---------- 1. cash flow ---------- */
  function cashflow(box) {
    var months = periodMonths();
    var per = months.map(function (m) { return totals(rowsIn([m])); });
    var all = totals(rowsIn(months));
    if (!all.inc && !all.out) { box.innerHTML = empty('Cash flow fills in once there are transactions from linked banks or added by hand.'); return; }
    var n = months.length, net = all.inc - all.out;
    box.innerHTML = '<div class="fin-row fin-row--4">' +
      tile('Average income', Fin.amt(all.inc / n), 'a month') + tile('Average spending', Fin.amt(all.out / n), 'a month') +
      tile('Saved', Fin.amt(net, { sign: true }), 'over ' + Hub.plural(n, 'month')) + tile('Savings rate', pct(net, all.inc), 'of what came in') + '</div>' +
      card('Money in and out', '<div data-c="bars"></div>') +
      card('Where the money went', '<p class="fin-muted fin-flow-note">Everything that came in during this period, and what it went to. Transfers between your own accounts aren’t counted.</p><div data-c="flow"></div>');
    FinCharts.bars($('[data-c="bars"]', box), {
      labels: months.map(function (m) { return monthLabel(m); }), titles: months.map(function (m) { return monthLabel(m, true); }),
      series: [{ name: 'Money in', color: 'var(--fc-1)', values: per.map(function (t) { return t.inc; }) }, { name: 'Money out', color: 'var(--fc-2)', values: per.map(function (t) { return t.out; }) }],
      line: { name: 'Net', color: 'var(--text)', values: per.map(function (t) { return t.inc - t.out; }) },
      format: fmt, axisFormat: axis, height: 280, ariaLabel: 'Money in and money out each month, with the net'
    });
    // Flow: income sources on the left, spending categories (+ saved) on the right.
    var sources = {};
    merchantsIn(months).forEach(function (x) { if (x.i > x.o && kind(x.c) !== 'expense') sources[x.name] = (sources[x.name] || 0) + x.i - x.o; });
    var src = sortedEntries(sources), top = src.slice(0, 4), restIn = src.slice(4).reduce(function (m, e) { return m + e[1]; }, 0);
    var srcTotal = src.reduce(function (m, e) { return m + e[1]; }, 0);
    if (all.inc - srcTotal > 100) restIn += all.inc - srcTotal;
    // Every income source in the same blue as "Money in" above (orange already means money out here).
    var left = top.map(function (e) { return { name: e[0], value: e[1], color: 'var(--fc-1)' }; });
    if (restIn > 0) left.push({ name: 'Other income', value: restIn, color: 'var(--fc-1)' });
    var cats = sortedEntries(spendByCat(rowsIn(months)));
    var right = cats.slice(0, 7).map(function (e) { return { name: catName(e[0] || null), value: e[1] }; });
    var restOut = cats.slice(7).reduce(function (m, e) { return m + e[1]; }, 0);
    if (restOut > 0) right.push({ name: 'Everything else', value: restOut });
    if (net > 0) right.push({ name: 'Saved', value: net, color: 'var(--accent)' });
    if (net < 0) left.push({ name: 'From savings', value: -net, color: 'var(--text-muted)' });
    var inTotal = left.reduce(function (m, x) { return m + x.value; }, 0), outTotal = right.reduce(function (m, x) { return m + x.value; }, 0);
    var links = [];
    left.forEach(function (l, i) { right.forEach(function (r, j) { links.push({ from: i, to: j, value: l.value * r.value / Math.max(inTotal, outTotal) }); }); });
    if (left.length && right.length) FinCharts.flow($('[data-c="flow"]', box), { left: left, right: right, links: links, format: fmt, ariaLabel: 'Where the money that came in went' });
  }

  /* ---------- 2. spending by category ---------- */
  function spending(box) {
    var months = periodMonths(), prev = previousMonths(months);
    var now = spendByCat(rowsIn(months)), before = spendByCat(rowsIn(prev));
    var list = sortedEntries(now);
    if (!list.length) { box.innerHTML = empty('Spending by category fills in once there are transactions.'); return; }
    var total = list.reduce(function (m, e) { return m + e[1]; }, 0);
    box.innerHTML = card('Spending by category', '<div data-c="cats"></div>', '<span class="fin-muted">' + Fin.amt(total) + ' total</span>') +
      card('Compared with the ' + (prev.length === months.length ? 'period before' : 'months before'),
        table(['Category', 'This period', 'Before', 'Change', 'A month'], list.map(function (e) {
          return { attr: ' data-trend="' + esc(e[0]) + '"', cells: ['<button class="fin-link" type="button" data-trend="' + esc(e[0]) + '">' + esc(catName(e[0] || null)) + '</button>', Fin.amt(e[1]), prev.length ? Fin.amt(before[e[0]] || 0) : '–', prev.length ? change(e[1], before[e[0]] || 0) : '–', Fin.amt(e[1] / months.length)] };
        })));
    FinCharts.hbars($('[data-c="cats"]', box), { rows: list.map(function (e) { return { label: catName(e[0] || null), value: e[1], sub: Math.round(e[1] / total * 100) + '%' }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Spending by category, largest first' });
  }

  /* ---------- 3. one category over time ---------- */
  function trend(box) {
    var months = periodMonths();
    var rows = rowsIn(months);
    var totalsBy = spendByCat(rows);
    var choices = sortedEntries(totalsBy);
    if (!choices.length) { box.innerHTML = empty('Category trends fill in once there are transactions.'); return; }
    if (ui.cat === null || !(ui.cat in totalsBy)) ui.cat = choices[0][0];
    var per = months.map(function (m) { return spendByCat(rowsIn([m]))[ui.cat] || 0; });
    var avg3 = per.map(function (v, i) { var s = per.slice(Math.max(0, i - 2), i + 1); return Math.round(s.reduce(function (a, b) { return a + b; }, 0) / s.length); });
    var mean = per.reduce(function (a, b) { return a + b; }, 0) / per.length;
    var maxI = per.indexOf(Math.max.apply(null, per));
    var merch = merchantsIn(months).filter(function (x) { return (x.c || '') === ui.cat && x.o > 0; }).sort(function (a, b) { return b.o - a.o; }).slice(0, 8);
    box.innerHTML = '<div class="fin-report-pick"><label class="field"><span>Category</span><select data-pick-cat>' + choices.map(function (e) {
      return '<option value="' + esc(e[0]) + '"' + (e[0] === ui.cat ? ' selected' : '') + '>' + esc(catName(e[0] || null)) + '</option>';
    }).join('') + '</select></label></div>' +
      '<div class="fin-row fin-row--3">' + tile('A month, on average', Fin.amt(mean)) + tile('Highest month', Fin.amt(per[maxI]), esc(monthLabel(months[maxI], true))) +
        tile('This month so far', Fin.amt(per[per.length - 1]), months[months.length - 1] === Fin.data.today.slice(0, 7) ? 'and counting' : '') + '</div>' +
      card(catName(ui.cat || null) + ' each month', '<div data-c="trend"></div>') +
      (merch.length ? card('Where it went', '<div data-c="merch"></div>') : '');
    FinCharts.bars($('[data-c="trend"]', box), {
      labels: months.map(function (m) { return monthLabel(m); }), titles: months.map(function (m) { return monthLabel(m, true); }),
      series: [{ name: catName(ui.cat || null), color: 'var(--fc-1)', values: per }],
      line: { name: '3-month average', color: 'var(--text)', values: avg3 },
      format: fmt, axisFormat: axis, height: 260, ariaLabel: catName(ui.cat || null) + ' spending each month, with a 3-month average'
    });
    if (merch.length) FinCharts.hbars($('[data-c="merch"]', box), { rows: merch.map(function (x) { return { label: x.name, value: x.o, sub: Hub.plural(x.n, 'visit') }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Biggest merchants in this category' });
  }

  /* ---------- 4. income ---------- */
  function income(box) {
    var months = periodMonths();
    var bySrcMonth = {}, totalsBy = {};
    var set = {};
    months.forEach(function (m) { set[m] = 1; });
    data.merchants.forEach(function (x) {
      if (!set[x.m] || !acctOk(x.a) || !(x.i > x.o) || kind(x.c) === 'expense') return;
      var v = x.i - x.o;
      totalsBy[x.name] = (totalsBy[x.name] || 0) + v;
      (bySrcMonth[x.name] = bySrcMonth[x.name] || {})[x.m] = (bySrcMonth[x.name][x.m] || 0) + v;
    });
    var list = sortedEntries(totalsBy);
    if (!list.length) { box.innerHTML = empty('Income shows up here once deposits come in.'); return; }
    var top = list.slice(0, 4), rest = list.slice(4);
    var series = top.map(function (e, i) { return { name: e[0], color: 'var(--fc-' + (i + 1) + ')', values: months.map(function (m) { return bySrcMonth[e[0]][m] || 0; }) }; });
    if (rest.length) series.push({ name: 'Other', color: 'var(--text-muted)', values: months.map(function (m) { return rest.reduce(function (s, e) { return s + (bySrcMonth[e[0]][m] || 0); }, 0); }) });
    var total = list.reduce(function (m, e) { return m + e[1]; }, 0);
    box.innerHTML = '<div class="fin-row fin-row--3">' + tile('Total', Fin.amt(total), 'over ' + Hub.plural(months.length, 'month')) + tile('A month, on average', Fin.amt(total / months.length)) + tile('Biggest source', esc(list[0][0]), Fin.amt(list[0][1]) + ' · ' + pct(list[0][1], total), true) + '</div>' +
      card('Income each month', '<div data-c="inc"></div>') +
      card('By source', table(['Source', 'Total', 'A month', 'Share'], list.map(function (e) { return { cells: [esc(e[0]), Fin.amt(e[1]), Fin.amt(e[1] / months.length), pct(e[1], total)] }; })));
    FinCharts.stackedBars($('[data-c="inc"]', box), { labels: months.map(function (m) { return monthLabel(m); }), titles: months.map(function (m) { return monthLabel(m, true); }), series: series, format: fmt, axisFormat: axis, height: 260, ariaLabel: 'Income each month by source' });
  }

  /* ---------- 5. merchants ---------- */
  function merchants(box) {
    var months = periodMonths();
    var list = merchantsIn(months).filter(function (x) { return x.o > x.i; }).sort(function (a, b) { return (b.o - b.i) - (a.o - a.i); });
    if (!list.length) { box.innerHTML = empty('Merchants show up here once there are transactions.'); return; }
    box.innerHTML = card('Top 10', '<div data-c="top"></div>') +
      card('Every merchant', table(['Merchant', 'Spent', 'Visits', 'Average', 'Last'], list.slice(0, 40).map(function (x) {
        return { cells: [esc(x.name) + '<span class="fin-acct-sub"> ' + esc(catName(x.c)) + '</span>', Fin.amt(x.o - x.i), String(x.n), Fin.amt((x.o - x.i) / x.n), esc(new Date(x.last + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))] };
      })) + (list.length > 40 ? '<p class="fin-muted">The top 40 of ' + list.length + '.</p>' : ''));
    FinCharts.hbars($('[data-c="top"]', box), { rows: list.slice(0, 10).map(function (x) { return { label: x.name, value: x.o - x.i, sub: Hub.plural(x.n, 'visit') }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Top merchants by spending' });
  }

  /* ---------- 6. net worth by kind ---------- */
  var NW_GROUPS = [['Cash', 1], ['Investments', 2], ['Retirement', 3], ['Property & vehicles', 4], ['Other assets', 5], ['Credit cards', 6], ['Loans', 7], ['Other debts', 8]];
  function networth(box) {
    var accts = Fin.accounts();
    var months = periodMonths();
    var byM = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byM[e.m] = e; });
    var cur = Fin.data.today.slice(0, 7);
    var cols = months.filter(function (m) { return m !== cur; }).filter(function (m) { return byM[m]; });
    var labels = cols.map(function (m) { return monthLabel(m); }).concat('Now');
    var titles = cols.map(function (m) { return 'End of ' + monthLabel(m, true); }).concat('Today');
    function value(a, m) { if (m === 'now') return a.balance || 0; var e = byM[m]; return e && e.b[a.id] != null ? e.b[a.id] : null; }
    var keys = cols.concat('now');
    var series = NW_GROUPS.map(function (g) {
      var mine = accts.filter(function (a) { return (Fin.TYPES[a.type] || {}).group === g[0]; });
      if (!mine.length) return null;
      var owe = Fin.sideOf(mine[0]) === 'liability';
      return { name: g[0], color: 'var(--fc-' + g[1] + ')', values: keys.map(function (k) { var s = 0; mine.forEach(function (a) { var v = value(a, k); if (v) s += v; }); return owe ? -s : s; }) };
    }).filter(Boolean);
    if (!series.length) { box.innerHTML = empty('Add or link accounts to see your net worth by kind.'); return; }
    var net = keys.map(function (k, i) { return series.reduce(function (s, x) { return s + x.values[i]; }, 0); });
    var first = net[0], last = net[net.length - 1];
    box.innerHTML = '<div class="fin-row fin-row--3">' + tile('Net worth now', Fin.amt(last)) + tile('Change', Fin.amt(last - first, { sign: true }), 'since ' + esc(titles[0].replace('End of ', 'the end of '))) +
      tile('Change', first ? (last >= first ? '+' : '') + Math.round((last - first) / Math.abs(first) * 100) + '%' : '–') + '</div>' +
      card('What you own and owe, by kind', '<p class="fin-muted fin-flow-note">Above the line is what you own, below it what you owe. The line is net worth.</p><div data-c="nw"></div>');
    FinCharts.stackedBars($('[data-c="nw"]', box), { labels: labels, titles: titles, series: series, line: { name: 'Net worth', color: 'var(--text)', values: net }, format: fmt, axisFormat: axis, height: 300, ariaLabel: 'Assets and debts by kind each month, with net worth' });
  }

  /* ---------- 7. bills and subscriptions ---------- */
  function bills(box) {
    var list = (Fin.data.recurring || []).filter(function (r) {
      if (r.dir !== 'out' || r.status === 'ignored' || r.ended) return false;
      var a = r.acct && Fin.data.accounts.filter(function (x) { return x.id === r.acct; })[0];
      return !a || Fin.matches(a);
    }).sort(function (a, b) { return b.monthly - a.monthly; });
    if (!list.length) { box.innerHTML = empty('Recurring bills and subscriptions show up here once they’re found (see the Recurring tab).'); return; }
    var month = list.reduce(function (m, r) { return m + r.monthly; }, 0);
    var subs = list.filter(function (r) { return r.kind === 'subscription'; }).reduce(function (m, r) { return m + r.monthly; }, 0);
    var CAD = { weekly: 'Every week', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };
    box.innerHTML = '<div class="fin-row fin-row--3">' + tile('A month', Fin.amt(month)) + tile('A year', Fin.amt(month * 12)) + tile('Subscriptions alone', Fin.amt(subs * 12), 'a year') + '</div>' +
      card('What each costs a year', '<div data-c="yr"></div>') +
      card('All of them', table(['Name', 'How often', 'Amount', 'A month', 'A year'], list.map(function (r) {
        return { cells: [esc(r.name) + (r.kind === 'subscription' ? '<span class="fin-acct-sub"> subscription</span>' : ''), esc(CAD[r.cadence] || r.cadence), (r.variable ? 'about ' : '') + Fin.amt(r.amount, { cents: true }), Fin.amt(r.monthly), Fin.amt(r.monthly * 12)] };
      })));
    FinCharts.hbars($('[data-c="yr"]', box), { rows: list.slice(0, 15).map(function (r) { return { label: r.name, value: r.monthly * 12 }; }), format: fmt, color: 'var(--fc-2)', ariaLabel: 'Yearly cost of each bill and subscription' });
  }

  /* ---------- 8. debt payoff ---------- */
  function debtList() {
    return Fin.accounts().filter(function (a) { return Fin.sideOf(a) === 'liability' && (a.balance || 0) > 0; }).map(function (a) {
      var rate = a.apr != null ? a.apr : null;
      var monthlyInterest = Math.round((a.balance || 0) * (rate || 0) / 1200);
      var min = a.minPayment || (a.type === 'credit' ? Math.max(2500, Math.round(a.balance * 0.01) + monthlyInterest) : Math.max(2500, Math.round(a.balance * 0.015) + monthlyInterest));
      return { id: a.id, name: a.nick || a.name, balance: a.balance, apr: rate || 0, noRate: rate == null, min: min, guessedMin: !a.minPayment };
    });
  }
  // Month by month: interest added, minimums paid on everything, and the
  // extra (plus any minimum freed up by a paid-off debt) aimed at one debt:
  // the highest rate first (avalanche) or the smallest balance (snowball).
  function simulate(debts, extra, order) {
    var ds = debts.map(function (d) { return { id: d.id, name: d.name, bal: d.balance, apr: d.apr, min: d.min, paidOff: null }; });
    var series = [ds.reduce(function (s, d) { return s + d.bal; }, 0)], interest = 0, month = 0;
    var budget = ds.reduce(function (s, d) { return s + d.min; }, 0) + extra;
    while (ds.some(function (d) { return d.bal > 0; }) && month < 600) {
      month++;
      ds.forEach(function (d) { if (d.bal > 0) { var i = Math.round(d.bal * d.apr / 1200); d.bal += i; interest += i; } });
      var left = budget;
      ds.forEach(function (d) { if (d.bal > 0) { var p = Math.min(d.min, d.bal); d.bal -= p; left -= p; } });
      var targets = ds.filter(function (d) { return d.bal > 0; }).sort(order === 'snowball' ? function (a, b) { return a.bal - b.bal; } : function (a, b) { return b.apr - a.apr || a.bal - b.bal; });
      for (var i = 0; i < targets.length && left > 0; i++) { var p = Math.min(left, targets[i].bal); targets[i].bal -= p; left -= p; }
      ds.forEach(function (d) { if (d.bal <= 0 && d.paidOff === null) d.paidOff = month; });
      series.push(ds.reduce(function (s, d) { return s + Math.max(0, d.bal); }, 0));
    }
    return { months: month, interest: interest, series: series, order: ds.slice().sort(function (a, b) { return (a.paidOff || 9999) - (b.paidOff || 9999); }), stuck: month >= 600 };
  }
  function whenFromNow(n) {
    var d = Fin.monthDate(Fin.data.today.slice(0, 7)); d.setMonth(d.getMonth() + n);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function debt(box) {
    var debts = debtList();
    if (!debts.length) { box.innerHTML = empty('No debts with a balance. Nothing to pay off.'); return; }
    var av = simulate(debts, ui.extra, 'avalanche'), sb = simulate(debts, ui.extra, 'snowball'), base = simulate(debts, 0, 'avalanche');
    var pick = ui.strategy === 'snowball' ? sb : av;
    var saved = sb.interest - av.interest;
    var notes = debts.filter(function (d) { return d.noRate || d.guessedMin; }).map(function (d) {
      return esc(d.name) + ': ' + [d.noRate ? 'no interest rate (counted as 0%)' : '', d.guessedMin ? 'minimum payment estimated at ' + Fin.money(d.min) : ''].filter(Boolean).join(', ');
    });
    box.innerHTML =
      '<section class="fin-card"><div class="fin-card-head"><h2>Extra each month</h2><span class="fin-kpi-value fin-amt" data-extra-out>' + esc(Fin.money(ui.extra)) + '</span></div>' +
        '<input type="range" class="fin-range" min="0" max="200000" step="2500" value="' + ui.extra + '" data-extra aria-label="Extra payment each month" />' +
        '<p class="fin-muted">On top of the minimum payments (' + Fin.amt(debts.reduce(function (s, d) { return s + d.min; }, 0)) + ' a month). When a debt is paid off, its minimum goes to the next one.</p></section>' +
      '<div class="fin-row fin-row--3">' +
        tile('Avalanche: highest rate first', av.stuck ? 'Never' : esc(whenFromNow(av.months)), Fin.amt(av.interest) + ' in interest', true) +
        tile('Snowball: smallest balance first', sb.stuck ? 'Never' : esc(whenFromNow(sb.months)), Fin.amt(sb.interest) + ' in interest', true) +
        tile('Minimums only', base.stuck ? 'Never' : esc(whenFromNow(base.months)), Fin.amt(base.interest) + ' in interest', true) + '</div>' +
      '<p class="fin-pace ' + (saved > 100 ? 'good' : '') + '">' + (saved > 100 ? 'Avalanche saves ' + Fin.amt(saved) + ' in interest; snowball gives quicker early wins.' : 'Both orders cost about the same here.') + '</p>' +
      card('What you’d owe, month by month', '<div data-c="debt"></div>') +
      card('Payoff order', '<div class="fin-seg" role="group" aria-label="Strategy" data-strategy><button type="button" data-v="avalanche"' + (ui.strategy !== 'snowball' ? ' class="on"' : '') + '>Avalanche</button><button type="button" data-v="snowball"' + (ui.strategy === 'snowball' ? ' class="on"' : '') + '>Snowball</button></div>' +
        table(['Debt', 'Balance', 'Rate', 'Minimum', 'Paid off'], pick.order.map(function (d) {
          var src = debts.filter(function (x) { return x.id === d.id; })[0];
          return { cells: [esc(d.name), Fin.amt(src.balance), src.noRate ? '–' : src.apr + '%', Fin.amt(src.min) + (src.guessedMin ? '*' : ''), d.paidOff ? esc(whenFromNow(d.paidOff)) : 'Not within 50 years'] };
        }))) +
      (notes.length ? '<p class="fin-muted">* ' + notes.join('. ') + '. Add rates and minimums in Accounts for an exact plan.</p>' : '') +
      '<p class="fin-muted">A projection from today’s balances and rates, assuming no new charges.</p>';
    var len = Math.max(av.series.length, sb.series.length);
    var labels = [], titles = [];
    for (var i = 0; i < len; i++) { var d = Fin.monthDate(Fin.data.today.slice(0, 7)); d.setMonth(d.getMonth() + i); labels.push(d.toLocaleDateString('en-US', { month: 'short' }) + ' ’' + String(d.getFullYear()).slice(2)); titles.push(d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })); }
    var pad = function (s) { return s.concat(Array(Math.max(0, len - s.length)).fill(0)); };
    FinCharts.line($('[data-c="debt"]', box), { labels: labels, titles: titles, zero: true, format: fmt, axisFormat: axis, height: 260,
      series: [{ name: 'Avalanche', color: 'var(--fc-1)', values: pad(av.series) }, { name: 'Snowball', color: 'var(--fc-2)', values: pad(sb.series) }],
      ariaLabel: 'Total owed each month under each payoff order' });
  }

  /* ---------- 9. investments ---------- */
  var TYPE_LABEL = { equity: 'Stocks', etf: 'ETFs', 'mutual fund': 'Mutual funds', 'fixed income': 'Bonds', cash: 'Cash', cryptocurrency: 'Crypto', derivative: 'Options', loan: 'Loans', other: 'Other' };
  function investments(box) {
    var accts = Fin.accounts().filter(function (a) { return a.type === 'investment' || a.type === 'retirement'; });
    if (!accts.length) { box.innerHTML = empty('Add or link an investment or retirement account to see it here.'); return; }
    var total = accts.reduce(function (m, a) { return m + (a.balance || 0); }, 0);
    box.innerHTML = '<div class="fin-row fin-row--3">' + tile('Invested', Fin.amt(total)) + tile('Accounts', String(accts.length)) + '<div class="fin-card fin-kpi" data-gain><span class="fin-label">Gain on holdings</span><div class="fin-kpi-value">–</div></div></div>' +
      card('By account', '<div data-c="accts"></div>') + '<div data-holdings-box></div>';
    FinCharts.hbars($('[data-c="accts"]', box), { rows: accts.slice().sort(function (a, b) { return b.balance - a.balance; }).map(function (a) { return { label: a.nick || a.name, value: a.balance || 0, sub: pct(a.balance || 0, total) }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Investment accounts by balance' });
    var ids = {};
    accts.forEach(function (a) { ids[a.id] = a; });
    (holdingsP || (holdingsP = Hub.api('fin-holdings').catch(function (e) { holdingsP = null; throw e; }))).then(function (h) {
      var mine = h.holdings.filter(function (x) { return ids[x.acct]; });
      var hb = $('[data-holdings-box]', box);
      if (!hb) return;
      if (!mine.length) { hb.innerHTML = '<p class="fin-muted">Holdings show up for investment accounts linked through Plaid.</p>'; return; }
      var byType = {}, value = 0, cost = 0, costKnown = 0;
      mine.forEach(function (x) {
        var s = h.securities[x.security] || {}, t = s.cash ? 'Cash' : TYPE_LABEL[s.type] || 'Other';
        byType[t] = (byType[t] || 0) + (x.value || 0); value += x.value || 0;
        if (x.cost != null) { cost += x.cost; costKnown += x.value || 0; }
      });
      var gain = costKnown - cost;
      var g = $('[data-gain]', box);
      if (g && cost) g.innerHTML = '<span class="fin-label">Gain on holdings</span><div class="fin-kpi-value">' + Fin.amt(gain, { sign: true }) + '</div><span class="fin-muted">' + (gain >= 0 ? '+' : '') + Math.round(gain / cost * 100) + '% on what you paid</span>';
      hb.innerHTML = card('What it’s in', '<div data-c="alloc"></div>') +
        card('Holdings', table(['Holding', 'Value', 'Cost', 'Gain', 'Share'], mine.slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); }).map(function (x) {
          var s = h.securities[x.security] || {}, gn = x.cost != null && x.value != null ? x.value - x.cost : null;
          return { cells: [esc(s.ticker || s.name || 'Holding') + '<span class="fin-acct-sub"> ' + esc((ids[x.acct].nick || ids[x.acct].name)) + '</span>', Fin.amt(x.value), x.cost != null ? Fin.amt(x.cost) : '–', gn != null ? Fin.amt(gn, { sign: true }) : '–', pct(x.value || 0, value)] };
        })));
      FinCharts.hbars($('[data-c="alloc"]', hb), { rows: sortedEntries(byType).map(function (e) { return { label: e[0], value: e[1], sub: pct(e[1], value) }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Holdings by kind of investment' });
    }).catch(function () { var hb = $('[data-holdings-box]', box); if (hb) hb.innerHTML = '<p class="fin-muted">Couldn’t load holdings.</p>'; });
  }

  /* ---------- 10. year (or month) in review ---------- */
  function review(box) {
    // Only months (and years) that have transactions to look back on.
    var has = {};
    data.rows.forEach(function (r) { if (acctOk(r.a)) has[r.m] = 1; });
    var withData = data.months.filter(function (m) { return has[m]; });
    if (!withData.length) { box.innerHTML = empty('Nothing to look back on yet.'); return; }
    var years = [], seen = {};
    withData.slice().reverse().forEach(function (m) { var y = m.slice(0, 4); if (!seen[y]) { seen[y] = 1; years.push(y); } });
    var options = years.map(function (y) { return ['y' + y, y === Fin.data.today.slice(0, 4) ? y + ' so far' : y]; })
      .concat(withData.slice().reverse().map(function (m) { return ['m' + m, monthLabel(m, true)]; }));
    if (!ui.review || !options.some(function (o) { return o[0] === ui.review; })) ui.review = options[0][0];
    var months = ui.review[0] === 'y' ? data.months.filter(function (m) { return m.slice(0, 4) === ui.review.slice(1); }) : [ui.review.slice(1)];
    var label = options.filter(function (o) { return o[0] === ui.review; })[0][1];
    var rows = rowsIn(months), t = totals(rows), net = t.inc - t.out;
    var cats = sortedEntries(spendByCat(rows));
    var merch = merchantsIn(months).filter(function (x) { return x.o > x.i; }).sort(function (a, b) { return (b.o - b.i) - (a.o - a.i); });
    var set = {}; months.forEach(function (m) { set[m] = 1; });
    var big = data.big.filter(function (b) { return set[b.m] && acctOk(b.a) && kind(b.c) !== 'transfer'; }).sort(function (a, b) { return b.amt - a.amt; })[0];
    var count = rows.reduce(function (m, r) { return m + r.n; }, 0);
    var subs = rows.filter(function (r) { return r.c === 'subscriptions'; }).reduce(function (m, r) { return m + r.o - r.i; }, 0);
    // Net worth across the period, from the month-end snapshots.
    var accts = Fin.accounts(), byM = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byM[e.m] = e; });
    function nwAt(m) { var e = byM[m]; if (!e) return null; var s = 0, any = false; accts.forEach(function (a) { var v = e.b[a.id]; if (v != null) { any = true; s += Fin.sideOf(a) === 'liability' ? -v : v; } }); return any ? s : null; }
    var before = months[0] ? (function () { var d = Fin.monthDate(months[0]); d.setMonth(d.getMonth() - 1); return nwAt(Fin.monthKey(d)); })() : null;
    var lastM = months[months.length - 1], cur = Fin.data.today.slice(0, 7);
    var after = lastM === cur ? accts.reduce(function (s, a) { return s + (Fin.sideOf(a) === 'liability' ? -(a.balance || 0) : (a.balance || 0)); }, 0) : nwAt(lastM);
    if (!count) { box.innerHTML = '<div class="fin-report-pick"><label class="field"><span>Look back at</span><select data-pick-review>' + options.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === ui.review ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label></div>' + empty('No transactions in that stretch.'); return; }
    box.innerHTML = '<div class="fin-report-pick"><label class="field"><span>Look back at</span><select data-pick-review>' + options.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === ui.review ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label></div>' +
      '<section class="fin-card fin-review"><h2>' + esc(label) + '</h2><p class="fin-review-lede">You brought in <b class="fin-amt">' + esc(Fin.money(t.inc)) + '</b> and spent <b class="fin-amt">' + esc(Fin.money(t.out)) + '</b>, ' +
        (net >= 0 ? 'keeping <b class="fin-amt">' + esc(Fin.money(net)) + '</b> (' + pct(net, t.inc) + ' of it).' : 'spending <b class="fin-amt">' + esc(Fin.money(-net)) + '</b> more than came in.') +
        (before != null && after != null ? ' Net worth went ' + (after >= before ? 'up' : 'down') + ' <b class="fin-amt">' + esc(Fin.money(Math.abs(after - before))) + '</b>.' : '') + '</p></section>' +
      '<div class="fin-row fin-row--3">' +
        tile('Biggest category', cats[0] ? esc(catName(cats[0][0] || null)) : '–', cats[0] ? Fin.amt(cats[0][1]) + ' · ' + pct(cats[0][1], t.out) + ' of spending' : '', true) +
        tile('Top merchant', merch[0] ? esc(merch[0].name) : '–', merch[0] ? Fin.amt(merch[0].o - merch[0].i) + ' · ' + Hub.plural(merch[0].n, 'visit') : '', true) +
        tile('Biggest purchase', big ? Fin.amt(big.amt) : '–', big ? esc(big.name + ', ' + new Date(big.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '') +
        tile('Transactions', String(count)) +
        tile('Subscriptions', Fin.amt(subs)) +
        tile('Savings rate', pct(net, t.inc), net >= 0 ? 'of what came in' : '') + '</div>' +
      (cats.length ? card('Spending by category', '<div data-c="rcats"></div>') : '');
    if (cats.length) FinCharts.hbars($('[data-c="rcats"]', box), { rows: cats.slice(0, 10).map(function (e) { return { label: catName(e[0] || null), value: e[1] }; }), format: fmt, color: 'var(--fc-1)', ariaLabel: 'Spending by category' });
  }

  var DRAW = { cashflow: cashflow, spending: spending, trend: trend, income: income, merchants: merchants, networth: networth, bills: bills, debt: debt, investments: investments, review: review };

  /* ---------- tab ---------- */
  function render(view) {
    view.innerHTML = '<div class="fin-report-bar">' +
        '<div class="fin-report-chips" role="tablist" aria-label="Reports">' + REPORTS.map(function (r) {
          return '<button type="button" class="chip' + (r[0] === ui.report ? ' on' : '') + '" data-report="' + r[0] + '" aria-pressed="' + (r[0] === ui.report) + '">' + esc(r[1]) + '</button>';
        }).join('') + '</div>' +
        (TIMELESS[ui.report] ? '' : '<select class="fin-period" data-period aria-label="Period">' + PERIODS.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === ui.period ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>') +
      '</div><div class="fin-report" data-report-box><p class="hub-loading">Adding things up…</p></div>';
    var box = $('[data-report-box]', view);
    var needsData = !{ networth: 1, bills: 1, debt: 1, investments: 1 }[ui.report];
    (needsData ? load() : Promise.resolve(data)).then(function () {
      if (needsData && !data) return;
      DRAW[ui.report](box);
    }).catch(function (e) { box.innerHTML = '<p class="fin-muted">Couldn’t load the numbers: ' + esc(e.message) + '</p>'; });
  }
  function allMonthsFromSnapshots() {
    var cur = Fin.data.today.slice(0, 7), out = [];
    for (var k = 23; k >= 0; k--) { var d = Fin.monthDate(cur); d.setMonth(d.getMonth() - k); out.push(Fin.monthKey(d)); }
    return out;
  }

  Fin.tab('reports', render);
  document.addEventListener('click', function (e) {
    if (location.hash.replace('#', '') !== 'reports') return;
    var t = e.target.closest('[data-report],[data-trend],[data-strategy] [data-v]');
    if (!t || !$('#view').contains(t)) return;
    if (t.hasAttribute('data-report')) { ui.report = t.getAttribute('data-report'); return Fin.rerender(); }
    if (t.hasAttribute('data-trend')) { ui.report = 'trend'; ui.cat = t.getAttribute('data-trend'); return Fin.rerender(); }
    if (t.hasAttribute('data-v')) { ui.strategy = t.getAttribute('data-v'); return Fin.rerender(); }
  });
  document.addEventListener('change', function (e) {
    if (location.hash.replace('#', '') !== 'reports') return;
    if (e.target.matches('[data-period]')) { ui.period = e.target.value; return Fin.rerender(); }
    if (e.target.matches('[data-pick-cat]')) { ui.cat = e.target.value; return Fin.rerender(); }
    if (e.target.matches('[data-pick-review]')) { ui.review = e.target.value; return Fin.rerender(); }
    if (e.target.matches('[data-extra]')) { ui.extra = +e.target.value; return Fin.rerender(); }
  });
  document.addEventListener('input', function (e) {
    if (location.hash.replace('#', '') !== 'reports' || !e.target.matches('[data-extra]')) return;
    var out = $('[data-extra-out]');
    if (out) out.textContent = Fin.money(+e.target.value);
  });
})();
