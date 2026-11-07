/* ============================================================
   Finance page shell (window.Fin): loads the summary, draws the
   tabs (#overview, #transactions, ...), the person filter and the
   hide-amounts toggle. Each tab's file registers its renderer with
   Fin.tab(id, function (view, Fin) { ... }); tabs without one show
   what's coming. Amounts are integer cents throughout.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;

  var TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'transactions', label: 'Transactions', soon: 'Every transaction from your linked accounts, with search, categories, and a review queue for anything new.' },
    { id: 'accounts', label: 'Accounts', soon: 'Link your banks, cards and investments, and add the things Plaid can’t see: a car, a home, loans, cash.' },
    { id: 'recurring', label: 'Recurring', soon: 'Bills, subscriptions and paychecks, found automatically, with what’s due in the next 30 days.' },
    { id: 'plan', label: 'Budgets & goals', soon: 'Monthly budgets by category and savings goals, with how you’re pacing.' },
    { id: 'credit', label: 'Credit', soon: 'Your credit scores over time, and how much of your card limits you’re using.' },
    { id: 'reports', label: 'Reports', soon: 'Cash flow, spending by category, income, merchants, net worth, debt payoff and more.' },
    { id: 'advice', label: 'Advice', soon: 'A monthly briefing from your own numbers: where to put money now, and what to spend less or more on.' }
  ];

  // Mirrors ACCOUNT_TYPES in api/_family/finance/data.js.
  var TYPES = {
    cash: { side: 'asset', group: 'Cash' },
    investment: { side: 'asset', group: 'Investments' },
    retirement: { side: 'asset', group: 'Retirement' },
    property: { side: 'asset', group: 'Property & vehicles' },
    vehicle: { side: 'asset', group: 'Property & vehicles' },
    'other-asset': { side: 'asset', group: 'Other assets' },
    credit: { side: 'liability', group: 'Credit cards' },
    loan: { side: 'liability', group: 'Loans' },
    mortgage: { side: 'liability', group: 'Loans' },
    'other-debt': { side: 'liability', group: 'Other debts' }
  };

  /* ---------- money ---------- */
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var usdK = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  // opts: cents (show cents), sign (a + on positives), compact ($12.4K at 10,000 and up)
  function money(c, opts) {
    opts = opts || {};
    var v = Math.round(c || 0) / 100, a = Math.abs(v);
    var s = opts.compact && a >= 10000 ? usdK.format(a) : (opts.cents ? usd2 : usd0).format(a);
    var zero = opts.cents ? a < 0.005 : a < 0.5;
    return (v < 0 && !zero ? '−' : opts.sign && v > 0 && !zero ? '+' : '') + s;
  }
  function amt(c, opts) { return '<span class="fin-amt">' + esc(money(c, opts)) + '</span>'; }
  // A sentence with dollar figures in it ("Move about $1,209 out of checking"):
  // escaped, with each figure wrapped so "hide amounts" blurs it too.
  function amtText(s) {
    return esc(s).replace(/[\u2212-]?\$\d[\d,]*(?:\.\d+)?(?:[KMB]\b)?/g, function (m) { return '<span class="fin-amt">' + m + '</span>'; });
  }
  // What goes in a money text box: "12,500" or "12,500.50", no dollar sign.
  function moneyInput(c) {
    if (c == null || c === '') return '';
    var v = Math.round(c) / 100;
    return v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  // "$12,500.50" / "12500.5" / " 12,500 " -> 1250050 cents; '' -> null; anything else -> NaN.
  function parseMoney(s) {
    s = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!s) return null;
    if (!/^\d*\.?\d{0,2}$/.test(s) || s === '.') return NaN;
    return Math.round(parseFloat(s) * 100);
  }
  // An account's contribution to net worth: what you owe counts against it.
  function signed(a) { return (TYPES[a.type] || {}).side === 'liability' || a.side === 'liability' ? -(a.balance || 0) : (a.balance || 0); }
  function sideOf(a) { return a.side || (TYPES[a.type] || {}).side || 'asset'; }

  /* ---------- dates ---------- */
  function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function monthKey(d) { return dayKey(d).slice(0, 7); }
  function monthDate(m) { return new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1); }
  function ago(iso) {
    var m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  }

  /* ---------- state ---------- */
  var renderers = {};
  var Fin = window.Fin = {
    data: null,
    person: 'all',
    TYPES: TYPES, money: money, amt: amt, amtText: amtText, amountsHidden: function () { return document.body.classList.contains('fin-hidden'); }, moneyInput: moneyInput, parseMoney: parseMoney, signed: signed, sideOf: sideOf,
    dayKey: dayKey, monthKey: monthKey, monthDate: monthDate, ago: ago,
    tab: function (id, render) { renderers[id] = render; },
    // Calls a route that answers with a fresh summary, then redraws.
    save: function (r, opts) {
      return Hub.api(r, opts).then(function (data) { Fin.apply(data); return data; });
    },
    apply: function (data) { Fin.data = data; drawSync(); Fin.rerender(); },
    go: function (id) { if (location.hash === '#' + id) show(id); else location.hash = id; },
    openDrawer: openDrawer, closeDrawer: closeDrawer,
    // Accounts that match the person filter and count toward totals.
    accounts: function () {
      return (Fin.data.accounts || []).filter(function (a) { return !a.hidden && a.inNetWorth !== false && Fin.matches(a); });
    },
    matches: function (a) {
      return Fin.person === 'all' || (Fin.person === 'joint' ? a.owner === 'joint' : a.owner === Fin.person);
    },
    ownerName: function (owner) {
      if (owner === 'joint') return 'Joint';
      var p = (Fin.data.people || []).filter(function (x) { return x.email === owner; })[0];
      return p ? p.name : 'Someone';
    },
    rerender: function () { show(current()); },
    menu: menu
  };

  /* ---------- drop-down menus ---------- */
  // A drop-down of choices, each with a line saying what it is: the
  // "Showing" menu and the Reports picker. o: { id, label, ariaLabel,
  // change (the button's aria-label ending), options: [[key, name, line]],
  // value, pick(key) }.
  function menu(wrap, o) {
    wrap.classList.add('fin-menu');
    wrap.innerHTML =
      '<button class="fin-menu-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="' + o.id + '">' +
        '<span class="fin-menu-k">' + esc(o.label) + '</span><span class="fin-menu-v"></span>' + Hub.icons.down +
      '</button>' +
      '<div class="fin-menu-list" id="' + o.id + '" role="menu" aria-label="' + esc(o.ariaLabel) + '">' +
        o.options.map(function (x) {
          return '<button type="button" role="menuitemradio" aria-checked="false" data-key="' + esc(x[0]) + '">' +
            '<span class="fin-menu-check">' + Hub.icons.check + '</span>' +
            '<span><strong>' + esc(x[1]) + '</strong><small>' + esc(x[2]) + '</small></span>' +
          '</button>';
        }).join('') +
      '</div>';
    var btn = $('.fin-menu-btn', wrap), items = $$('[data-key]', wrap), value = o.value;

    function mark() {
      var cur = o.options.filter(function (x) { return x[0] === value; })[0] || o.options[0];
      $('.fin-menu-v', wrap).textContent = cur[1];
      btn.setAttribute('aria-label', o.label + ' ' + cur[1] + '. ' + o.change);
      items.forEach(function (x) { x.setAttribute('aria-checked', String(x.getAttribute('data-key') === value)); });
    }
    function open() {
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      (items.filter(function (x) { return x.getAttribute('aria-checked') === 'true'; })[0] || items[0]).focus();
    }
    function close(refocus) {
      if (!closeMenu(wrap)) return;
      if (refocus) btn.focus();
    }

    btn.addEventListener('click', function () { if (wrap.classList.contains('open')) close(); else open(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.classList.contains('open')) { e.stopPropagation(); close(true); return; }
      if (e.target === btn) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
        return;
      }
      var i = items.indexOf(document.activeElement);
      if (i < 0) return;
      var to = e.key === 'ArrowDown' ? (i + 1) % items.length
        : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
      if (to >= 0) { e.preventDefault(); items[to].focus(); }
      else if (e.key === 'Tab') close();
    });
    items.forEach(function (x) {
      x.addEventListener('click', function () {
        value = x.getAttribute('data-key');
        mark();
        close(true);
        o.pick(value);
      });
    });
    mark();
  }
  function closeMenu(wrap) {
    if (!wrap.classList.contains('open')) return false;
    wrap.classList.remove('open');
    $('.fin-menu-btn', wrap).setAttribute('aria-expanded', 'false');
    return true;
  }
  // One listener for every menu, including ones a tab draws again: a click
  // outside closes it. Capture phase, so a click on the hub's user menu
  // (which stops the click from bubbling) still closes it.
  document.addEventListener('click', function (e) {
    $$('.fin-menu.open').forEach(function (m) { if (!m.contains(e.target)) closeMenu(m); });
  }, true);

  /* ---------- side drawer (the calendar's, bottom sheet on phones) ---------- */
  var lastFocus = null;
  function openDrawer(title, html) {
    if (!$('#drawer').classList.contains('open')) lastFocus = document.activeElement;
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = html;
    $('#drawer').classList.add('open'); $('#backdrop').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawer-close').focus();
    return $('#drawer-body');
  }
  function closeDrawer() {
    if (!$('#drawer').classList.contains('open')) return;
    $('#drawer').classList.remove('open'); $('#backdrop').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function current() {
    var id = location.hash.replace('#', '');
    return TABS.some(function (t) { return t.id === id; }) ? id : 'overview';
  }

  function show(id) {
    $$('.fin-tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === id)); });
    var view = $('#view');
    var tab = TABS.filter(function (t) { return t.id === id; })[0];
    view.innerHTML = '';
    if (renderers[id]) return renderers[id](view, Fin);
    view.innerHTML = '<div class="fin-soon"><h2>' + esc(tab.label) + ' is coming soon</h2><p>' + esc(tab.soon) + '</p></div>';
  }

  function drawTabs() {
    $('#tabs').innerHTML = TABS.map(function (t) {
      return '<button class="fin-tab" type="button" role="tab" data-tab="' + t.id + '" aria-selected="false">' + esc(t.label) + '</button>';
    }).join('');
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      if (location.hash !== '#' + b.getAttribute('data-tab')) location.hash = b.getAttribute('data-tab');
      else show(b.getAttribute('data-tab'));
    });
    window.addEventListener('hashchange', function () { show(current()); window.scrollTo({ top: 0 }); });
  }

  // The "Showing" drop-down: whose accounts every tab counts. Each choice
  // has a line saying what it includes.
  function personOptions() {
    var me = (Fin.data.viewer || {}).email;
    return [['all', 'Everyone', 'Both of you and your joint accounts, added together']]
      .concat((Fin.data.people || []).map(function (p) {
        return [p.email, p.name, p.email === me ? 'Only the accounts in your name' : 'Only the accounts in ' + p.name + '’s name'];
      }), [['joint', 'Joint', 'Only the accounts you share']]);
  }

  function drawPeople() {
    var opts = personOptions();
    try { Fin.person = localStorage.getItem('fin-person') || 'all'; } catch (e) {}
    if (!opts.some(function (o) { return o[0] === Fin.person; })) Fin.person = 'all';
    menu($('#person'), {
      id: 'person-menu', label: 'Showing', ariaLabel: 'Whose accounts to show', change: 'Change whose accounts are shown',
      options: opts, value: Fin.person,
      pick: function (key) {
        Fin.person = key;
        try { localStorage.setItem('fin-person', Fin.person); } catch (err) {}
        Fin.rerender();
      }
    });
  }

  function drawHide() {
    var btn = $('#hide'), hidden = false;
    try { hidden = localStorage.getItem('fin-hide') === '1'; } catch (e) {}
    // The label says what a tap does: "Hide amounts", or "Show amounts"
    // while they're blurred.
    function apply() {
      document.body.classList.toggle('fin-hidden', hidden);
      btn.classList.toggle('on', hidden);
      btn.title = hidden ? 'Dollar amounts are blurred. Tap to show them.' : 'Blur every dollar amount, for when someone can see your screen';
      btn.innerHTML = (hidden ? Hub.icons.eyeOff : Hub.icons.eye) + '<span>' + (hidden ? 'Show amounts' : 'Hide amounts') + '</span>';
    }
    btn.addEventListener('click', function () {
      hidden = !hidden;
      try { localStorage.setItem('fin-hide', hidden ? '1' : '0'); } catch (e) {}
      apply();
    });
    apply();
  }

  function drawSync() {
    var d = Fin.data, el = $('#sync');
    var reconnect = (d.items || []).filter(function (i) { return i.status === 'reconnect'; }).length;
    el.textContent = reconnect ? Hub.plural(reconnect, 'bank') + ' to reconnect'
      : d.lastSync ? 'Synced ' + ago(d.lastSync)
      : d.accounts.length ? 'Balances you’ve entered' : 'Nothing linked yet';
  }

  // Banks sync daily on their own (the cron); opening Finance after 6 hours
  // without one syncs in the background, then redraws.
  function autoSync() {
    var d = Fin.data;
    if (!d.setup.plaid || !(d.items || []).length) return;
    if (d.lastSync && Date.now() - new Date(d.lastSync) < 6 * 3600 * 1000) return;
    $('#sync').textContent = 'Syncing your banks…';
    Hub.api('fin-sync', { body: {} }).then(function (data) {
      if (data.synced) { if (Fin.invalidateTx) Fin.invalidateTx(); Fin.apply(data); } else drawSync();
    }).catch(function () { drawSync(); });
  }

  // The tab row sticks just under the hub bar, whose height depends on the screen.
  function measureBar() {
    var bar = $('.hub-bar');
    if (bar) document.body.style.setProperty('--fin-bar', bar.offsetHeight + 'px');
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#drawer-close').innerHTML = Hub.icons.x;
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#backdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !document.querySelector('.hub-modal')) closeDrawer(); });
    // On paper the charts' tables print too: a closed <details> prints nothing.
    var opened = [];
    window.addEventListener('beforeprint', function () {
      opened = $$('#view details:not([open])');
      opened.forEach(function (d) { d.open = true; });
    });
    window.addEventListener('afterprint', function () {
      opened.forEach(function (d) { d.open = false; });
      opened = [];
    });
    Hub.ready(function () {
      measureBar();
      window.addEventListener('resize', measureBar);
      Hub.api('fin-summary').then(function (data) {
        Fin.data = data;
        drawTabs();
        drawPeople();
        drawHide();
        drawSync();
        show(current());
        autoSync();
      }).catch(function (e) {
        $('#view').innerHTML = '<div class="hub-empty"><h3>Couldn’t load Finance</h3><p>' + esc(e.message) + '</p><button class="btn btn-ghost" type="button" onclick="location.reload()">Try again</button></div>';
      });
    });
  });
})();
