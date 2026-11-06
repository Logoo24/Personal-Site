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
    rerender: function () { show(current()); }
  };

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

  function drawPeople() {
    var people = Fin.data.people || [];
    var opts = [['all', 'Everyone']].concat(people.map(function (p) { return [p.email, p.name]; }), [['joint', 'Joint']]);
    try { Fin.person = localStorage.getItem('fin-person') || 'all'; } catch (e) {}
    if (!opts.some(function (o) { return o[0] === Fin.person; })) Fin.person = 'all';
    var seg = $('#person');
    seg.innerHTML = opts.map(function (o) {
      return '<button type="button" data-person="' + esc(o[0]) + '" aria-pressed="' + (o[0] === Fin.person) + '"' + (o[0] === Fin.person ? ' class="on"' : '') + '>' + esc(o[1]) + '</button>';
    }).join('');
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-person]');
      if (!b) return;
      Fin.person = b.getAttribute('data-person');
      try { localStorage.setItem('fin-person', Fin.person); } catch (err) {}
      $$('[data-person]', seg).forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      Fin.rerender();
    });
  }

  function drawHide() {
    var btn = $('#hide'), hidden = false;
    try { hidden = localStorage.getItem('fin-hide') === '1'; } catch (e) {}
    function apply() {
      document.body.classList.toggle('fin-hidden', hidden);
      btn.setAttribute('aria-pressed', String(hidden));
      btn.setAttribute('aria-label', hidden ? 'Show amounts' : 'Hide amounts');
      btn.title = hidden ? 'Show amounts' : 'Hide amounts';
      btn.innerHTML = hidden ? Hub.icons.eyeOff : Hub.icons.eye;
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
