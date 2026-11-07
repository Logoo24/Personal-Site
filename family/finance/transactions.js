/* ============================================================
   Finance > Transactions: a month at a time, grouped by day, with
   search and filters, a "Needs review" queue for anything sorted by
   Claude or not sorted at all, a drawer per transaction (category,
   "always" rule, note, hide), hand-added transactions for hand-kept
   accounts, and CSV export.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var month = null;          // 'YYYY-MM'
  var cache = {};            // month -> transactions
  var reviewCache = null;    // the review queue, while open
  var f = { q: '', acct: '', cat: '', dir: 'all', review: false };
  var queue = {}, flushTimer = null; // review-mode edits waiting to be saved together
  var everyMonth = null;     // a search widened to every month: all of them, tagged with their month

  function cats() { return Fin.data.categories || []; }
  function catOf(id) { return cats().filter(function (c) { return c.id === id; })[0]; }
  function isTransfer(t) { var c = catOf(t.cat); return !!(c && c.kind === 'transfer'); }
  function acctOf(id) { return Fin.data.accounts.filter(function (a) { return a.id === id; })[0]; }
  function acctName(a) { return a ? (a.nick || a.name) + (a.mask ? ' ••' + a.mask : '') : 'Account'; }
  function monthLabel(m) { return Fin.monthDate(m).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function shift(m, n) { var d = Fin.monthDate(m); return Fin.monthKey(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
  function dayLabel(d) {
    var dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    var today = Fin.data.today;
    if (d === today) return 'Today';
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // mostUsed: start with the categories used most in the months loaded so far.
  function catOptions(selected, blank, mostUsed) {
    var groups = [['income', 'Income'], ['expense', 'Spending'], ['transfer', 'Transfers (not counted as spending)']];
    var top = mostUsed ? topCats(5) : [];
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') +
      (top.length ? '<optgroup label="Most used">' + top.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>' : '') + groups.map(function (g) {
      return '<optgroup label="' + g[1] + '">' + cats().filter(function (c) { return c.kind === g[0]; }).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  function topCats(n) {
    var count = {};
    Object.keys(cache).forEach(function (k) { cache[k].forEach(function (t) { if (t.cat) count[t.cat] = (count[t.cat] || 0) + 1; }); });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).map(catOf).filter(Boolean).slice(0, n);
  }

  function load(m) {
    if (cache[m]) return Promise.resolve(cache[m]);
    return Hub.api('fin-transactions', { query: { month: m } }).then(function (d) { cache[m] = d.transactions; return d.transactions; });
  }
  function loadReview() {
    return Hub.api('fin-review').then(function (d) { reviewCache = d.transactions; return d.transactions; });
  }
  Fin.invalidateTx = function () { cache = {}; reviewCache = null; everyMonth = null; };

  function filtered(list) {
    var q = f.q.trim().toLowerCase();
    return list.filter(function (t) {
      var a = acctOf(t.acct);
      if (!a || !Fin.matches(a)) return false;
      if (f.acct && t.acct !== f.acct) return false;
      if (f.cat && (f.cat === '_none' ? t.cat : t.cat !== f.cat)) return false;
      if (f.dir === 'in' && t.amt <= 0) return false;
      if (f.dir === 'out' && t.amt >= 0) return false;
      if (q) {
        var hay = [t.name, t.raw, t.note, (catOf(t.cat) || {}).name, (Math.abs(t.amt) / 100).toFixed(2)].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function row(t) {
    var a = acctOf(t.acct), c = catOf(t.cat);
    var sub = [c ? c.name : 'Uncategorized', acctName(a)].join(' · ');
    var flags = (t.pending ? '<span class="fin-tag">Pending</span>' : '') +
      (t.reviewed === false ? '<span class="fin-tag fin-tag--review">Review</span>' : '') +
      (t.hidden ? '<span class="fin-tag">Hidden</span>' : '') +
      (t.note ? '<span class="fin-note-dot" title="Has a note">' + Hub.icons.quote + '</span>' : '');
    var amtCls = 'fin-tx-amt' + (t.amt > 0 ? ' is-in' : '') + (isTransfer(t) || t.hidden ? ' is-muted' : '');
    var quick = f.review
      ? '<span class="fin-tx-quick"><select class="fin-quick-cat" data-quick-cat="' + esc(t.id) + '" aria-label="Category for ' + esc(t.name) + '">' + catOptions(t.cat, 'Pick a category') + '</select>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-ok="' + esc(t.id) + '"' + (t.cat ? '' : ' disabled') + '>' + Hub.icons.check + 'Looks right</button></span>'
      : '';
    return '<li class="fin-tx-li' + (queue[t.id] ? ' is-done' : '') + '"><button class="fin-tx" type="button" data-tx="' + esc(t.id) + '" data-month="' + esc(t.month || month) + '">' +
      Fin.catIcon(t.cat) +
      '<span class="fin-tx-main"><span class="fin-tx-name">' + esc(Fin.niceName(t.name)) + flags + '</span><span class="fin-acct-sub">' + esc(sub) + '</span></span>' +
      '<span class="' + amtCls + '">' + Fin.amt(t.amt, { cents: true, sign: true }) + '</span></button>' + quick + '</li>';
  }

  // Phones keep the account / category / in-out filters folded away.
  var filtersOpen = false;
  var activeFilters = function () { return (f.acct ? 1 : 0) + (f.cat ? 1 : 0) + (f.dir !== 'all' ? 1 : 0); };
  var DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  var FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>';

  function render(view) {
    month = month || Fin.data.today.slice(0, 7);
    var manual = Fin.data.accounts.filter(function (a) { return a.src !== 'plaid' && !a.hidden; });
    var linked = Fin.data.accounts.some(function (a) { return a.src === 'plaid'; });
    var oldest = shift(Fin.data.today.slice(0, 7), -24);
    view.innerHTML =
      '<div class="fin-tx-bar">' +
        (f.review ? '<div class="fin-month"><strong>Needs review</strong><span class="fin-muted">the last three months</span></div>'
          : '<div class="fin-month"><button class="btn btn-ghost btn-icon" type="button" data-month-step="-1" aria-label="Previous month"' + (month <= oldest ? ' disabled' : '') + '>' + Hub.icons.left + '</button>' +
            '<strong>' + esc(monthLabel(month)) + '</strong>' +
            '<button class="btn btn-ghost btn-icon" type="button" data-month-step="1" aria-label="Next month"' + (month >= Fin.data.today.slice(0, 7) ? ' disabled' : '') + '>' + Hub.icons.right + '</button></div>') +
        '<div class="fin-tx-actions">' +
          '<button class="chip' + (f.review ? ' on' : '') + '" type="button" data-review>Needs review' + (Fin.data.toReview ? ' (' + Fin.data.toReview + ')' : '') + '</button>' +
          // Phones show just the icons (finance.css); the aria-labels name them.
          (manual.length ? '<button class="btn btn-ghost btn-sm" type="button" data-add-tx aria-label="Add a transaction">' + Hub.icons.plus + '<span class="fin-btn-text">Add</span></button>' : '') +
          '<button class="btn btn-ghost btn-sm" type="button" data-export aria-label="Export to a spreadsheet">' + DOWNLOAD + '<span class="fin-btn-text">Export</span></button>' +
        '</div>' +
      '</div>' +
      // Phones: search and a Filters button on one row; the rest opens under it.
      '<div class="fin-tx-filters' + (filtersOpen ? ' open' : '') + '">' +
        '<div class="fin-tx-search-row">' +
          '<label class="search fin-search">' + Hub.icons.search + '<input class="input" type="search" placeholder="Search merchants, notes or amounts" value="' + esc(f.q) + '" data-f="q" aria-label="Search transactions" /></label>' +
          '<button class="btn btn-ghost btn-sm fin-tx-filter-btn" type="button" data-filters aria-expanded="' + filtersOpen + '" aria-controls="tx-more">' + FILTER + 'Filters' +
            (activeFilters() ? ' <span class="fin-badge">' + activeFilters() + '</span>' : '') + '</button>' +
        '</div>' +
        '<div class="fin-tx-more" id="tx-more">' +
          '<select data-f="acct" aria-label="Account"><option value="">All accounts</option>' + Fin.data.accounts.filter(Fin.matches).map(function (a) {
            return '<option value="' + esc(a.id) + '"' + (f.acct === a.id ? ' selected' : '') + '>' + esc(acctName(a)) + '</option>';
          }).join('') + '</select>' +
          '<select data-f="cat" aria-label="Category">' + catOptions(f.cat, 'All categories').replace('</option>', '</option><option value="_none"' + (f.cat === '_none' ? ' selected' : '') + '>Uncategorized</option>') + '</select>' +
          '<div class="fin-seg" role="group" aria-label="Money in or out">' + [['all', 'All'], ['out', 'Out'], ['in', 'In']].map(function (d) {
            return '<button type="button" data-dir="' + d[0] + '"' + (f.dir === d[0] ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + d[1] + '</button>';
          }).join('') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="fin-tx-totals" data-totals></div>' +
      '<section class="fin-card fin-tx-card" data-list><p class="hub-loading">Loading transactions…</p></section>';

    if (!linked && !manual.length && !f.review) {
      $('[data-list]', view).innerHTML = '<div class="fin-soon"><h2>No transactions yet</h2><p>Link a bank on the Accounts tab and its transactions show up here, sorted into categories.</p></div>';
      return;
    }
    (f.review ? loadReview() : load(month)).then(function (list) { draw(view, everyMonth && f.q.trim() ? everyMonth : list); })
      .catch(function (e) { $('[data-list]', view).innerHTML = '<p class="fin-muted">Couldn’t load transactions: ' + esc(e.message) + '</p>'; });
  }

  function draw(view, list) {
    var shown = filtered(list);
    var counted = shown.filter(function (t) { return !isTransfer(t) && !t.hidden && !t.pending; });
    var inn = counted.filter(function (t) { return t.amt > 0; }).reduce(function (m, t) { return m + t.amt; }, 0);
    var out = counted.filter(function (t) { return t.amt < 0; }).reduce(function (m, t) { return m - t.amt; }, 0);
    $('[data-totals]', view).innerHTML = f.review ? '<span class="fin-muted">' + Hub.plural(shown.length, 'transaction') + ' to look over. Pick a category, or tap “Looks right”.</span>'
      : '<div class="fin-split"><span>In <b>' + Fin.amt(inn) + '</b></span><span>Out <b>' + Fin.amt(out) + '</b></span><span>Net <b>' + Fin.amt(inn - out, { sign: true }) + '</b></span>' +
        '<span class="fin-muted fin-tx-note">Transfers, pending and hidden aren’t counted.</span></div>';
    var box = $('[data-list]', view);
    // A search looks in the month on screen first; one tap widens it to every month.
    var wider = !f.q.trim() || f.review ? ''
      : everyMonth ? '<p class="fin-muted fin-tx-wider">Searched every month back to ' + esc(monthLabel(oldestMonth())) + '.</p>'
      : '<p class="fin-tx-wider"><button class="btn btn-ghost btn-sm" type="button" data-search-all>' + Hub.icons.search + 'Search every month</button></p>';
    if (!shown.length) {
      box.innerHTML = '<p class="fin-muted fin-tx-empty">' + (list.length ? 'Nothing matches' + (f.q.trim() && !everyMonth && !f.review ? ' in ' + esc(monthLabel(month)) : ' those filters') + '.' : f.review ? 'All caught up. Nothing needs a look.' : 'No transactions in ' + esc(monthLabel(month)) + '.') + '</p>' + wider;
      return;
    }
    var days = {};
    shown.forEach(function (t) { (days[t.date] = days[t.date] || []).push(t); });
    box.innerHTML = Object.keys(days).sort().reverse().map(function (d) {
      var net = days[d].filter(function (t) { return !isTransfer(t) && !t.hidden; }).reduce(function (m, t) { return m + t.amt; }, 0);
      return '<div class="fin-tx-day"><h3><span>' + esc(dayLabel(d) + (everyMonth && d.slice(0, 4) !== Fin.data.today.slice(0, 4) ? ', ' + d.slice(0, 4) : '')) + '</span><span class="fin-muted">' + Fin.amt(net, { cents: true, sign: true }) + '</span></h3>' +
        '<ul>' + days[d].map(row).join('') + '</ul></div>';
    }).join('') + wider;
  }

  // Every month that can be shown, oldest first, loaded and tagged with its month.
  function oldestMonth() { return shift(Fin.data.today.slice(0, 7), -24); }
  function searchAll(view) {
    var months = [], m = oldestMonth();
    while (m <= Fin.data.today.slice(0, 7)) { months.push(m); m = shift(m, 1); }
    var btn = $('[data-search-all]', view);
    if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Searching…'; }
    Promise.all(months.map(load)).then(function () {
      everyMonth = [].concat.apply([], months.map(function (k) { return cache[k].map(function (t) { return Object.assign({ month: k }, t); }); }));
      draw(view, everyMonth);
    }).catch(function (e) { Hub.toast(e.message, true); if (btn) btn.disabled = false; });
  }

  /* ---------- one transaction ---------- */
  function find(id) {
    var lists = [reviewCache || []].concat(Object.keys(cache).map(function (k) { return cache[k].map(function (t) { return Object.assign({ month: k }, t); }); }));
    for (var i = 0; i < lists.length; i++) for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return lists[i][j];
    return null;
  }

  function openTx(id, m) {
    var t = find(id);
    if (!t) return;
    t.month = t.month || m;
    var a = acctOf(t.acct);
    var name = Fin.niceName(t.name);
    var body = Fin.openDrawer(name,
      '<div><span class="fin-label">' + (t.amt > 0 ? 'Money in' : 'Money out') + (t.pending ? ' · pending' : '') + '</span>' +
        '<div class="fin-kpi-value">' + Fin.amt(t.amt, { cents: true, sign: true }) + '</div>' +
        '<span class="fin-muted">' + esc(dayLabel(t.date)) + (t.date !== Fin.data.today ? ', ' + esc(t.date.slice(0, 4)) : '') + ' · ' + esc(acctName(a)) + '</span></div>' +
      '<form class="fin-tx-form" data-txform>' +
        '<label class="field"><span>Category</span><select name="cat">' + catOptions(t.cat, 'Uncategorized', true) + '</select></label>' +
        '<label class="cf-check"><input type="checkbox" name="rule" /> <span data-rule-label>Always put ' + esc(name) + ' here</span></label>' +
        '<label class="field"><span>Note</span><textarea name="note" rows="2" maxlength="500" placeholder="Optional">' + esc(t.note || '') + '</textarea></label>' +
        '<label class="cf-check"><input type="checkbox" name="hidden"' + (t.hidden ? ' checked' : '') + ' /> Leave out of totals and reports</label>' +
        // One button: saves any change, and marks a transaction waiting for
        // review as looked at (so "it's right as it is" is just Done).
        '<div class="fin-drawer-actions"><button class="btn btn-primary btn-sm" type="submit">' + Hub.icons.check + 'Done</button>' +
          (String(t.id).indexOf('m_') === 0 ? '<button class="btn btn-danger btn-sm" type="button" data-del-tx>' + Hub.icons.trash + 'Delete</button>' : '') + '</div>' +
      '</form>' +
      '<dl class="fin-facts">' +
        '<div><dt>On the statement</dt><dd>' + esc(t.raw || t.name) + '</dd></div>' +
        (t.catSrc ? '<div><dt>Sorted by</dt><dd>' + esc({ plaid: 'Plaid', auto: 'Built-in rules', rule: 'Your rule', ai: 'Claude', user: 'You' }[t.catSrc] || t.catSrc) + '</dd></div>' : '') +
        (t.pair ? '<div><dt>Transfer</dt><dd>Matched with the same amount in another of your accounts</dd></div>' : '') +
      '</dl>');
    var form = $('[data-txform]', body), el = form.elements;
    function save() {
      var edit = { id: t.id, month: t.month };
      if ((el.cat.value || null) !== (t.cat || null)) edit.cat = el.cat.value || null;
      if (el.note.value !== (t.note || '')) edit.note = el.note.value;
      if (el.hidden.checked !== !!t.hidden) edit.hidden = el.hidden.checked;
      if (t.reviewed === false) edit.reviewed = true;
      var payload = { edits: [edit] };
      if (el.rule.checked && el.cat.value) payload.rule = { id: t.id, month: t.month, cat: el.cat.value };
      if (Object.keys(edit).length === 2 && !payload.rule) { Fin.closeDrawer(); return; } // nothing changed
      $$('button', form).forEach(function (b) { b.disabled = true; });
      Hub.api('fin-tx-edit', { body: payload }).then(function (data) {
        Fin.invalidateTx(); Fin.closeDrawer(); Fin.apply(data);
        Hub.toast(payload.rule ? 'Saved, and the rule is set' : 'Saved');
      }).catch(function (e) { Hub.toast(e.message, true); $$('button', form).forEach(function (b) { b.disabled = false; }); });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
    var del = $('[data-del-tx]', body);
    if (del) del.addEventListener('click', function () {
      Hub.confirm({ title: 'Delete this transaction?', danger: true, confirm: 'Delete', body: '<p>' + (t.adjusted ? 'The account’s balance goes back to what it was before.' : 'It comes off the list.') + '</p>' }).then(function (yes) {
        if (!yes) return;
        Hub.api('fin-tx', { method: 'DELETE', query: { id: t.id, month: t.month } }).then(function (data) {
          Fin.invalidateTx(); Fin.closeDrawer(); Fin.apply(data); Hub.toast('Deleted');
        }).catch(function (e) { Hub.toast(e.message, true); });
      });
    });
  }

  /* ---------- review queue: quick edits, saved together ---------- */
  function queueEdit(id, edit) {
    var t = find(id);
    if (!t) return;
    queue[id] = Object.assign(queue[id] || { id: id, month: t.month }, edit);
    var li = $('[data-tx="' + id + '"]').closest('li');
    if (li) li.classList.add('is-done');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500);
  }
  function flush() {
    var edits = Object.keys(queue).map(function (k) { return queue[k]; });
    if (!edits.length) return Promise.resolve();
    queue = {};
    return Hub.api('fin-tx-edit', { body: { edits: edits } }).then(function (data) {
      Fin.invalidateTx(); Fin.apply(data);
      Hub.toast(Hub.plural(edits.length, 'transaction') + ' saved');
    }).catch(function (e) { Hub.toast(e.message, true); Fin.rerender(); });
  }
  window.addEventListener('beforeunload', function () { if (Object.keys(queue).length) flush(); });

  /* ---------- add by hand ---------- */
  function addForm() {
    var manual = Fin.data.accounts.filter(function (a) { return a.src !== 'plaid' && !a.hidden; });
    var m = document.createElement('div');
    m.className = 'hub-modal';
    m.innerHTML = '<div class="hub-modal-box cal-form" role="dialog" aria-modal="true" aria-labelledby="tx-title"><h3 id="tx-title">Add a transaction</h3>' +
      '<p class="fin-muted">For accounts you keep by hand. Linked banks bring their own.</p><form novalidate>' +
      '<label class="field"><span>Account</span><select name="acct">' + manual.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(acctName(a)) + '</option>'; }).join('') + '</select></label>' +
      '<div class="fin-seg" role="group" aria-label="Money in or out" data-dir-pick><button type="button" class="on" data-v="out">Money out</button><button type="button" data-v="in">Money in</button></div>' +
      '<div class="cf-row"><label class="field"><span>Amount</span><input class="input" name="amt" inputmode="decimal" placeholder="0.00" /></label>' +
      '<label class="field"><span>Date</span><input class="input" type="date" name="date" max="' + Fin.data.today + '" value="' + Fin.data.today + '" /></label></div>' +
      '<label class="field"><span>What for</span><input class="input" name="name" maxlength="80" placeholder="Farmers market, babysitter…" /></label>' +
      '<label class="field"><span>Category</span><select name="cat">' + catOptions('', 'Uncategorized') + '</select></label>' +
      '<label class="field"><span>Note</span><input class="input" name="note" maxlength="500" placeholder="Optional" /></label>' +
      '<label class="cf-check"><input type="checkbox" name="adjust" checked /> Change the account’s balance to match</label>' +
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
      var err = $('.cf-error', m), v = Fin.parseMoney(el.amt.value);
      if (!v || isNaN(v)) { err.textContent = 'Enter the amount, like 24.50.'; err.hidden = false; return; }
      if (!el.name.value.trim()) { err.textContent = 'Say what it was for.'; err.hidden = false; return; }
      var btn = $('[type=submit]', m); btn.disabled = true;
      Hub.api('fin-tx', { body: { acct: el.acct.value, amt: dir === 'out' ? -v : v, date: el.date.value, name: el.name.value, cat: el.cat.value, note: el.note.value, adjust: el.adjust.checked } }).then(function (data) {
        close(); Fin.invalidateTx(); month = el.date.value.slice(0, 7); Fin.apply(data); Hub.toast('Added');
      }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
    });
    document.body.appendChild(m);
    el.amt.focus();
  }

  function exportMenu() {
    var m = document.createElement('div');
    m.className = 'hub-modal';
    var cur = Fin.data.today.slice(0, 7), y = cur.slice(0, 4);
    var opts = [
      ['This month', month || cur, month || cur],
      ['The last 3 months', shift(cur, -2), cur],
      ['The last 12 months', shift(cur, -11), cur],
      ['This year so far', y + '-01', cur],
      ['Last year', (+y - 1) + '-01', (+y - 1) + '-12']
    ];
    m.innerHTML = '<div class="hub-modal-box" role="dialog" aria-modal="true"><h3>Export transactions</h3><p class="fin-muted">A spreadsheet (CSV) of the accounts you can see.</p>' +
      '<div class="fin-export-list">' + opts.map(function (o) {
        return '<a class="btn btn-ghost" href="/api/family?r=fin-export&from=' + o[1] + '&to=' + o[2] + '" download>' + esc(o[0]) + '</a>';
      }).join('') + '</div><div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-cancel>Close</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-cancel]') || e.target.closest('a')) setTimeout(function () { m.remove(); }, 0); });
    document.body.appendChild(m);
  }

  /* ---------- tab ---------- */
  Fin.tab('transactions', render);
  Fin.showReview = function () { f.review = true; f.cat = ''; f.dir = 'all'; reviewCache = null; Fin.go('transactions'); };

  document.addEventListener('click', function (e) {
    var view = $('#view');
    if (!view || !view.contains(e.target) || !Fin.at('transactions')) return;
    var t = e.target.closest('[data-tx],[data-month-step],[data-review],[data-dir],[data-add-tx],[data-export],[data-ok],[data-filters],[data-search-all]');
    if (!t) return;
    if (t.hasAttribute('data-search-all')) return searchAll(view);
    if (t.hasAttribute('data-filters')) {
      filtersOpen = !filtersOpen;
      t.setAttribute('aria-expanded', String(filtersOpen));
      t.closest('.fin-tx-filters').classList.toggle('open', filtersOpen);
      return;
    }
    if (t.hasAttribute('data-ok')) { queueEdit(t.getAttribute('data-ok'), { reviewed: true }); return; }
    if (t.hasAttribute('data-tx')) return openTx(t.getAttribute('data-tx'), t.getAttribute('data-month'));
    if (t.hasAttribute('data-month-step')) { month = shift(month, +t.getAttribute('data-month-step')); everyMonth = null; return Fin.rerender(); }
    if (t.hasAttribute('data-review')) {
      flush(); f.review = !f.review; reviewCache = null;
      if (f.review) { f.cat = ''; f.dir = 'all'; } // the queue is mostly uncategorized: don't hide it behind a filter
      return Fin.rerender();
    }
    if (t.hasAttribute('data-dir')) { f.dir = t.getAttribute('data-dir'); return Fin.rerender(); }
    if (t.hasAttribute('data-add-tx')) return addForm();
    if (t.hasAttribute('data-export')) return exportMenu();
  });
  document.addEventListener('change', function (e) {
    if (!Fin.at('transactions')) return;
    var sel = e.target.closest('[data-quick-cat]');
    if (sel) { if (sel.value) queueEdit(sel.getAttribute('data-quick-cat'), { cat: sel.value }); return; }
    var fl = e.target.closest('select[data-f]');
    if (fl) { f[fl.getAttribute('data-f')] = fl.value; Fin.rerender(); }
  });
  var searchTimer;
  document.addEventListener('input', function (e) {
    var s = e.target.closest('input[data-f="q"]');
    if (!s || !Fin.at('transactions')) return;
    f.q = s.value;
    if (!f.q.trim()) everyMonth = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var view = $('#view'), list = f.review ? reviewCache : everyMonth || cache[month];
      if (list) draw(view, list);
    }, 150);
  });
})();
