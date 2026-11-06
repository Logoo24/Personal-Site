/* ============================================================
   Finance > Advice: a monthly briefing written by Claude from the
   household's own numbers (with today's savings, Treasury and CD
   rates looked up on the web), above a set of plain checks worked
   out in code (api/_family/finance/advice.js). Educational, not
   personalized financial advice - the banner says so on every view.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, esc = Hub.esc;
  var data = null, loading = null, autoTried = false;
  var TONES = [['do', 'Do next'], ['watch', 'Keep an eye on'], ['info', 'Good to know'], ['good', 'Going well']];
  var ICON = { do: Hub.icons.arrow, watch: Hub.icons.up, info: Hub.icons.sparkle, good: Hub.icons.check };

  function load(force) {
    if (data && !force) return Promise.resolve(data);
    return loading || (loading = Hub.api('fin-advice').then(function (d) { data = d; loading = null; return d; }, function (e) { loading = null; throw e; }));
  }
  var oldInvalidate = Fin.invalidateTx;
  Fin.invalidateTx = function () { data = null; if (oldInvalidate) oldInvalidate(); };

  function banner() {
    return '<div class="fin-banner fin-advice-note">' + Hub.icons.lock + '<span><b>Educational guidance from your own numbers, not personalized financial advice.</b> Claude isn’t a licensed advisor. For big decisions (investing, taxes, insurance), talk to a fiduciary professional.</span></div>';
  }

  function briefingHTML(d) {
    var b = d.briefing;
    if (!d.claude) return '<section class="fin-card fin-briefing"><h2>Monthly briefing</h2><p class="fin-muted">Written briefings need <code>ANTHROPIC_API_KEY</code> in Vercel. The checks below work without it.</p></section>';
    if (!b && !d.ready) return '<section class="fin-card fin-briefing"><h2>Monthly briefing</h2><p class="fin-muted">Your first briefing is written once there are accounts to look at. Link a bank or add an account on the Accounts tab.</p></section>';
    if (!b) return '<section class="fin-card fin-briefing is-loading"><h2>Writing your briefing…</h2><p class="fin-muted">Looking up today’s savings and Treasury rates and reading your numbers. This takes a little while.</p></section>';
    var when = new Date(b.at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    var list = function (title, items, render) {
      return items && items.length ? '<div class="fin-brief-sec"><h3>' + esc(title) + '</h3>' + render(items) + '</div>' : '';
    };
    return '<section class="fin-card fin-briefing">' +
      '<span class="fin-label">Your ' + esc(new Date(b.at).toLocaleDateString('en-US', { month: 'long' })) + ' briefing</span>' +
      '<h2 class="fin-brief-head">' + Fin.amtText(b.headline) + '</h2>' +
      '<p class="fin-brief-summary">' + Fin.amtText(b.summary) + '</p>' +
      list('Where to put money now', b.putMoney, function (xs) {
        return '<ol class="fin-brief-list">' + xs.map(function (x) {
          return '<li><b>' + Fin.amtText(x.title) + '</b>' + (x.amount ? ' <span class="fin-brief-amt fin-amt">' + esc(x.amount) + '</span>' : '') + '<p>' + Fin.amtText(x.why) + '</p></li>';
        }).join('') + '</ol>';
      }) +
      '<div class="fin-row">' +
        list('Spend less on', b.spendLess, function (xs) { return '<ul class="fin-brief-list">' + xs.map(function (x) { return '<li><b>' + Fin.amtText(x.title) + '</b><p>' + Fin.amtText(x.why) + '</p></li>'; }).join('') + '</ul>'; }) +
        list('Worth spending on', b.spendMore, function (xs) { return '<ul class="fin-brief-list">' + xs.map(function (x) { return '<li><b>' + Fin.amtText(x.title) + '</b><p>' + Fin.amtText(x.why) + '</p></li>'; }).join('') + '</ul>'; }) +
      '</div>' +
      '<div class="fin-row">' +
        list('Going well', b.doingWell, function (xs) { return '<ul class="fin-brief-bullets good">' + xs.map(function (x) { return '<li>' + Hub.icons.check + '<span>' + esc(x) + '</span></li>'; }).join('') + '</ul>'; }) +
        list('Keep an eye on', b.watch, function (xs) { return '<ul class="fin-brief-bullets">' + xs.map(function (x) { return '<li>' + Hub.icons.up + '<span>' + esc(x) + '</span></li>'; }).join('') + '</ul>'; }) +
      '</div>' +
      '<div class="fin-brief-foot"><span class="fin-muted">Written ' + esc(when) + (b.rates ? ' · rates as of ' + esc(new Date(b.rates.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '') + '</span>' +
        (b.rates && b.rates.sources && b.rates.sources.length ? '<span class="fin-brief-sources">Sources: ' + b.rates.sources.map(function (s) {
          return '<a href="' + esc(/^https?:\/\//.test(s.url) ? s.url : '#') + '" target="_blank" rel="noopener noreferrer">' + esc(hostOf(s.url)) + '</a>';
        }).join(', ') + '</span>' : '') +
        '<button class="btn btn-ghost btn-sm" type="button" data-advice-refresh' + (d.refreshesLeft ? '' : ' disabled title="Five briefings a day"') + '>' + Hub.icons.refresh + 'Write a new one</button></div>' +
      (d.error ? '<p class="fin-muted">' + esc(d.error) + '</p>' : '') +
    '</section>';
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'source'; } }

  function cardsHTML(cards) {
    return TONES.map(function (t) {
      var mine = cards.filter(function (c) { return c.tone === t[0]; });
      if (!mine.length) return '';
      return '<section class="fin-card"><div class="fin-card-head"><h2>' + esc(t[1]) + '</h2></div><ul class="fin-checks-list">' + mine.map(function (c) {
        return '<li class="fin-check-card ' + t[0] + '"><span class="fin-check-icon">' + ICON[t[0]] + '</span><div><b>' + Fin.amtText(c.title) + '</b><p>' + Fin.amtText(c.body) + '</p>' +
          (c.numbers && c.numbers.length ? '<dl class="fin-check-nums">' + c.numbers.map(function (n) { return '<div><dt>' + esc(n[0]) + '</dt><dd class="fin-amt">' + esc(n[1]) + '</dd></div>'; }).join('') + '</dl>' : '') +
        '</div></li>';
      }).join('') + '</ul></section>';
    }).join('');
  }

  function factsHTML(f) {
    var m = f.monthly, rows = [
      ['Income, a month (last 3)', '$' + m.income3.toLocaleString()],
      ['Spending, a month (last 3)', '$' + m.spending3.toLocaleString()],
      ['Savings rate (last 6)', m.savingsRate6 != null ? m.savingsRate6 + '%' : '–'],
      ['Essentials, a month', '$' + m.essentialSpending3.toLocaleString()],
      ['Cash', '$' + f.cash.total.toLocaleString()],
      ['Emergency fund', f.cash.emergencyMonths != null ? f.cash.emergencyMonths + ' months of essentials' : '–'],
      ['Debts', f.debts.length ? f.debts.map(function (d) { return d.name + (d.apr != null ? ' ' + d.apr + '%' : ''); }).join(', ') : 'None'],
      ['Card use', f.creditCardUse || '–'],
      ['Bills and subscriptions', '$' + f.billsPerMonth.toLocaleString() + ' a month']
    ];
    return '<details class="fin-card fin-hidden-accts"><summary>The numbers behind this</summary>' +
      '<p class="fin-muted" style="margin:0.5rem 0">Worked out from the accounts you can see. Only totals like these (no account numbers or transactions) go to Claude for the briefing.</p>' +
      '<dl class="fin-facts">' + rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd class="fin-amt">' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl></details>';
  }

  function render(view) {
    view.innerHTML = banner() + '<p class="hub-loading">Working through your numbers…</p>';
    load().then(function (d) {
      if (location.hash.replace('#', '') !== 'advice') return;
      view.innerHTML = banner() + briefingHTML(d) + cardsHTML(d.cards) + factsHTML(d.facts);
      // A briefing a month: write one when there's none yet or it's from an earlier month.
      var stale = !d.briefing || d.briefing.month !== Fin.data.today.slice(0, 7);
      if (d.claude && d.ready && stale && d.refreshesLeft && !autoTried) { autoTried = true; refresh(null, true); }
    }).catch(function (e) {
      view.innerHTML = banner() + '<p class="fin-muted">Couldn’t work out the advice: ' + esc(e.message) + '</p>';
    });
  }

  function refresh(btn, auto) {
    if (btn) btn.disabled = true;
    if (data) { data.briefing = auto ? data.briefing : null; if (!auto) Fin.rerender(); }
    return Hub.api('fin-advice', { body: { refresh: true } }).then(function (d) {
      data = d; Fin.rerender();
      if (!auto) Hub.toast('New briefing written');
    }).catch(function (e) {
      Hub.toast(e.message, true);
      load(true).then(function () { Fin.rerender(); });
    });
  }

  Fin.tab('advice', render);
  document.addEventListener('click', function (e) {
    if (location.hash.replace('#', '') !== 'advice') return;
    var b = e.target.closest('[data-advice-refresh]');
    if (b && $('#view').contains(b)) refresh(b);
  });
})();
