/* ============================================================
   Finance > Recurring: subscriptions, bills and regular income
   (api/_family/finance/recurring.js finds them; the family can add
   their own or track any merchant from a transaction).
   - Subscriptions: the same price on the same day. A price change
     shows as an alert until someone taps "Got it".
   - Bills: fixed ones (insurance, a loan) and ones that change each
     month (rent, power, gas), shown as "usually about" with how much
     of this month's is paid so far.
   - Regular income.
   Plus what's coming up (card and loan due dates too). Found items
   can be confirmed or dismissed; any can be renamed or corrected.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var CADENCES = [['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Every month'], ['bimonthly', 'Every 2 months'], ['quarterly', 'Every 3 months'], ['yearly', 'Every year']];
  var KIND = { subscription: 'Subscription', bill: 'Bill', paycheck: 'Paycheck', income: 'Income', due: 'Payment due' };
  var scanned = false;
  var reviewing = false;   // asking "Is this regular?" one item at a time
  var showMonth = false;   // "Coming up" for 30 days instead of 7

  function cadenceLabel(c) { var x = CADENCES.filter(function (k) { return k[0] === c; })[0]; return x ? x[1] : c; }
  function acctOf(id) { return Fin.data.accounts.filter(function (a) { return a.id === id; })[0]; }
  function day(d, opts) { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' }); }
  function relDay(d) {
    var t = Fin.data.today;
    if (d === t) return 'Today';
    var diff = Math.round((new Date(d + 'T12:00:00') - new Date(t + 'T12:00:00')) / 864e5);
    return diff === 1 ? 'Tomorrow' : day(d);
  }
  function nth(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function list(xs) { return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  function monthName(m) { return new Date(m + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long' }); }
  function money(c) { return Fin.amt(c, { cents: c < 10000 }); }
  // The person filter: an item follows its account's owner, or "whose" for a paycheck.
  function shown(r) {
    if (Fin.person === 'all') return true;
    if (r.person) return r.person === Fin.person;
    var a = r.acct && acctOf(r.acct);
    return a ? Fin.matches(a) : true;
  }
  function active(r) { return r.status !== 'ignored' && !r.ended; }

  // When it comes, in words: "Every month on the 8th", "Changes each month,
  // in 2 payments around the 3rd and 15th", "Every 2 weeks · next Fri, Nov 14".
  function when(r, long) {
    if (r.pattern === 'month') {
      var days = (r.days || []).map(nth);
      if (r.parts > 1) return 'Usually ' + (r.parts > 3 ? 'several' : r.parts) + ' payments' + (days.length ? ', around the ' + list(days) : ' a month');
      return days.length ? 'Usually around the ' + days[0] : 'Changes each month';
    }
    var c = r.cadence, d = r.days || [];
    if (c === 'monthly' && d.length && !r.ended) return 'Every month on the ' + nth(d[0]);
    if (c === 'semimonthly' && d.length === 2) return 'Twice a month, the ' + list(d.slice().sort(function (a, b) { return a - b; }).map(nth));
    return cadenceLabel(c) + (r.ended || !r.nextDate ? '' : ' · next ' + (long ? day(r.nextDate, { weekday: 'long', month: 'long', day: 'numeric' }) : relDay(r.nextDate)));
  }

  function priceText(r) {
    var p = r.priceChange, up = p.to > p.from, yr = Math.abs(p.to - p.from) * 12 * ({ weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, bimonthly: 0.5, quarterly: 1 / 3, yearly: 1 / 12 }[r.cadence] || 1);
    return esc(r.name) + ' went ' + (up ? 'up' : 'down') + ' from ' + Fin.amt(p.from, { cents: true }) + ' to ' + Fin.amt(p.to, { cents: true }) +
      ' on ' + esc(day(p.date, { month: 'short', day: 'numeric' })) + '. That’s ' + Fin.amt(Math.round(yr)) + (up ? ' more' : ' less') + ' a year.';
  }

  // A changing bill's month so far: a meter, and what's paid against usual.
  // Nothing paid and not due yet: no line (the usual day is already shown).
  function monthProgress(r, always) {
    if (r.pattern !== 'month' || r.ended || !r.amount) return '';
    var paid = r.thisMonth || 0, m = monthName(Fin.data.today.slice(0, 7));
    var done = paid >= r.amount * 0.9 || (r.parts && (r.thisMonthCount || 0) >= r.parts);
    var late = !paid && r.nextDate && r.nextDate < Fin.data.today;
    if (!paid && !late && !always) return '';
    var text = done ? Hub.icons.check + 'Paid for ' + m + ': ' + Fin.amt(paid, { cents: paid < 10000 })
      : paid ? Fin.amt(paid, { cents: paid < 10000 }) + ' of about ' + money(r.amount) + ' paid for ' + m
      : late ? 'Not paid yet for ' + m + ', usually by the ' + nth(+r.nextDate.slice(8, 10))
      : 'Nothing yet for ' + m + (r.nextDate ? ', expected ' + esc(relDay(r.nextDate)) : '');
    return '<span class="fin-rc-progress' + (done ? ' is-done' : late ? ' is-late' : '') + '">' +
      (paid && !done ? '<span class="fin-meter"><span class="fin-meter-fill" style="width:' + Math.min(100, Math.round(paid / r.amount * 100)) + '%"></span></span>' : '') +
      '<span>' + text + '</span></span>';
  }

  function amountHTML(r) {
    var v = Fin.amt(r.dir === 'in' ? r.amount : -r.amount, { cents: r.amount < 100000, sign: r.dir === 'in' });
    return (r.variable ? '<small>about </small>' : '') + v;
  }

  function row(r) {
    var a = r.acct && acctOf(r.acct);
    var tags = (r.status === 'detected' ? '<span class="fin-tag fin-tag--review">Found</span>' : '') +
      (r.status === 'manual' ? '<span class="fin-tag">Added by hand</span>' : '') +
      (r.priceAlert ? '<span class="fin-tag fin-tag--' + (r.priceChange.to > r.priceChange.from ? 'up' : 'down') + '">' + (r.priceChange.to > r.priceChange.from ? Hub.icons.up + 'Went up' : 'Went down') + '</span>' : '') +
      (r.ended ? '<span class="fin-tag">Stopped?</span>' : '');
    var sub = [r.ended ? 'last seen ' + day(r.lastDate) : when(r), a ? (a.nick || a.name) : '', r.person ? Fin.ownerName(r.person) : ''].filter(Boolean).join(' · ');
    var right = r.pattern === 'month' ? (r.low && r.high && r.high - r.low >= 500 ? '<span class="fin-acct-sub fin-rc-range">' + money(r.low) + '–' + money(r.high) + '</span>' : '<span class="fin-acct-sub">a month</span>')
      : r.cadence !== 'monthly' ? '<span class="fin-acct-sub">' + Fin.amt(r.monthly) + ' a month</span>' : '';
    return '<li class="fin-rc-li"><button class="fin-acct" type="button" data-rc="' + esc(r.id) + '">' +
      (r.cat ? Fin.catIcon(r.cat) : '<span class="fin-acct-icon" aria-hidden="true">' + esc(String(r.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?') + '</span>') +
      '<span class="fin-acct-main"><span class="fin-acct-name">' + esc(r.name) + tags + '</span><span class="fin-acct-sub">' + esc(sub) + '</span></span>' +
      '<span class="fin-acct-right"><span class="fin-acct-bal' + (r.dir === 'in' ? ' fin-tx-amt is-in' : '') + '">' + amountHTML(r) + '</span>' + right + '</span>' +
      monthProgress(r) +
    '</button>' +
    (r.status === 'detected' && reviewing ? '<div class="fin-rc-ask"><span class="fin-muted">Is this a regular ' + (r.dir === 'in' ? 'deposit' : 'charge') + '?</span><button class="btn btn-ghost btn-sm" type="button" data-rc-yes="' + esc(r.id) + '">' + Hub.icons.check + 'Yes</button><button class="btn btn-ghost btn-sm" type="button" data-rc-no="' + esc(r.id) + '">No</button></div>' : '') +
    '</li>';
  }

  // What the scan found and nobody has confirmed yet: confirm the lot in one
  // tap, or go through them one by one (each row then asks "Is this regular?").
  function foundCard(live) {
    var found = live.filter(function (r) { return r.status === 'detected'; });
    if (!found.length) { reviewing = false; return ''; }
    var what = found.filter(function (r) { return r.dir === 'in'; }).length ? 'regular charges and deposits' : 'regular charges';
    return '<section class="fin-card fin-found"><div class="fin-found-text">' + Hub.icons.sparkle +
      '<span><b>Found ' + Hub.plural(found.length, 'item') + '</b> that look like ' + what + '. ' +
      (reviewing ? 'Confirm or dismiss each one below.' : 'Confirm them all, or go through them one by one.') + '</span></div>' +
      '<div class="hub-actions"><button class="btn btn-primary btn-sm" type="button" data-rc-all>' + Hub.icons.check + 'Confirm all</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-rc-review>' + (reviewing ? 'Done reviewing' : 'Review one by one') + '</button></div></section>';
  }

  function section(title, note, items, total, about) {
    if (!items.length) return '';
    return '<section class="fin-card"><div class="fin-card-head"><div><h2>' + esc(title) + '</h2>' + (note ? '<p class="fin-muted fin-rc-note">' + esc(note) + '</p>' : '') + '</div>' +
      (total != null ? '<span class="fin-muted">' + (about ? 'about ' : '') + Fin.amt(total) + ' a month</span>' : '') + '</div>' +
      '<ul class="fin-accts">' + items.map(row).join('') + '</ul></section>';
  }

  function upcomingHTML(items, days) {
    var end = new Date(Fin.data.today + 'T12:00:00'); end.setDate(end.getDate() + days);
    var endKey = Fin.dayKey(end);
    var list = (Fin.data.upcoming || []).filter(function (u) {
      if (u.date > endKey) return false;
      if (u.kind === 'due') { var a = acctOf(u.acct); return !a || Fin.matches(a); }
      var r = items.filter(function (x) { return x.id === u.id; })[0];
      return r ? shown(r) : true;
    });
    if (!list.length) return '<p class="fin-muted">Nothing expected in the next ' + days + ' days.</p>';
    var by = {};
    list.forEach(function (u) { (by[u.date] = by[u.date] || []).push(u); });
    return '<div class="fin-upcoming">' + Object.keys(by).sort().map(function (d) {
      return '<div class="fin-up-day"><span class="fin-up-date">' + esc(relDay(d)) + '</span><ul>' + by[d].map(function (u) {
        return '<li><span class="fin-acct-main"><span class="fin-acct-name">' + esc(u.name) + (u.late ? '<span class="fin-tag">Expected ' + esc(day(u.expected, { month: 'short', day: 'numeric' })) + '</span>' : '') + '</span>' +
          '<span class="fin-acct-sub">' + esc(KIND[u.kind] || '') + (u.kind === 'due' && u.min ? ' · minimum ' + Fin.amt(u.min) : '') + '</span></span>' +
          '<span class="fin-tx-amt' + (u.dir === 'in' ? ' is-in' : '') + '">' + (u.amount != null ? (u.variable ? '<small>about </small>' : '') + Fin.amt(u.dir === 'in' ? u.amount : -u.amount, { cents: true, sign: u.dir === 'in' }) : '') + '</span></li>';
      }).join('') + '</ul></div>';
    }).join('') + '</div>';
  }
  Fin.upcomingHTML = upcomingHTML;

  function render(view) {
    var items = (Fin.data.recurring || []).filter(shown);
    var live = items.filter(active);
    var subs = live.filter(function (r) { return r.dir === 'out' && r.kind === 'subscription'; });
    var bills = live.filter(function (r) { return r.dir === 'out' && r.kind !== 'subscription'; });
    var income = live.filter(function (r) { return r.dir === 'in'; });
    var sum = function (l) { return l.reduce(function (m, r) { return m + (r.monthly || 0); }, 0); };
    var stopped = items.filter(function (r) { return r.ended && r.status !== 'ignored'; });
    var ignored = items.filter(function (r) { return r.status === 'ignored'; });
    var alerts = live.filter(function (r) { return r.priceAlert; });
    // Fixed bills first (by date), then the ones that change, biggest first.
    bills.sort(function (a, b) { return (a.pattern === 'month') - (b.pattern === 'month') || (a.pattern === 'month' ? b.amount - a.amount : (a.nextDate || '') < (b.nextDate || '') ? -1 : 1); });
    var byDate = function (a, b) { return (a.nextDate || '9') < (b.nextDate || '9') ? -1 : 1; };
    subs.sort(byDate); income.sort(byDate);

    view.innerHTML =
      '<div class="fin-acct-head"><div class="fin-split">' +
        (subs.length ? '<span>Subscriptions <b>' + Fin.amt(sum(subs)) + '</b> a month</span>' : '') +
        (bills.length ? '<span>Bills <b>' + (bills.some(function (r) { return r.variable; }) ? 'about ' : '') + Fin.amt(sum(bills)) + '</b> a month</span>' : '') +
        (income.length ? '<span>Regular income <b>' + Fin.amt(sum(income)) + '</b> a month</span>' : '') + '</div>' +
        '<div class="hub-actions">' + (Fin.data.recent && Fin.data.recent.length ? '<button class="btn btn-ghost btn-sm" type="button" data-rc-scan>' + Hub.icons.refresh + 'Look again</button>' : '') +
        '<button class="btn btn-primary btn-sm" type="button" data-rc-add>' + Hub.icons.plus + 'Add a bill or income</button></div></div>' +
      (alerts.length ? '<div class="fin-alerts">' + alerts.map(function (r) {
        var up = r.priceChange.to > r.priceChange.from;
        return '<div class="fin-alert fin-alert--split' + (up ? ' fin-alert--up' : '') + '"><button class="fin-alert-main" type="button" data-rc="' + esc(r.id) + '">' + (up ? Hub.icons.up : Hub.icons.check) + '<span>' + priceText(r) + '</span></button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-rc-seen="' + esc(r.id) + '">Got it</button></div>';
      }).join('') + '</div>' : '') +
      foundCard(live) +
      '<section class="fin-card"><div class="fin-card-head"><h2>Coming up</h2><span class="fin-muted">The next ' + (showMonth ? 30 : 7) + ' days</span></div>' + upcomingHTML(items, showMonth ? 30 : 7) +
        '<button class="fin-link" type="button" data-rc-days>' + (showMonth ? 'Just the next 7 days' : 'Show the next 30 days') + '</button></section>' +
      (items.length ? '' : '<div class="fin-soon"><h2>Nothing found yet</h2><p>Subscriptions show up here after two or three charges at the same price. Bills that change, like power or rent, after about three months. You can add anything by hand, or tap a transaction and choose “Track as recurring”.</p></div>') +
      section('Subscriptions', 'The same price on the same day. A price change shows at the top.', subs, sum(subs)) +
      section('Bills', 'Fixed ones, and ones that change from month to month.', bills, sum(bills), bills.some(function (r) { return r.variable; })) +
      section('Income', '', income, sum(income)) +
      (items.length ? '<p class="fin-muted fin-rc-tip">Something missing? Tap one of its transactions and choose “Track as recurring”.</p>' : '') +
      (stopped.length ? '<details class="fin-card fin-hidden-accts"><summary>' + stopped.length + (stopped.length === 1 ? ' seems' : ' seem') + ' to have stopped</summary><ul class="fin-accts">' + stopped.map(row).join('') + '</ul></details>' : '') +
      (ignored.length ? '<details class="fin-card fin-hidden-accts"><summary>' + ignored.length + ' marked not recurring</summary><ul class="fin-accts">' + ignored.map(row).join('') + '</ul></details>' : '');

    Fin.ensureRecurring();
  }

  // A fresh look at the transactions once a day (the daily job also does
  // this). Budgets use it too: recurring bills mark their fixed categories.
  Fin.ensureRecurring = function () {
    var stale = !Fin.data.recurringAt || Date.now() - new Date(Fin.data.recurringAt) > 24 * 3600 * 1000;
    if (stale && !scanned && Fin.data.accounts.length) { scanned = true; scan(); }
  };

  function scan(btn) {
    if (btn) btn.disabled = true;
    return Fin.save('fin-recurring', { body: { action: 'scan' } }).then(function () { if (btn) Hub.toast('Up to date'); })
      .catch(function (e) { Hub.toast(e.message, true); if (btn) btn.disabled = false; });
  }
  function act(id, action, extra) {
    return Fin.save('fin-recurring', { body: Object.assign({ id: id, action: action }, extra || {}) });
  }

  /* ---------- one item ---------- */
  var openRc = null;
  function find(id) { return (Fin.data.recurring || []).filter(function (r) { return r.id === id; })[0]; }
  // The last months of a changing bill, as small bars.
  function historyHTML(r) {
    var h = (r.history || []).slice(0, -1).filter(function (x, i, all) { return x.total || all.slice(0, i).some(function (y) { return y.total; }); });
    if (!h.length) return '';
    var max = Math.max.apply(null, h.map(function (x) { return x.total; }).concat(r.amount || 0)) || 1;
    return '<div class="fin-rc-hist"><span class="fin-label">The last ' + Hub.plural(h.length, 'month') + '</span><ul>' + h.map(function (x) {
      return '<li><span>' + esc(new Date(x.m + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short' })) + '</span><span class="fin-rc-bar"><span style="width:' + Math.round(x.total / max * 100) + '%"></span></span><span class="fin-amt-cell">' + (x.total ? Fin.amt(x.total, { cents: x.total < 10000 }) : '<span class="fin-muted">none</span>') + '</span></li>';
    }).join('') + '</ul></div>';
  }
  function openItem(id) {
    var r = find(id);
    if (!r) { openRc = null; Fin.closeDrawer(); return; }
    openRc = id;
    var manual = r.status === 'manual', month = r.pattern === 'month';
    var people = [['', 'Not set']].concat((Fin.data.people || []).map(function (p) { return [p.email, p.name]; }));
    var a = r.acct && acctOf(r.acct);
    var prices = (r.prices || []).length > 1 ? r.prices.slice().reverse() : [];
    var body = Fin.openDrawer(r.name,
      '<div><span class="fin-label">' + esc(KIND[r.kind] || '') + (month ? ' · changes each month' : r.variable ? '' : ' · same price each time') + '</span>' +
        '<div class="fin-kpi-value">' + amountHTML(r) + (month ? '<small class="fin-muted"> a month</small>' : '') + '</div>' +
        '<span class="fin-muted">' + esc(when(r, true)) + (month && r.low && r.high && r.high - r.low >= 500 ? ' · ' + money(r.low) + '–' + money(r.high) + ' most months' : '') +
          (!month && r.cadence !== 'monthly' ? ' · ' + Fin.amt(r.monthly) + ' a month' : '') + ' · ' + Fin.amt(r.monthly * 12) + ' a year</span></div>' +
      (r.priceAlert ? '<div class="fin-rc-price"><span>' + priceText(r) + '</span><button class="btn btn-ghost btn-sm" type="button" data-rc-seen>Got it</button></div>' : '') +
      (month ? (monthProgress(r, true) ? '<div class="fin-rc-now">' + monthProgress(r, true) + '</div>' : '') + historyHTML(r) : '') +
      '<form class="fin-tx-form" data-rcform>' +
        '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" value="' + esc(r.name) + '" /></label>' +
        '<div class="cf-row"><label class="field"><span>' + (month ? 'Usually about (a month)' : r.variable ? 'Usually about' : 'Price') + '</span><input class="input" name="amount" inputmode="decimal" value="' + esc(Fin.moneyInput(r.amount)) + '" /></label>' +
        (month ? '' : '<label class="field"><span>How often</span><select name="cadence">' + CADENCES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === r.cadence ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select></label>') + '</div>' +
        (manual ? '<label class="field"><span>Next date</span><input class="input" type="date" name="nextDate" value="' + esc(r.nextDate || Fin.data.today) + '" /></label>' : '') +
        (r.dir === 'in' ? '<label class="field"><span>Whose</span><select name="person">' + people.map(function (p) { return '<option value="' + esc(p[0]) + '"' + ((r.person || '') === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') + '</select></label>' : '') +
        '<label class="field"><span>Note</span><input class="input" name="note" maxlength="300" value="' + esc(r.note || '') + '" placeholder="Optional" /></label>' +
        '<div class="fin-drawer-actions"><button class="btn btn-primary btn-sm" type="submit">Save</button>' +
          (r.status === 'ignored' ? '<button class="btn btn-ghost btn-sm" type="button" data-rc-restore>Put it back</button>'
            : manual ? '<button class="btn btn-danger btn-sm" type="button" data-rc-del>' + Hub.icons.trash + 'Delete</button>'
            : '<button class="btn btn-ghost btn-sm" type="button" data-rc-ignore>Not recurring</button>') + '</div>' +
      '</form>' +
      '<dl class="fin-facts">' +
        (r.nextDate && !r.ended && !month ? '<div><dt>Next</dt><dd>' + esc(day(r.nextDate, { weekday: 'long', month: 'long', day: 'numeric' })) + '</dd></div>' : '') +
        (r.lastDate ? '<div><dt>Last paid</dt><dd>' + esc(day(r.lastDate, { month: 'long', day: 'numeric', year: 'numeric' })) + (r.last ? ', ' + Fin.amt(r.last, { cents: true }) : '') + '</dd></div>' : '') +
        prices.map(function (p, i) { return '<div><dt>' + (i ? 'Before that' : 'Price now') + '</dt><dd>' + Fin.amt(p.amount, { cents: true }) + ', since ' + esc(day(p.since, { month: 'long', year: 'numeric' })) + '</dd></div>'; }).join('') +
        (r.count && !month ? '<div><dt>Seen</dt><dd>' + esc(Hub.plural(r.count, 'time')) + ' in the last 14 months</dd></div>' : '') +
        (r.count && month ? '<div><dt>Seen</dt><dd>' + esc(Hub.plural(r.count, 'month')) + ' of the last ' + Math.max(r.count, Math.min(6, (r.history || []).length - 1)) + '</dd></div>' : '') +
        (a ? '<div><dt>Account</dt><dd>' + esc((a.nick || a.name) + (a.mask ? ' ••' + a.mask : '')) + '</dd></div>' : '') +
        (month ? '<div><dt>Amount</dt><dd>The average of the last three months. Change it above if you know the usual amount.</dd></div>' : r.variable ? '<div><dt>Amount</dt><dd>Changes from time to time, so this is the average of the last three</dd></div>' : '') +
      '</dl>');
    var form = $('[data-rcform]', body), el = form.elements;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var amount = Fin.parseMoney(el.amount.value);
      if (!amount || isNaN(amount)) { Hub.toast('Enter the amount, like 15.49.', true); return; }
      var edit = { name: el.name.value, amount: amount, note: el.note.value };
      if (el.cadence) edit.cadence = el.cadence.value;
      if (el.nextDate) edit.nextDate = el.nextDate.value;
      if (el.person) edit.person = el.person.value;
      act(r.id, 'edit', edit).then(function () { Hub.toast('Saved'); }).catch(function (err) { Hub.toast(err.message, true); });
    });
    var seen = $('[data-rc-seen]', body);
    if (seen) seen.addEventListener('click', function () { act(r.id, 'price-ok').then(function () { Hub.toast('Got it'); }).catch(function (e) { Hub.toast(e.message, true); }); });
    var ig = $('[data-rc-ignore]', body);
    if (ig) ig.addEventListener('click', function () { act(r.id, 'ignore').then(function () { Fin.closeDrawer(); Hub.toast('Marked not recurring'); }).catch(function (e) { Hub.toast(e.message, true); }); });
    var re = $('[data-rc-restore]', body);
    if (re) re.addEventListener('click', function () { act(r.id, 'restore').then(function () { Fin.closeDrawer(); Hub.toast('Put back'); }).catch(function (e) { Hub.toast(e.message, true); }); });
    var del = $('[data-rc-del]', body);
    if (del) del.addEventListener('click', function () {
      Hub.confirm({ title: 'Delete “' + r.name + '”?', danger: true, confirm: 'Delete' }).then(function (yes) {
        if (yes) act(r.id, 'delete').then(function () { Fin.closeDrawer(); Hub.toast('Deleted'); }).catch(function (e) { Hub.toast(e.message, true); });
      });
    });
  }

  /* ---------- add by hand ---------- */
  function addForm() {
    var m = document.createElement('div');
    m.className = 'hub-modal';
    var cats = Fin.data.categories || [];
    m.innerHTML = '<div class="hub-modal-box cal-form" role="dialog" aria-modal="true" aria-labelledby="rc-title"><h3 id="rc-title">Add a bill or income</h3>' +
      '<p class="fin-muted">For anything regular that doesn’t show up on its own, like rent paid by check or lessons paid in cash. If it’s in your transactions, tap one of them and choose “Track as recurring” instead.</p><form novalidate>' +
      '<div class="fin-seg" role="group" aria-label="Money in or out" data-dir-pick><button type="button" class="on" data-v="out">Money out</button><button type="button" data-v="in">Money in</button></div>' +
      '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" placeholder="Piano lessons, rent, allowance…" /></label>' +
      '<div class="cf-row"><label class="field"><span>Amount</span><input class="input" name="amount" inputmode="decimal" placeholder="0.00" /></label>' +
      '<label class="field"><span>How often</span><select name="cadence">' + CADENCES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === 'monthly' ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="field"><span>Next date</span><input class="input" type="date" name="nextDate" value="' + Fin.data.today + '" /></label>' +
      '<label class="field"><span>Category</span><select name="cat"><option value="">None</option>' + cats.filter(function (c) { return c.kind !== 'transfer'; }).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('') + '</select></label>' +
      '<p class="cf-error" role="alert" hidden></p>' +
      '<div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Add</button></div></form></div>';
    var form = $('form', m), el = form.elements, dir = 'out';
    $('[data-dir-pick]', m).addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]'); if (!b) return;
      dir = b.getAttribute('data-v');
      $$('[data-v]', m).forEach(function (x) { x.classList.toggle('on', x === b); });
    });
    function close() { m.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    $('[data-cancel]', m).addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('.cf-error', m), amount = Fin.parseMoney(el.amount.value);
      if (!el.name.value.trim()) { err.textContent = 'Give it a name.'; err.hidden = false; return; }
      if (!amount || isNaN(amount)) { err.textContent = 'Enter the amount, like 120.'; err.hidden = false; return; }
      var btn = $('[type=submit]', m); btn.disabled = true;
      Fin.save('fin-recurring', { body: { action: 'add', dir: dir, name: el.name.value, amount: amount, cadence: el.cadence.value, nextDate: el.nextDate.value, cat: el.cat.value } })
        .then(function () { close(); Hub.toast('Added'); })
        .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
    });
    document.body.appendChild(m);
    el.name.focus();
  }

  /* ---------- tab ---------- */
  Fin.tab('recurring', function (view) {
    render(view);
    // Redraw an open item from the fresh data (after a save).
    if (openRc && $('#drawer').classList.contains('open') && $('[data-rcform]', $('#drawer'))) openItem(openRc);
  });
  document.addEventListener('click', function (e) {
    var view = $('#view');
    if (!view || !view.contains(e.target) || !Fin.at('recurring')) return;
    var t = e.target.closest('[data-rc],[data-rc-yes],[data-rc-no],[data-rc-scan],[data-rc-add],[data-rc-all],[data-rc-review],[data-rc-days],[data-rc-seen]');
    if (!t) return;
    if (t.hasAttribute('data-rc-all')) {
      t.disabled = true;
      Fin.save('fin-recurring', { body: { action: 'confirm-all' } }).then(function () { reviewing = false; Hub.toast('All confirmed'); })
        .catch(function (er) { Hub.toast(er.message, true); t.disabled = false; });
    }
    else if (t.hasAttribute('data-rc-seen')) { t.disabled = true; act(t.getAttribute('data-rc-seen'), 'price-ok').catch(function (er) { Hub.toast(er.message, true); t.disabled = false; }); }
    else if (t.hasAttribute('data-rc-review')) { reviewing = !reviewing; Fin.rerender(); }
    else if (t.hasAttribute('data-rc-days')) { showMonth = !showMonth; Fin.rerender(); }
    else if (t.hasAttribute('data-rc-yes')) act(t.getAttribute('data-rc-yes'), 'confirm').then(function () { Hub.toast('Got it'); }).catch(function (er) { Hub.toast(er.message, true); });
    else if (t.hasAttribute('data-rc-no')) act(t.getAttribute('data-rc-no'), 'ignore').then(function () { Hub.toast('Marked not recurring'); }).catch(function (er) { Hub.toast(er.message, true); });
    else if (t.hasAttribute('data-rc-scan')) scan(t);
    else if (t.hasAttribute('data-rc-add')) addForm();
    else openItem(t.getAttribute('data-rc'));
  });
  Fin.openRecurring = function (id) { Fin.go('recurring'); if (id) setTimeout(function () { openItem(id); }, 0); };
  // From a transaction: follow its merchant on this tab from now on.
  Fin.trackRecurring = function (tx, month) {
    return Fin.save('fin-recurring', { body: { action: 'track', tx: tx, month: month } }).then(function (data) {
      Hub.toast('Added to Recurring');
      Fin.openRecurring(data.trackedId);
    });
  };
})();
