/* ============================================================
   Finance page shell (window.Fin): loads the summary, draws the
   section navigation (a sidebar on wide screens; on phones a bottom
   bar, with the rest in a "More" sheet that is the same sidebar), the
   person filter and the hide-amounts toggle. Each section's file
   registers its renderer with Fin.tab(id, function (view, Fin) { ... }).
   Sections are hash routes (#overview, #reports/cashflow, ...).
   Amounts are integer cents throughout.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;

  var I = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  // Section icons the hub doesn't have.
  var NAV_ICONS = {
    repeat: I('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
    target: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>'),
    gauge: I('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
    chart: I('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
    more: I('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>')
  };
  var icon = function (name) { return NAV_ICONS[name] || Hub.icons[name] || ''; };

  // In sidebar order, under three headings.
  var TABS = [
    { id: 'overview', label: 'Overview', group: 'Money', icon: 'home' },
    { id: 'transactions', label: 'Transactions', group: 'Money', icon: 'list' },
    { id: 'accounts', label: 'Accounts', group: 'Money', icon: 'bank' },
    { id: 'recurring', label: 'Recurring', group: 'Plan', icon: 'repeat' },
    { id: 'budgets', label: 'Budgets', group: 'Plan', icon: 'wallet' },
    { id: 'goals', label: 'Goals', group: 'Plan', icon: 'target' },
    { id: 'reports', label: 'Reports', group: 'Insights', icon: 'chart' },
    { id: 'credit', label: 'Credit', group: 'Insights', icon: 'gauge' },
    { id: 'advice', label: 'Advice', group: 'Insights', icon: 'sparkle' }
  ];
  // The phone's bottom bar; the rest are under "More".
  var PHONE_TABS = ['overview', 'transactions', 'budgets', 'reports'];
  // Old links keep working.
  var ALIASES = { plan: 'budgets' };

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
    apply: function (data) { Fin.data = data; drawSync(); drawBadges(); Fin.rerender(); },
    // id: a section, optionally with a sub-page ("reports/cashflow").
    go: function (id) { if (location.hash === '#' + id) show(current()); else location.hash = id; },
    // Is this section on screen? And the part after the slash, if any.
    at: function (id) { return current() === id; },
    sub: function () { return location.hash.replace('#', '').split('/')[1] || ''; },
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
    var id = location.hash.replace('#', '').split('/')[0];
    id = ALIASES[id] || id;
    return TABS.some(function (t) { return t.id === id; }) ? id : 'overview';
  }

  function show(id) {
    var view = $('#view');
    var tab = TABS.filter(function (t) { return t.id === id; })[0];
    $('#title').textContent = tab.label;
    document.title = tab.label + ' · Finance · Randall Family';
    view.innerHTML = '';
    if (renderers[id]) renderers[id](view, Fin);
    markNav(id);
  }

  /* ---------- section navigation ---------- */
  function drawNav() {
    var groups = [];
    TABS.forEach(function (t) { if (groups.indexOf(t.group) < 0) groups.push(t.group); });
    $('#tabs').innerHTML = groups.map(function (g) {
      return '<div class="fin-nav-group"><h3>' + esc(g) + '</h3><ul>' + TABS.filter(function (t) { return t.group === g; }).map(function (t) {
        return '<li><a class="fin-nav-item" href="#' + t.id + '" data-tab="' + t.id + '">' + icon(t.icon) + '<span>' + esc(t.label) + '</span><span class="fin-badge" data-badge="' + t.id + '" hidden></span></a>' +
          (t.id === 'reports' ? '<ul class="fin-nav-sub" data-sub="reports" hidden></ul>' : '') + '</li>';
      }).join('') + '</ul></div>';
    }).join('');
    $('#bottom').innerHTML = PHONE_TABS.map(function (id) {
      var t = TABS.filter(function (x) { return x.id === id; })[0];
      return '<a class="fin-bottom-item" href="#' + id + '" data-tab="' + id + '">' + icon(t.icon) + '<span>' + esc(t.label) + '</span><span class="fin-dot" data-dot="' + id + '" hidden></span></a>';
    }).join('') + '<button class="fin-bottom-item" type="button" data-more aria-haspopup="dialog" aria-controls="side">' + icon('more') + '<span>More</span><span class="fin-dot" data-dot="more" hidden></span></button>';
    $('#bottom').addEventListener('click', function (e) { if (e.target.closest('[data-more]')) openSide(); });
    // A link to the section already open draws it again (e.g. back to the top of a report).
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a.fin-nav-item, a.fin-bottom-item, .fin-nav-sub a');
      if (!a) return;
      closeSide();
      if (location.hash === a.getAttribute('href')) { e.preventDefault(); show(current()); window.scrollTo({ top: 0 }); }
    });
    window.addEventListener('hashchange', function () { closeSide(); show(current()); window.scrollTo({ top: 0 }); });
  }

  // The open section, and the open report under Reports.
  function markNav(id) {
    $$('[data-tab]').forEach(function (a) {
      if (a.getAttribute('data-tab') === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var more = $('[data-more]');
    if (more) more.classList.toggle('on', PHONE_TABS.indexOf(id) < 0);
    var sub = $('[data-sub="reports"]');
    if (sub) {
      var list = Fin.reports || [], on = Fin.currentReport ? Fin.currentReport() : '';
      sub.hidden = id !== 'reports' || !list.length;
      sub.innerHTML = list.map(function (r) {
        return '<li><a href="#reports/' + r[0] + '"' + (r[0] === on ? ' aria-current="page"' : '') + '>' + esc(r[1]) + '</a></li>';
      }).join('');
    }
  }

  // Counts beside sections: transactions to review, found bills to confirm,
  // banks to sign in to again. Phones get a dot on the bottom bar instead.
  function drawBadges() {
    var d = Fin.data;
    var counts = {
      transactions: d.toReview || 0,
      recurring: (d.recurring || []).filter(function (r) { return r.status === 'detected' && !r.ended; }).length,
      accounts: (d.items || []).filter(function (i) { return i.status === 'reconnect'; }).length
    };
    $$('[data-badge]').forEach(function (b) {
      var id = b.getAttribute('data-badge'), n = counts[id] || 0;
      b.hidden = !n;
      b.textContent = !n ? '' : id === 'accounts' ? '!' : n;
      b.classList.toggle('warn', id === 'accounts');
      b.title = id === 'transactions' ? Hub.plural(n, 'transaction') + ' to look over' : id === 'recurring' ? Hub.plural(n, 'regular charge') + ' to confirm' : Hub.plural(n, 'bank') + ' to reconnect';
    });
    var dot = function (id, on) { var x = $('[data-dot="' + id + '"]'); if (x) x.hidden = !on; };
    dot('transactions', counts.transactions > 0);
    dot('more', counts.recurring > 0 || counts.accounts > 0);
  }

  // Phones: the sidebar opens as a sheet from the bottom. fin-side-anim
  // turns the slide on just for the open or close.
  var sideFocus = null, animTimer;
  function animateSide() {
    document.body.classList.add('fin-side-anim');
    clearTimeout(animTimer);
    animTimer = setTimeout(function () { document.body.classList.remove('fin-side-anim'); }, 350);
  }
  function openSide() {
    sideFocus = document.activeElement;
    animateSide();
    document.body.classList.add('fin-side-open');
    $('#side').setAttribute('role', 'dialog');
    $('#side').setAttribute('aria-modal', 'true');
    var first = $('#side-close');
    if (first) first.focus();
  }
  function closeSide() {
    if (!document.body.classList.contains('fin-side-open')) return;
    animateSide();
    document.body.classList.remove('fin-side-open');
    $('#side').removeAttribute('role');
    $('#side').removeAttribute('aria-modal');
    if (sideFocus && document.contains(sideFocus)) sideFocus.focus();
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
        drawShowing(opts);
        Fin.rerender();
      }
    });
    drawShowing(opts);
  }
  // Phones: the filter lives in the More sheet, so the page head says when
  // it's narrowed to one person (a tap opens the sheet to change it).
  function drawShowing(opts) {
    var chip = $('#showing'), cur = opts.filter(function (o) { return o[0] === Fin.person; })[0];
    chip.hidden = Fin.person === 'all';
    chip.innerHTML = '<span>Showing</span> ' + esc(cur ? cur[1] : '');
  }

  // Two buttons, one setting: the labeled one in the sidebar, and on phones
  // an eye in the page head, so hiding amounts is one tap away.
  function drawHide() {
    var btn = $('#hide'), quick = $('#hide-quick'), hidden = false;
    try { hidden = localStorage.getItem('fin-hide') === '1'; } catch (e) {}
    // The label says what a tap does: "Hide amounts", or "Show amounts"
    // while they're blurred.
    function apply() {
      document.body.classList.toggle('fin-hidden', hidden);
      var title = hidden ? 'Dollar amounts are blurred. Tap to show them.' : 'Blur every dollar amount, for when someone can see your screen';
      btn.classList.toggle('on', hidden);
      btn.title = title;
      btn.innerHTML = (hidden ? Hub.icons.eyeOff : Hub.icons.eye) + '<span>' + (hidden ? 'Show amounts' : 'Hide amounts') + '</span>';
      quick.classList.toggle('on', hidden);
      quick.title = title;
      quick.setAttribute('aria-label', hidden ? 'Show amounts' : 'Hide amounts');
      quick.setAttribute('aria-pressed', String(hidden));
      quick.innerHTML = hidden ? Hub.icons.eyeOff : Hub.icons.eye;
    }
    function toggle() {
      hidden = !hidden;
      try { localStorage.setItem('fin-hide', hidden ? '1' : '0'); } catch (e) {}
      apply();
    }
    btn.addEventListener('click', toggle);
    quick.addEventListener('click', toggle);
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
    $('#side-close').innerHTML = Hub.icons.x;
    $('#side-close').addEventListener('click', closeSide);
    $('#side-backdrop').addEventListener('click', closeSide);
    $('#showing').addEventListener('click', openSide);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || document.querySelector('.hub-modal')) return;
      if (document.body.classList.contains('fin-side-open') && !$('#person').classList.contains('open')) closeSide();
      else closeDrawer();
    });
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
        drawNav();
        drawPeople();
        drawHide();
        drawSync();
        drawBadges();
        show(current());
        autoSync();
      }).catch(function (e) {
        $('#view').innerHTML = '<div class="hub-empty"><h3>Couldn’t load Finance</h3><p>' + esc(e.message) + '</p><button class="btn btn-ghost" type="button" onclick="location.reload()">Try again</button></div>';
      });
    });
  });
})();
