/* ============================================================
   Finance > Recurring: subscriptions, bills and regular income,
   found automatically in the transactions (api/_family/finance/
   recurring.js) or added by hand. Shows what each costs a month and
   a year, what's coming in the next 30 days (card and loan due dates
   too), and price rises. Found items can be confirmed or dismissed;
   any of them can be renamed or have their amount and timing fixed.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var CADENCES = [['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Every month'], ['quarterly', 'Every 3 months'], ['yearly', 'Every year']];
  var KIND = { subscription: 'Subscription', bill: 'Bill', paycheck: 'Paycheck', income: 'Income', due: 'Payment due' };
  var scanned = false;

  function cadenceLabel(c) { var x = CADENCES.filter(function (k) { return k[0] === c; })[0]; return x ? x[1] : c; }
  function acctOf(id) { return Fin.data.accounts.filter(function (a) { return a.id === id; })[0]; }
  function day(d, opts) { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' }); }
  function relDay(d) {
    var t = Fin.data.today;
    if (d === t) return 'Today';
    var diff = Math.round((new Date(d + 'T12:00:00') - new Date(t + 'T12:00:00')) / 864e5);
    return diff === 1 ? 'Tomorrow' : day(d);
  }
  // The person filter: an item follows its account's owner, or "whose" for a paycheck.
  function shown(r) {
    if (Fin.person === 'all') return true;
    if (r.person) return r.person === Fin.person;
    var a = r.acct && acctOf(r.acct);
    return a ? Fin.matches(a) : true;
  }
  function active(r) { return r.status !== 'ignored' && !r.ended; }

  function row(r) {
    var a = r.acct && acctOf(r.acct);
    var tags = (r.status === 'detected' ? '<span class="fin-tag fin-tag--review">Found</span>' : '') +
      (r.status === 'manual' ? '<span class="fin-tag">Added by hand</span>' : '') +
      (r.priceUp ? '<span class="fin-tag fin-tag--up">' + Hub.icons.up + 'Went up</span>' : '') +
      (r.ended ? '<span class="fin-tag">Stopped?</span>' : '');
    var sub = [cadenceLabel(r.cadence), r.ended ? 'last seen ' + day(r.lastDate) : 'next ' + relDay(r.nextDate), a ? (a.nick || a.name) : '', r.person ? Fin.ownerName(r.person) : ''].filter(Boolean).join(' · ');
    var perMonth = r.cadence !== 'monthly' ? '<span class="fin-acct-sub">' + Fin.amt(r.monthly) + ' a month</span>' : '';
    return '<li class="fin-rc-li"><button class="fin-acct" type="button" data-rc="' + esc(r.id) + '">' +
      '<span class="fin-acct-icon" aria-hidden="true">' + esc(String(r.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?') + '</span>' +
      '<span class="fin-acct-main"><span class="fin-acct-name">' + esc(r.name) + tags + '</span><span class="fin-acct-sub">' + esc(sub) + '</span></span>' +
      '<span class="fin-acct-right"><span class="fin-acct-bal' + (r.dir === 'in' ? ' fin-tx-amt is-in' : '') + '">' + (r.variable ? '<small>about </small>' : '') + Fin.amt(r.dir === 'in' ? r.amount : -r.amount, { cents: true, sign: r.dir === 'in' }) + '</span>' + perMonth + '</span>' +
    '</button>' +
    (r.status === 'detected' ? '<div class="fin-rc-ask"><span class="fin-muted">Is this a regular ' + (r.dir === 'in' ? 'deposit' : 'charge') + '?</span><button class="btn btn-ghost btn-sm" type="button" data-rc-yes="' + esc(r.id) + '">' + Hub.icons.check + 'Yes</button><button class="btn btn-ghost btn-sm" type="button" data-rc-no="' + esc(r.id) + '">No</button></div>' : '') +
    '</li>';
  }

  function section(title, list, total) {
    if (!list.length) return '';
    return '<section class="fin-card"><div class="fin-card-head"><h2>' + esc(title) + '</h2>' + (total != null ? '<span class="fin-muted">' + Fin.amt(total) + ' a month</span>' : '') + '</div>' +
      '<ul class="fin-accts">' + list.map(row).join('') + '</ul></section>';
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
          '<span class="fin-acct-sub">' + esc(KIND[u.kind] || '') + (u.kind === 'due' && u.min ? ' · minimum ' + Fin.money(u.min) : '') + '</span></span>' +
          '<span class="fin-tx-amt' + (u.dir === 'in' ? ' is-in' : '') + '">' + (u.amount != null ? (u.variable ? '<small>about </small>' : '') + Fin.amt(u.dir === 'in' ? u.amount : -u.amount, { cents: true, sign: u.dir === 'in' }) : '') + '</span></li>';
      }).join('') + '</ul></div>';
    }).join('') + '</div>';
  }
  Fin.upcomingHTML = upcomingHTML;

  function render(view) {
    var items = (Fin.data.recurring || []).filter(shown);
    var live = items.filter(active);
    var subs = live.filter(function (r) { return r.kind === 'subscription'; });
    var bills = live.filter(function (r) { return r.kind === 'bill'; });
    var income = live.filter(function (r) { return r.dir === 'in'; });
    var sum = function (l) { return l.reduce(function (m, r) { return m + (r.monthly || 0); }, 0); };
    var out = sum(subs) + sum(bills), inn = sum(income);
    var stopped = items.filter(function (r) { return r.ended && r.status !== 'ignored'; });
    var ignored = items.filter(function (r) { return r.status === 'ignored'; });
    var ups = live.filter(function (r) { return r.priceUp; });

    view.innerHTML =
      '<div class="fin-acct-head"><div class="fin-split">' +
        '<span>Bills &amp; subscriptions <b>' + Fin.amt(out) + '</b> a month <span class="fin-muted">(' + Fin.amt(out * 12) + ' a year)</span></span>' +
        '<span>Regular income <b>' + Fin.amt(inn) + '</b> a month</span></div>' +
        '<div class="hub-actions"><button class="btn btn-ghost btn-sm" type="button" data-rc-scan>' + Hub.icons.refresh + 'Look again</button>' +
        '<button class="btn btn-primary btn-sm" type="button" data-rc-add>' + Hub.icons.plus + 'Add a bill or income</button></div></div>' +
      (ups.length ? '<div class="fin-alerts">' + ups.map(function (r) {
        return '<button class="fin-alert fin-alert--up" type="button" data-rc="' + esc(r.id) + '">' + Hub.icons.up + '<span>' + esc(r.name) + ' went up from ' + Fin.money(r.priceUp.from, { cents: true }) + ' to ' + Fin.money(r.priceUp.to, { cents: true }) + ' (' + Fin.money((r.priceUp.to - r.priceUp.from) * 12, { cents: true }) + ' more a year)</span>' + Hub.icons.right + '</button>';
      }).join('') + '</div>' : '') +
      '<section class="fin-card"><div class="fin-card-head"><h2>Coming up</h2><span class="fin-muted">The next 30 days</span></div>' + upcomingHTML(items, 30) + '</section>' +
      (items.length ? '' : '<div class="fin-soon"><h2>Nothing found yet</h2><p>Recurring charges show up here once there are a few months of transactions. You can add rent, lessons or anything else by hand.</p></div>') +
      section('Subscriptions', subs, sum(subs)) +
      section('Bills', bills, sum(bills)) +
      section('Income', income, sum(income)) +
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
  function openItem(id) {
    var r = find(id);
    if (!r) { openRc = null; Fin.closeDrawer(); return; }
    openRc = id;
    var manual = r.status === 'manual';
    var people = [['', 'Not set']].concat((Fin.data.people || []).map(function (p) { return [p.email, p.name]; }));
    var a = r.acct && acctOf(r.acct);
    var body = Fin.openDrawer(r.name,
      '<div><span class="fin-label">' + esc(KIND[r.kind] || '') + ' · ' + esc(cadenceLabel(r.cadence)) + '</span>' +
        '<div class="fin-kpi-value">' + (r.variable ? '<small class="fin-muted">about </small>' : '') + Fin.amt(r.dir === 'in' ? r.amount : -r.amount, { cents: true, sign: r.dir === 'in' }) + '</div>' +
        '<span class="fin-muted">' + Fin.amt(r.monthly) + ' a month · ' + Fin.amt(r.monthly * 12) + ' a year</span></div>' +
      '<form class="fin-tx-form" data-rcform>' +
        '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" value="' + esc(r.name) + '" /></label>' +
        '<div class="cf-row"><label class="field"><span>' + (r.variable ? 'Usually about' : 'Amount') + '</span><input class="input" name="amount" inputmode="decimal" value="' + esc(Fin.moneyInput(r.amount)) + '" /></label>' +
        '<label class="field"><span>How often</span><select name="cadence">' + CADENCES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === r.cadence ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select></label></div>' +
        (manual ? '<label class="field"><span>Next date</span><input class="input" type="date" name="nextDate" value="' + esc(r.nextDate || Fin.data.today) + '" /></label>' : '') +
        (r.dir === 'in' ? '<label class="field"><span>Whose</span><select name="person">' + people.map(function (p) { return '<option value="' + esc(p[0]) + '"' + ((r.person || '') === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') + '</select></label>' : '') +
        '<label class="field"><span>Note</span><input class="input" name="note" maxlength="300" value="' + esc(r.note || '') + '" placeholder="Optional" /></label>' +
        '<div class="fin-drawer-actions"><button class="btn btn-primary btn-sm" type="submit">Save</button>' +
          (r.status === 'ignored' ? '<button class="btn btn-ghost btn-sm" type="button" data-rc-restore>Put it back</button>'
            : manual ? '<button class="btn btn-danger btn-sm" type="button" data-rc-del>' + Hub.icons.trash + 'Delete</button>'
            : '<button class="btn btn-ghost btn-sm" type="button" data-rc-ignore>Not recurring</button>') + '</div>' +
      '</form>' +
      '<dl class="fin-facts">' +
        (r.nextDate && !r.ended ? '<div><dt>Next</dt><dd>' + esc(day(r.nextDate, { weekday: 'long', month: 'long', day: 'numeric' })) + '</dd></div>' : '') +
        (r.lastDate ? '<div><dt>Last seen</dt><dd>' + esc(day(r.lastDate, { month: 'long', day: 'numeric', year: 'numeric' })) + (r.last ? ', ' + esc(Fin.money(r.last, { cents: true })) : '') + '</dd></div>' : '') +
        (r.count ? '<div><dt>Seen</dt><dd>' + esc(Hub.plural(r.count, 'time')) + ' in the last 14 months</dd></div>' : '') +
        (a ? '<div><dt>Account</dt><dd>' + esc((a.nick || a.name) + (a.mask ? ' ••' + a.mask : '')) + '</dd></div>' : '') +
        (r.priceUp ? '<div><dt>Price</dt><dd>Went up ' + esc(day(r.priceUp.date, { month: 'long', day: 'numeric' })) + ', from ' + esc(Fin.money(r.priceUp.from, { cents: true })) + ' to ' + esc(Fin.money(r.priceUp.to, { cents: true })) + '</dd></div>' : '') +
        (r.variable ? '<div><dt>Amount</dt><dd>Changes from month to month, so this is the average of the last three</dd></div>' : '') +
      '</dl>');
    var form = $('[data-rcform]', body), el = form.elements;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var amount = Fin.parseMoney(el.amount.value);
      if (!amount || isNaN(amount)) { Hub.toast('Enter the amount, like 15.49.', true); return; }
      var edit = { name: el.name.value, amount: amount, cadence: el.cadence.value, note: el.note.value };
      if (el.nextDate) edit.nextDate = el.nextDate.value;
      if (el.person) edit.person = el.person.value;
      act(r.id, 'edit', edit).then(function () { Hub.toast('Saved'); }).catch(function (err) { Hub.toast(err.message, true); });
    });
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
      '<p class="fin-muted">For anything regular that doesn’t show up on its own, like rent paid by check or lessons paid in cash.</p><form novalidate>' +
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
    if (!view || !view.contains(e.target) || location.hash.replace('#', '') !== 'recurring') return;
    var t = e.target.closest('[data-rc],[data-rc-yes],[data-rc-no],[data-rc-scan],[data-rc-add]');
    if (!t) return;
    if (t.hasAttribute('data-rc-yes')) act(t.getAttribute('data-rc-yes'), 'confirm').then(function () { Hub.toast('Got it'); }).catch(function (er) { Hub.toast(er.message, true); });
    else if (t.hasAttribute('data-rc-no')) act(t.getAttribute('data-rc-no'), 'ignore').then(function () { Hub.toast('Marked not recurring'); }).catch(function (er) { Hub.toast(er.message, true); });
    else if (t.hasAttribute('data-rc-scan')) scan(t);
    else if (t.hasAttribute('data-rc-add')) addForm();
    else openItem(t.getAttribute('data-rc'));
  });
  Fin.openRecurring = function (id) { Fin.go('recurring'); if (id) setTimeout(function () { openItem(id); }, 0); };
})();
