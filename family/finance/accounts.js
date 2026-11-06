/* ============================================================
   Finance > Accounts: every account by kind, a drawer per account
   (balance history, details, update balance, edit, delete), the
   add/edit form, and the past-months grid for typing in month-end
   balances from old statements.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var GROUPS = ['Cash', 'Investments', 'Retirement', 'Property & vehicles', 'Other assets', 'Credit cards', 'Loans', 'Other debts'];
  var KINDS = [
    ['What you own', [['cash', 'Cash: checking, savings, cash on hand'], ['investment', 'Investments: brokerage, HSA, crypto'], ['retirement', 'Retirement: 401(k), IRA'], ['property', 'Home or property'], ['vehicle', 'Vehicle'], ['other-asset', 'Something else you own']]],
    ['What you owe', [['credit', 'Credit card'], ['loan', 'Loan: car, student, personal'], ['mortgage', 'Mortgage'], ['other-debt', 'Other debt']]]
  ];
  var mode = 'list';  // or 'history' (the past-months grid)
  var openId = null;  // the account in the drawer
  var dirty = {};     // grid edits: 'id|YYYY-MM' -> cents or null

  function find(id) { return Fin.data.accounts.filter(function (a) { return a.id === id; })[0]; }
  function nameOf(a) { return a.nick || a.name; }
  function groupOf(a) { return (Fin.TYPES[a.type] || {}).group || 'Other assets'; }
  function subLine(a) {
    return [a.inst, a.mask ? '••' + a.mask : '', Fin.ownerName(a.owner)].filter(Boolean).join(' · ');
  }
  function initials(a) {
    var w = String(a.inst || a.name || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
  }
  function byGroupThenName(a, b) {
    return GROUPS.indexOf(groupOf(a)) - GROUPS.indexOf(groupOf(b)) || nameOf(a).localeCompare(nameOf(b));
  }
  function otherPerson() {
    var me = Fin.data.viewer.email;
    return (Fin.data.people || []).filter(function (p) { return p.email !== me; })[0];
  }

  /* ---------- the list ---------- */
  function row(a) {
    var right = '';
    if (a.type === 'credit' && a.limit) right = Math.round((a.balance || 0) / a.limit * 100) + '% of limit';
    else if (a.src !== 'plaid' && a.asOf) right = 'Updated ' + Fin.ago(a.asOf);
    var tags = (a.private ? '<span class="fin-tag" title="Only you can see this account">' + Hub.icons.lock + 'Only me</span>' : '') +
      (a.inNetWorth === false ? '<span class="fin-tag">Not counted</span>' : '');
    return '<li><button class="fin-acct" type="button" data-acct="' + esc(a.id) + '">' +
      '<span class="fin-acct-icon" aria-hidden="true">' + esc(initials(a)) + '</span>' +
      '<span class="fin-acct-main"><span class="fin-acct-name">' + esc(nameOf(a)) + tags + '</span><span class="fin-acct-sub">' + esc(subLine(a)) + '</span></span>' +
      '<span class="fin-acct-right"><span class="fin-acct-bal">' + Fin.amt(a.balance, { cents: a.type === 'cash' || a.type === 'credit' }) + '</span>' +
      (right ? '<span class="fin-acct-sub">' + esc(right) + '</span>' : '') + '</span>' +
    '</button></li>';
  }

  function renderList(view) {
    var all = Fin.data.accounts;
    if (!all.length) {
      view.innerHTML = '<div class="fin-soon"><h2>No accounts yet</h2><p>Link your banks, cards and investments through Plaid, or add a car, a home, a loan or cash by hand.</p>' +
        '<p class="fin-soon-actions"><button class="btn btn-primary" type="button" data-link>' + Hub.icons.bank + 'Link a bank</button>' +
        '<button class="btn btn-ghost" type="button" data-add>' + Hub.icons.plus + 'Add an asset or debt</button></p></div>' + banksCard();
      return;
    }
    var shown = all.filter(Fin.matches);
    var active = shown.filter(function (a) { return !a.hidden; }).sort(byGroupThenName);
    var hidden = shown.filter(function (a) { return a.hidden; }).sort(byGroupThenName);
    var counted = active.filter(function (a) { return a.inNetWorth !== false; });
    var own = 0, owe = 0;
    counted.forEach(function (a) { if (Fin.sideOf(a) === 'liability') owe += a.balance || 0; else own += a.balance || 0; });

    var html = '<div class="fin-acct-head">' +
      '<div class="fin-split"><span>Own <b>' + Fin.amt(own) + '</b></span><span>Owe <b>' + Fin.amt(owe) + '</b></span><span>' + Hub.plural(active.length, 'account') + '</span></div>' +
      '<div class="hub-actions">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-history>Edit past months</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-add>' + Hub.icons.plus + 'Add an asset or debt</button>' +
      '<button class="btn btn-primary btn-sm" type="button" data-link>' + Hub.icons.bank + 'Link a bank</button></div></div>' +
      banksCard();
    if (!active.length) html += '<div class="fin-soon"><h2>No accounts for ' + esc(Fin.ownerName(Fin.person)) + '</h2><p>Pick Everyone to see them all.</p></div>';
    GROUPS.forEach(function (g) {
      var list = active.filter(function (a) { return groupOf(a) === g; });
      if (!list.length) return;
      var total = list.filter(function (a) { return a.inNetWorth !== false; }).reduce(function (m, a) { return m + (a.balance || 0); }, 0);
      html += '<section class="fin-card fin-group"><div class="fin-card-head"><h2>' + esc(g) + '</h2><span class="fin-group-total">' + Fin.amt(total) + '</span></div>' +
        '<ul class="fin-accts">' + list.map(row).join('') + '</ul></section>';
    });
    if (hidden.length) {
      html += '<details class="fin-card fin-hidden-accts"><summary>' + Hub.plural(hidden.length, 'hidden account') + '</summary><ul class="fin-accts">' + hidden.map(row).join('') + '</ul></details>';
    }
    view.innerHTML = html;
  }

  /* ---------- bank connections (Plaid) ---------- */
  function banksCard() {
    var d = Fin.data, items = d.items || [];
    if (!d.setup.plaid) {
      return items.length ? '' : '<div class="fin-banner fin-banner--info">' + Hub.icons.bank + '<span>Bank linking needs Plaid keys: <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> in Vercel (and <code>.env.local</code> to try it locally).</span></div>';
    }
    if (!items.length) return '';
    var left = d.itemsMax - d.itemsUsed;
    return '<section class="fin-card fin-banks"><div class="fin-card-head"><h2>Bank connections</h2>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-refresh>' + Hub.icons.refresh + 'Refresh now</button></div>' +
      '<ul class="fin-accts">' + items.map(function (it) {
        var n = d.accounts.filter(function (a) { return a.itemId === it.id; }).length;
        var state = it.status === 'reconnect' ? '<span class="fin-status fin-status--bad">' + Hub.icons.x + 'Needs you to sign in again</span>'
          : it.status === 'error' ? '<span class="fin-status fin-status--warn">Couldn’t sync (' + esc(it.error || 'error') + ')</span>'
          : '<span class="fin-status">' + Hub.icons.check + (it.lastSync ? 'Synced ' + Fin.ago(it.lastSync) : 'Waiting for first sync') + (it.historyComplete ? '' : ' · history still loading') + '</span>';
        return '<li class="fin-bank"><span class="fin-acct-icon" aria-hidden="true">' + Hub.icons.bank + '</span>' +
          '<span class="fin-acct-main"><span class="fin-acct-name">' + esc(it.inst) + (it.private ? '<span class="fin-tag">' + Hub.icons.lock + 'Only me</span>' : '') + '</span>' +
          '<span class="fin-acct-sub">' + Hub.plural(n, 'account') + ' · ' + esc(Fin.ownerName(it.owner)) + '</span>' + state + '</span>' +
          '<span class="fin-bank-actions">' +
            (it.status === 'reconnect' ? '<button class="btn btn-primary btn-sm" type="button" data-reconnect="' + esc(it.id) + '">Reconnect</button>' : '') +
            '<button class="btn btn-ghost btn-sm" type="button" data-unlink="' + esc(it.id) + '">Remove</button></span></li>';
      }).join('') + '</ul>' +
      '<p class="fin-muted fin-banks-note">' + d.itemsUsed + ' of ' + d.itemsMax + ' free Plaid connections used' + (left <= 3 ? ' (' + left + ' left, for good)' : '') +
        '. If a bank needs you to sign in again, use Reconnect: removing and re-linking uses up another one.</p></section>';
  }

  var holdingsP = null;
  function holdings() { return holdingsP || (holdingsP = Hub.api('fin-holdings').catch(function (e) { holdingsP = null; throw e; })); }

  var plaidScript = null;
  function loadPlaid() {
    if (window.Plaid) return Promise.resolve();
    return plaidScript || (plaidScript = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = resolve;
      s.onerror = function () { plaidScript = null; reject(new Error('Plaid’s sign-in window couldn’t load. Check the connection and try again.')); };
      document.head.appendChild(s);
    }));
  }

  // Plaid Link: a bank sign-in window. The token and choices are kept in
  // localStorage too, for banks that send phones away and back (oauth.html).
  function openLink(token, opts) {
    try { localStorage.setItem('fin-link', JSON.stringify(Object.assign({ token: token, at: Date.now() }, opts))); } catch (e) {}
    return loadPlaid().then(function () {
      var handler = window.Plaid.create({
        token: token,
        onSuccess: function (publicToken, metadata) { finishLink(publicToken, metadata, opts); },
        onExit: function (err) {
          try { localStorage.removeItem('fin-link'); } catch (e) {}
          if (err) Hub.toast(err.display_message || 'The bank sign-in didn’t finish. Try again.', true);
        }
      });
      handler.open();
    });
  }
  function finishLink(publicToken, metadata, opts) {
    try { localStorage.removeItem('fin-link'); } catch (e) {}
    var inst = (metadata && metadata.institution) || {};
    Hub.toast(opts.itemId ? 'Reconnecting…' : 'Bringing in your ' + (inst.name || 'bank') + ' accounts…');
    var req = opts.itemId
      ? Fin.save('fin-reconnected', { body: { itemId: opts.itemId } })
      : Fin.save('fin-link', { body: { publicToken: publicToken, institution: { name: inst.name, institution_id: inst.institution_id }, owner: opts.owner, private: opts.private } });
    req.then(function () {
      Fin.invalidateTx && Fin.invalidateTx();
      Hub.toast(opts.itemId ? 'Reconnected' : (inst.name || 'Bank') + ' linked. Older transactions can take a few minutes to arrive.');
    }).catch(function (e) { Hub.toast(e.message, true); });
  }

  function linkBank() {
    var d = Fin.data;
    if (!d.setup.plaid) { Hub.toast('Bank linking needs Plaid keys in Vercel first.', true); return; }
    var left = d.itemsMax - d.itemsUsed;
    if (left <= 0) { Hub.confirm({ title: 'No free connections left', body: '<p>All ' + d.itemsMax + ' of Plaid’s free bank connections have been used. You can still add accounts by hand.</p>', confirm: 'OK' }); return; }
    var me = d.viewer.email, other = otherPerson();
    var owners = [['joint', 'Joint']].concat((d.people || []).map(function (p) { return [p.email, p.name]; }));
    var m = document.createElement('div');
    m.className = 'hub-modal';
    m.innerHTML = '<div class="hub-modal-box cal-form" role="dialog" aria-modal="true" aria-labelledby="lk-title"><h3 id="lk-title">Link a bank</h3>' +
      '<p class="fin-muted">You’ll sign in to your bank in Plaid’s window. Finance only reads balances and transactions: it can’t move money.</p>' +
      '<form novalidate><label class="field"><span>Whose accounts are these?</span><select name="owner">' + owners.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('') + '</select>' +
      '<small>You can change each account afterward.</small></label>' +
      '<label class="cf-check"><input type="checkbox" name="private" /> Only me</label>' +
      '<small class="fin-muted fin-private-note" hidden>Only you will see these accounts. ' + (other ? esc(other.name) + ' won’t.' : '') + '</small>' +
      '<p class="fin-link-note">' + Hub.icons.lock + '<span>This uses 1 of your ' + d.itemsMax + ' free Plaid connections (' + left + ' left, and they don’t come back). Link a joint account from just one of your logins.</span></p>' +
      '<div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Continue to Plaid</button></div></form></div>';
    var form = $('form', m), el = form.elements;
    el.private.addEventListener('change', function () {
      el.owner.disabled = el.private.checked;
      if (el.private.checked) el.owner.value = me;
      $('.fin-private-note', m).hidden = !el.private.checked;
    });
    function close() { m.remove(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    $('[data-cancel]', m).addEventListener('click', close);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('[type=submit]', m); btn.disabled = true;
      var opts = { owner: el.owner.value, private: el.private.checked };
      Hub.api('fin-link-token', { body: {} }).then(function (r) { close(); return openLink(r.linkToken, opts); })
        .catch(function (err) { Hub.toast(err.message, true); btn.disabled = false; });
    });
    document.body.appendChild(m);
    el.owner.focus();
  }

  function reconnect(itemId) {
    Hub.api('fin-link-token', { body: { itemId: itemId } }).then(function (r) { return openLink(r.linkToken, { itemId: itemId }); })
      .catch(function (e) { Hub.toast(e.message, true); });
  }

  function unlink(itemId) {
    var it = (Fin.data.items || []).filter(function (i) { return i.id === itemId; })[0];
    if (!it) return;
    Hub.confirm({ title: 'Remove ' + it.inst + '?', danger: true, confirm: 'Remove',
      body: '<p>Finance stops syncing it. Its accounts stay as accounts you keep by hand, with their history, so you can delete or update them yourself.</p>' +
        '<p><strong>This doesn’t give the Plaid connection back.</strong> Linking this bank again uses another of your ' + Fin.data.itemsMax + '. If it just needs you to sign in again, cancel and use Reconnect.</p>' }).then(function (yes) {
      if (!yes) return;
      Fin.save('fin-item', { method: 'DELETE', query: { id: itemId } }).then(function () { Hub.toast(it.inst + ' removed'); })
        .catch(function (e) { Hub.toast(e.message, true); });
    });
  }

  function refresh(btn) {
    btn.disabled = true;
    Hub.api('fin-sync', { body: { live: true } }).then(function (data) {
      Fin.invalidateTx && Fin.invalidateTx(); Fin.apply(data);
      Hub.toast(data.synced ? 'Up to date' : 'Synced in the last few minutes. Try again shortly.');
    }).catch(function (e) { Hub.toast(e.message, true); btn.disabled = false; });
  }

  /* ---------- one account, in the drawer ---------- */
  function openAccount(id) {
    var a = find(id);
    if (!a) { openId = null; Fin.closeDrawer(); return; }
    openId = id;
    var manual = a.src !== 'plaid', owe = Fin.sideOf(a) === 'liability';
    var facts = [
      ['Kind', groupOf(a) + (a.type === 'vehicle' ? ' (vehicle)' : a.type === 'mortgage' ? ' (mortgage)' : '')],
      ['Whose', Fin.ownerName(a.owner) + (a.private ? ', only you can see it' : '')],
      a.inst ? ['Institution', a.inst + (a.mask ? ' ••' + a.mask : '')] : null,
      a.apr != null ? [owe ? 'Interest rate' : 'Interest rate (APY)', a.apr + '%'] : null,
      a.limit ? ['Credit limit', Fin.money(a.limit) + ' · ' + Math.round((a.balance || 0) / a.limit * 100) + '% used'] : null,
      a.minPayment ? ['Minimum payment', Fin.money(a.minPayment) + ' a month'] : null,
      a.dueDate ? ['Payment due', new Date(a.dueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + (a.overdue ? ' (overdue)' : '')] : null,
      a.statementBalance != null && a.type === 'credit' ? ['Last statement', Fin.money(a.statementBalance, { cents: true })] : null,
      a.available != null && a.type === 'cash' && a.available !== a.balance ? ['Available now', Fin.money(a.available, { cents: true })] : null,
      a.inNetWorth === false ? ['Net worth', 'Not counted'] : null,
      a.notes ? ['Notes', a.notes] : null
    ].filter(Boolean);
    var body = Fin.openDrawer(nameOf(a),
      '<div><span class="fin-label">' + (owe ? 'Owed' : 'Balance') + '</span>' +
        '<div class="fin-kpi-value">' + Fin.amt(a.balance, { cents: true }) + '</div>' +
        '<span class="fin-muted">' + (a.asOf ? (manual ? 'Updated ' : 'Synced ') + Fin.ago(a.asOf) : '') + '</span></div>' +
      (manual ? '<form class="fin-balance-form" data-balance><label class="field"><span>Update ' + (owe ? 'amount owed' : a.type === 'vehicle' || a.type === 'property' ? 'value' : 'balance') + '</span>' +
        '<span class="fin-inline"><input class="input" name="balance" inputmode="decimal" value="' + esc(Fin.moneyInput(a.balance)) + '" aria-label="New balance" />' +
        '<button class="btn btn-primary btn-sm" type="submit">Save</button></span></label></form>' : '') +
      '<div><span class="fin-label">The last 12 months</span><div data-acct-chart></div></div>' +
      '<dl class="fin-facts">' + facts.map(function (f) { return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>'; }).join('') + '</dl>' +
      (!manual && (a.type === 'investment' || a.type === 'retirement') ? '<div data-holdings><span class="fin-label">Holdings</span><p class="fin-muted">Loading…</p></div>' : '') +
      '<div class="fin-drawer-actions"><button class="btn btn-ghost btn-sm" type="button" data-edit>' + Hub.icons.edit + 'Edit details</button>' +
        (manual ? '<button class="btn btn-danger btn-sm" type="button" data-delete>' + Hub.icons.trash + 'Delete</button>' : '') + '</div>');

    // Its month-ends (dashed where typed in) and today.
    var byM = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byM[e.m] = e; });
    var labels = [], titles = [], vals = [], est = [], now = Fin.monthDate(Fin.data.today.slice(0, 7));
    for (var k = 12; k >= 1; k--) {
      var d = new Date(now.getFullYear(), now.getMonth() - k, 1), e = byM[Fin.monthKey(d)];
      labels.push(d.toLocaleDateString('en-US', { month: 'short' }));
      titles.push('End of ' + d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
      vals.push(e && e.b[a.id] != null ? e.b[a.id] : null);
      est.push(!!(e && (e.est === true || (Array.isArray(e.est) && e.est.indexOf(a.id) > -1))));
    }
    labels.push('Now'); titles.push('Today'); vals.push(a.balance || 0); est.push(false);
    var chart = $('[data-acct-chart]', body);
    if (vals.filter(function (v) { return v != null; }).length < 2) chart.innerHTML = '<p class="fin-muted">Its history fills in month by month, or type past months in with “Edit past months”.</p>';
    else FinCharts.line(chart, { labels: labels, titles: titles, est: est, height: 150, table: false,
      format: function (v) { return Fin.money(v); }, axisFormat: function (v) { return Fin.money(v, { compact: true }); },
      series: [{ name: owe ? 'Owed' : 'Balance', color: owe ? 'var(--fc-2)' : 'var(--accent)', values: vals }],
      ariaLabel: nameOf(a) + ', balance at the end of each of the last 12 months' });

    var hold = $('[data-holdings]', body);
    if (hold) holdings().then(function (h) {
      var mine = h.holdings.filter(function (x) { return x.acct === a.id; }).sort(function (x, y) { return (y.value || 0) - (x.value || 0); });
      if (!mine.length) { hold.innerHTML = '<span class="fin-label">Holdings</span><p class="fin-muted">Plaid hasn’t sent holdings for this account.</p>'; return; }
      hold.innerHTML = '<span class="fin-label">Holdings</span><ul class="fin-holdings">' + mine.map(function (x) {
        var s = h.securities[x.security] || {};
        var gain = x.cost != null && x.value != null ? x.value - x.cost : null;
        return '<li><span class="fin-acct-main"><span class="fin-acct-name">' + esc(s.ticker || s.name || 'Holding') + '</span><span class="fin-acct-sub">' + esc(s.ticker ? s.name || '' : s.type || '') + '</span></span>' +
          '<span class="fin-acct-right"><span class="fin-acct-bal">' + Fin.amt(x.value) + '</span>' +
          (gain != null ? '<span class="fin-acct-sub">' + (gain >= 0 ? 'Up ' : 'Down ') + Fin.amt(Math.abs(gain)) + '</span>' : '') + '</span></li>';
      }).join('') + '</ul>';
    }).catch(function () { hold.innerHTML = '<span class="fin-label">Holdings</span><p class="fin-muted">Couldn’t load holdings.</p>'; });

    var form = $('[data-balance]', body);
    if (form) form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = Fin.parseMoney(form.elements.balance.value);
      if (v == null || isNaN(v)) { Hub.toast('Enter the balance as a number, like 12,500.', true); return; }
      var btn = $('button', form); btn.disabled = true;
      Fin.save('fin-balance', { body: { id: a.id, balance: v } }).then(function () { Hub.toast('Balance updated'); })
        .catch(function (err) { Hub.toast(err.message, true); btn.disabled = false; });
    });
    $('[data-edit]', body).addEventListener('click', function () { accountForm(a); });
    var del = $('[data-delete]', body);
    if (del) del.addEventListener('click', function () {
      Hub.confirm({ title: 'Delete “' + nameOf(a) + '”?', danger: true, confirm: 'Delete',
        body: '<p>It comes off Finance for both of you, along with its past balances, so past months’ net worth changes too. To keep its history, set its balance to 0 or hide it instead.</p>' }).then(function (yes) {
        if (!yes) return;
        Fin.save('fin-account', { method: 'DELETE', query: { id: a.id } }).then(function () { Fin.closeDrawer(); Hub.toast('Deleted'); })
          .catch(function (err) { Hub.toast(err.message, true); });
      });
    });
  }

  /* ---------- add / edit form ---------- */
  function accountForm(a) {
    var isNew = !a, linked = a && a.src === 'plaid';
    var me = Fin.data.viewer.email, other = otherPerson();
    var side = a ? Fin.sideOf(a) : null;
    var kinds = KINDS.map(function (g) {
      var opts = g[1].filter(function (k) { return !linked || Fin.TYPES[k[0]].side === side; });
      return opts.length ? '<optgroup label="' + esc(g[0]) + '">' + opts.map(function (k) { return '<option value="' + k[0] + '">' + esc(k[1]) + '</option>'; }).join('') + '</optgroup>' : '';
    }).join('');
    var owners = [['joint', 'Joint']].concat((Fin.data.people || []).map(function (p) { return [p.email, p.name]; }));
    var m = document.createElement('div');
    m.className = 'hub-modal';
    m.innerHTML = '<div class="hub-modal-box cal-form fin-form" role="dialog" aria-modal="true" aria-labelledby="af-title">' +
      '<h3 id="af-title">' + (isNew ? 'Add an asset or debt' : 'Edit ' + esc(nameOf(a))) + '</h3>' +
      '<form novalidate>' +
        (linked
          ? '<label class="field"><span>Nickname</span><input class="input" name="nick" maxlength="80" placeholder="' + esc(a.name) + '" /></label>'
          : '<label class="field"><span>Name</span><input class="input" name="name" maxlength="80" placeholder="Our Honda, Grandma’s CD, Student loan…" /></label>') +
        '<label class="field"><span>Kind</span><select name="type">' + kinds + '</select></label>' +
        (linked ? '' : '<label class="field"><span data-bal-label>Balance</span><input class="input" name="balance" inputmode="decimal" placeholder="0" /><small data-bal-hint></small></label>') +
        (linked ? '' : '<label class="field"><span>Institution</span><input class="input" name="inst" maxlength="80" placeholder="Optional" /></label>') +
        '<label class="field"><span>Whose</span><select name="owner">' + owners.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="cf-check"><input type="checkbox" name="private" /> Only me</label>' +
        '<small class="fin-muted fin-private-note" hidden>Only you will see it. ' + (other ? esc(other.name) + ' won’t, and it won’t count in their totals.' : 'No one else will.') + '</small>' +
        '<div class="fin-form-grid">' +
          '<label class="field" data-show="rate"><span data-rate-label>Interest rate (%)</span><input class="input" name="apr" inputmode="decimal" placeholder="Optional" /></label>' +
          '<label class="field" data-show="credit"><span>Credit limit</span><input class="input" name="limit" inputmode="decimal" placeholder="Optional" /></label>' +
          '<label class="field" data-show="owe"><span>Minimum payment</span><input class="input" name="minPayment" inputmode="decimal" placeholder="Optional" /></label>' +
        '</div>' +
        '<label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="500" placeholder="Optional"></textarea></label>' +
        '<label class="cf-check"><input type="checkbox" name="inNetWorth" /> Count toward net worth</label>' +
        (isNew ? '' : '<label class="cf-check"><input type="checkbox" name="hidden" /> Hide this account</label>') +
        '<p class="cf-error" role="alert" hidden></p>' +
        '<div class="hub-modal-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">' + (isNew ? 'Add' : 'Save') + '</button></div>' +
      '</form></div>';
    var f = $('form', m), el = f.elements;
    if (linked) el.nick.value = a.nick || '';
    else { el.name.value = a ? a.name : ''; el.inst.value = a ? a.inst || '' : ''; el.balance.value = a ? Fin.moneyInput(a.balance) : ''; }
    el.type.value = a ? a.type : 'cash';
    el.owner.value = a ? a.owner : 'joint';
    el.private.checked = !!(a && a.private);
    el.apr.value = a && a.apr != null ? a.apr : '';
    el.limit.value = a ? Fin.moneyInput(a.limit) : '';
    el.minPayment.value = a ? Fin.moneyInput(a.minPayment) : '';
    el.notes.value = a ? a.notes || '' : '';
    el.inNetWorth.checked = !a || a.inNetWorth !== false;
    if (el.hidden) el.hidden.checked = !!(a && a.hidden);

    function sync() {
      var t = el.type.value, owe = Fin.TYPES[t].side === 'liability';
      $$('[data-show]', m).forEach(function (x) {
        var s = x.getAttribute('data-show');
        x.hidden = !(s === 'owe' ? owe : s === 'credit' ? t === 'credit' : owe || t === 'cash');
      });
      $('[data-rate-label]', m).textContent = owe ? 'Interest rate (APR %)' : 'Interest rate (APY %)';
      if (!linked) {
        $('[data-bal-label]', m).textContent = owe ? 'Amount owed' : t === 'vehicle' || t === 'property' ? 'What it’s worth today' : 'Balance';
        var hint = t === 'vehicle' ? 'A private-party value from Kelley Blue Book or Edmunds works well.' : t === 'property' ? 'A recent estimate, like Zillow or an appraisal.' : '';
        var h = $('[data-bal-hint]', m); h.textContent = hint; h.hidden = !hint;
      }
      el.owner.disabled = el.private.checked;
      if (el.private.checked) el.owner.value = me;
      $('.fin-private-note', m).hidden = !el.private.checked;
    }
    el.type.addEventListener('change', sync);
    el.private.addEventListener('change', sync);
    sync();

    function close() { m.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    $('[data-cancel]', m).addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = $('.cf-error', m);
      function bad(msg) { err.textContent = msg; err.hidden = false; }
      var t = el.type.value, owe = Fin.TYPES[t].side === 'liability';
      var balance = linked ? null : Fin.parseMoney(el.balance.value);
      var limit = t === 'credit' ? Fin.parseMoney(el.limit.value) : null;
      var minPayment = owe ? Fin.parseMoney(el.minPayment.value) : null;
      var apr = el.apr.value.trim() === '' || $('[data-show="rate"]', m).hidden ? null : Number(el.apr.value.replace('%', ''));
      if (!linked && !el.name.value.trim()) return bad('Give it a name.');
      if (!linked && (balance == null || isNaN(balance))) return bad('Enter the ' + (owe ? 'amount owed' : 'balance') + ' as a number, like 12,500. Use 0 if it’s empty.');
      if ([limit, minPayment].some(function (v) { return v != null && isNaN(v); })) return bad('The credit limit and minimum payment should be amounts, like 250.');
      if (apr != null && (isNaN(apr) || apr < 0 || apr > 100)) return bad('The interest rate should be a percent, like 5.9.');
      var payload = {
        id: a ? a.id : undefined, type: t, owner: el.owner.value, private: el.private.checked,
        apr: apr, limit: limit, minPayment: minPayment, notes: el.notes.value, inNetWorth: el.inNetWorth.checked, hidden: el.hidden ? el.hidden.checked : false
      };
      if (linked) payload.nick = el.nick.value;
      else { payload.name = el.name.value; payload.inst = el.inst.value; payload.balance = balance; }
      var btn = $('[type=submit]', m); btn.disabled = true; err.hidden = true;
      Fin.save('fin-account', { body: payload }).then(function () {
        close();
        Hub.toast(isNew ? 'Added ' + (linked ? '' : payload.name) : 'Saved');
      }).catch(function (e2) { bad(e2.message); btn.disabled = false; });
    });
    document.body.appendChild(m);
    (linked ? el.nick : el.name).focus();
  }

  /* ---------- past months grid ---------- */
  function months12() {
    var now = Fin.monthDate(Fin.data.today.slice(0, 7)), out = [];
    for (var k = 12; k >= 1; k--) out.push(Fin.monthKey(new Date(now.getFullYear(), now.getMonth() - k, 1)));
    return out;
  }
  function monthLabel(m, long) {
    var d = Fin.monthDate(m);
    return long ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : d.toLocaleDateString('en-US', { month: 'short' }) + ' ’' + String(d.getFullYear()).slice(2);
  }

  function renderHistory(view) {
    var accts = Fin.data.accounts.filter(function (a) { return !a.hidden; }).sort(byGroupThenName);
    var months = months12();
    var byM = {};
    (Fin.data.snapshots.monthly || []).forEach(function (e) { byM[e.m] = e; });
    function stored(a, m) { var e = byM[m]; return e && e.b[a.id] != null ? e.b[a.id] : null; }
    function isEst(a, m) { var e = byM[m]; return !!(e && (e.est === true || (Array.isArray(e.est) && e.est.indexOf(a.id) > -1))); }

    view.innerHTML = '<section class="fin-card fin-history">' +
      '<div class="fin-card-head"><div><h2>Past month-end balances</h2>' +
        '<p class="fin-muted">What each account held on the last day of each month, from old statements. Typed amounts show dashed on the graph. Leave a box empty if you don’t know. “Fill back” copies an account’s oldest amount into the empty months before it.</p></div>' +
        '<div class="hub-actions"><button class="btn btn-ghost btn-sm" type="button" data-back>' + Hub.icons.left + 'Back to accounts</button>' +
        '<button class="btn btn-primary btn-sm" type="button" data-save disabled>Save</button></div></div>' +
      (accts.length ? '<div class="fin-grid-wrap"><table class="fin-grid"><thead><tr><th scope="col">Account</th>' +
        months.map(function (m) { return '<th scope="col">' + esc(monthLabel(m)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        accts.map(function (a) {
          var owe = Fin.sideOf(a) === 'liability';
          return '<tr data-row="' + esc(a.id) + '"><th scope="row"><span class="fin-grid-name">' + esc(nameOf(a)) + '</span>' +
            '<span class="fin-grid-sub">' + esc(groupOf(a)) + (owe ? ' · owed' : '') + '</span>' +
            '<button class="fin-fillback" type="button" data-fill="' + esc(a.id) + '">Fill back</button></th>' +
            months.map(function (m) {
              var k = a.id + '|' + m, v = k in dirty ? dirty[k] : stored(a, m);
              var cls = 'fin-cell' + (k in dirty ? ' is-dirty' : isEst(a, m) ? ' is-est' : '');
              return '<td><input class="' + cls + '" inputmode="decimal" autocomplete="off" data-k="' + esc(k) + '" value="' + esc(Fin.moneyInput(v)) + '" aria-label="' + esc(nameOf(a) + ', end of ' + monthLabel(m, true)) + '" /></td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody><tfoot><tr><th scope="row">Net worth</th>' + months.map(function (m) { return '<td data-total="' + m + '"></td>'; }).join('') + '</tr></tfoot></table></div>'
        : '<p class="fin-muted">Add an account first, then come back to fill in its past months.</p>') +
    '</section>';

    var wrap = $('.fin-grid-wrap', view);
    if (!wrap) return;
    wrap.scrollLeft = wrap.scrollWidth;

    function valueOf(input) {
      var v = Fin.parseMoney(input.value);
      return isNaN(v) ? NaN : v;
    }
    function totals() {
      months.forEach(function (m) {
        var sum = 0, any = false;
        accts.forEach(function (a) {
          if (a.inNetWorth === false) return;
          var input = view.querySelector('[data-k="' + a.id + '|' + m + '"]'), v = valueOf(input);
          if (v == null || isNaN(v)) return;
          any = true; sum += Fin.sideOf(a) === 'liability' ? -v : v;
        });
        view.querySelector('[data-total="' + m + '"]').innerHTML = any ? Fin.amt(sum) : '–';
      });
      $('[data-save]', view).disabled = !Object.keys(dirty).length || !!view.querySelector('.fin-cell.is-bad');
    }
    function mark(input) {
      var k = input.getAttribute('data-k'), id = k.split('|')[0], m = k.split('|')[1];
      var a = find(id), v = valueOf(input), orig = stored(a, m);
      input.classList.toggle('is-bad', isNaN(v));
      if (isNaN(v)) return;
      if (v === orig) delete dirty[k]; else dirty[k] = v;
      input.classList.toggle('is-dirty', k in dirty);
      if (k in dirty) input.classList.remove('is-est');
    }
    // On the grid's own section, which is rebuilt with each redraw (the view isn't).
    var sec = $('.fin-history', view);
    sec.addEventListener('input', function (e) {
      if (!e.target.classList.contains('fin-cell')) return;
      mark(e.target);
      totals();
    });
    sec.addEventListener('change', function (e) {
      if (!e.target.classList.contains('fin-cell')) return;
      var v = valueOf(e.target);
      if (v != null && !isNaN(v)) e.target.value = Fin.moneyInput(v);
    });
    totals();
  }

  function fillBack(view, id) {
    var cells = $$('[data-row="' + id + '"] .fin-cell', view);
    var first = -1;
    for (var i = 0; i < cells.length; i++) if (cells[i].value.trim()) { first = i; break; }
    if (first < 0) {
      var a = find(id);
      if (!a) return;
      first = cells.length; // nothing typed: copy today's balance into every month
      cells.forEach(function (c) { c.value = Fin.moneyInput(a.balance || 0); });
    } else {
      var v = Fin.parseMoney(cells[first].value);
      if (v == null || isNaN(v)) return;
      for (var j = 0; j < first; j++) cells[j].value = Fin.moneyInput(v);
    }
    cells.forEach(function (c) { c.dispatchEvent(new Event('input', { bubbles: true })); });
  }

  function saveHistory(btn) {
    var rows = Object.keys(dirty).map(function (k) { var p = k.split('|'); return { id: p[0], m: p[1], v: dirty[k] }; });
    if (!rows.length) return;
    btn.disabled = true;
    // Fin.save redraws the grid from the saved data, so the edits are cleared
    // first, and put back if the save fails.
    var pending = dirty;
    dirty = {};
    Fin.save('fin-backfill', { body: { rows: rows } }).then(function () { Hub.toast('Past months saved'); })
      .catch(function (e) { dirty = pending; Fin.rerender(); Hub.toast(e.message, true); });
  }

  /* ---------- tab ---------- */
  Fin.tab('accounts', function (view) {
    if (mode === 'history') renderHistory(view); else renderList(view);
    if (openId && $('#drawer').classList.contains('open')) openAccount(openId);
  });

  // One click handler for the tab; the view element is the same across redraws.
  document.addEventListener('click', function (e) {
    var view = $('#view');
    if (!view || !view.contains(e.target) || location.hash.replace('#', '') !== 'accounts') return;
    var t = e.target.closest('[data-add],[data-history],[data-acct],[data-back],[data-save],[data-fill],[data-link],[data-reconnect],[data-unlink],[data-refresh]');
    if (!t) return;
    if (t.hasAttribute('data-link')) linkBank();
    else if (t.hasAttribute('data-reconnect')) reconnect(t.getAttribute('data-reconnect'));
    else if (t.hasAttribute('data-unlink')) unlink(t.getAttribute('data-unlink'));
    else if (t.hasAttribute('data-refresh')) refresh(t);
    else if (t.hasAttribute('data-add')) accountForm(null);
    else if (t.hasAttribute('data-history')) { mode = 'history'; Fin.rerender(); window.scrollTo({ top: 0 }); }
    else if (t.hasAttribute('data-acct')) openAccount(t.getAttribute('data-acct'));
    else if (t.hasAttribute('data-fill')) fillBack(view, t.getAttribute('data-fill'));
    else if (t.hasAttribute('data-save')) saveHistory(t);
    else if (t.hasAttribute('data-back')) {
      var leave = function () { dirty = {}; mode = 'list'; Fin.rerender(); };
      if (!Object.keys(dirty).length) return leave();
      Hub.confirm({ title: 'Leave without saving?', body: '<p>The amounts you typed haven’t been saved.</p>', confirm: 'Leave', danger: true }).then(function (yes) { if (yes) leave(); });
    }
  });
  window.addEventListener('beforeunload', function (e) { if (Object.keys(dirty).length) { e.preventDefault(); e.returnValue = ''; } });

  Fin.openAccountForm = function () { Fin.go('accounts'); accountForm(null); };
  Fin.linkBank = linkBank;
  Fin.openHistory = function () { mode = 'history'; Fin.go('accounts'); };
})();
