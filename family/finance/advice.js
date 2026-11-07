/* ============================================================
   Finance > Advice: a monthly briefing written by Claude from the
   household's own numbers (with today's savings, Treasury and CD
   rates looked up on the web), above a set of plain checks worked
   out in code (api/_family/finance/advice.js), and a box for asking
   Claude about any of it. Educational, not personalized financial
   advice - the banner says so on every view.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, esc = Hub.esc;
  var data = null, loading = null, autoTried = false, autoFailed = null;
  // This visit's questions and answers, oldest first: { q, a, sources, error, pending }.
  // Kept across tab switches, gone on reload (the server keeps only a count).
  var thread = [], draft = '';
  var IDEAS = ['What should we do first this month?', 'How do I open a high-yield savings account?', 'Roth or traditional IRA for us?', 'How much should our emergency fund be?'];
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
    if (!b && autoFailed) return '<section class="fin-card fin-briefing"><h2>Monthly briefing</h2><p class="fin-muted">' + esc(autoFailed) + '</p>' +
      '<div class="fin-brief-foot"><button class="btn btn-ghost btn-sm" type="button" data-advice-refresh' + (d.refreshesLeft ? '' : ' disabled') + '>' + Hub.icons.refresh + 'Try again</button></div></section>';
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
          return '<li><b>' + Fin.amtText(x.title) + '</b>' + (x.amount ? ' <span class="fin-brief-amt fin-amt">' + esc(x.amount) + '</span>' : '') + '<p>' + Fin.amtText(x.why) + '</p>' + askAbout(x.title) + '</li>';
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
          askAbout(c.title) +
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
      '<p class="fin-muted" style="margin:0.5rem 0">Worked out from the accounts you can see. Totals like these, with account, goal and merchant names, go to Claude for the briefing and your questions. Never account numbers or your list of transactions.</p>' +
      '<dl class="fin-facts">' + rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd class="fin-amt">' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl></details>';
  }

  /* ---------- asking about it ---------- */
  var canAsk = function () { return data && data.claude && data.ready; };
  // An "Ask about this" link under a briefing item or a check: fills the box.
  function askAbout(title) {
    return canAsk() ? '<button class="fin-link fin-ask-about" type="button" data-ask-about="' + esc(title) + '">Ask about this</button>' : '';
  }

  function askHTML(d) {
    if (!canAsk()) return '';
    return '<section class="fin-card fin-ask" id="fin-ask">' +
      '<div class="fin-card-head"><h2>Ask about your advice</h2></div>' +
      '<p class="fin-muted">Ask Claude to explain a step, go into more detail, or walk you through doing it. It sees the same numbers as the briefing, never account numbers or your list of transactions.</p>' +
      '<div class="fin-ask-thread" aria-live="polite">' + threadHTML() + '</div>' +
      '<form class="fin-ask-form" data-ask-form>' +
        '<textarea id="fin-ask-q" rows="2" maxlength="1000" aria-label="Your question about the advice" placeholder="e.g. How much should we move into savings, and where?">' + esc(draft) + '</textarea>' +
        '<div class="fin-ask-foot"><span class="fin-muted" data-ask-left>' + leftText(d.asksLeft) + '</span>' +
          '<button class="btn btn-primary btn-sm" type="submit"' + (busy() || !d.asksLeft ? ' disabled' : '') + '>' + Hub.icons.sparkle + 'Ask</button></div>' +
      '</form>' +
      (thread.length ? '' : '<div class="fin-ask-ideas">' + IDEAS.map(function (q) { return '<button class="chip" type="button" data-ask-idea>' + esc(q) + '</button>'; }).join('') + '</div>') +
    '</section>';
  }
  function leftText(n) { return n ? n + ' question' + (n === 1 ? '' : 's') + ' left today' : 'No questions left today'; }
  function busy() { return thread.some(function (t) { return t.pending; }); }

  function threadHTML() {
    return thread.map(function (t) {
      return '<div class="fin-ask-turn"><p class="fin-ask-q">' + esc(t.q) + '</p>' +
        (t.pending ? '<div class="fin-ask-a is-loading"><span class="fin-muted">Thinking it through…</span></div>'
          : t.error ? '<div class="fin-ask-a"><p class="fin-muted">' + esc(t.error) + '</p></div>'
          : '<div class="fin-ask-a">' + answerHTML(t.a) + sourcesHTML(t.sources) + '</div>') +
      '</div>';
    }).join('');
  }
  // Claude's answer: escaped first, figures wrapped for "hide amounts", then
  // **bold**, "- " and "1. " lists, and paragraphs. Nothing else becomes markup.
  function answerHTML(text) {
    var out = [], list = null;
    function inline(s) { return Fin.amtText(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
    function endList() { if (list) { out.push('</' + list + '>'); list = null; } }
    String(text).split('\n').forEach(function (line) {
      var m = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
      if (m) {
        var tag = m[1] ? 'ul' : 'ol';
        if (list !== tag) { endList(); out.push('<' + tag + (tag === 'ol' && +m[2] > 1 ? ' start="' + +m[2] + '"' : '') + '>'); list = tag; }
        out.push('<li>' + inline(m[3]) + '</li>');
      } else if (!line.trim()) endList();
      else { endList(); out.push('<p>' + inline(line) + '</p>'); }
    });
    endList();
    return out.join('');
  }
  function sourcesHTML(sources) {
    sources = (sources || []).filter(function (s) { return /^https?:\/\//.test(s.url); });
    if (!sources.length) return '';
    return '<p class="fin-brief-sources">Sources: ' + sources.map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(hostOf(s.url)) + '</a>';
    }).join(', ') + '</p>';
  }

  // Redraws just the thread and the box's footer, so the text box keeps its focus.
  function drawAsk() {
    var box = $('#fin-ask');
    if (!box) return;
    $('.fin-ask-thread', box).innerHTML = threadHTML();
    $('[data-ask-left]', box).innerHTML = leftText(data.asksLeft);
    $('.fin-ask-form [type=submit]', box).disabled = busy() || !data.asksLeft;
    var ideas = $('.fin-ask-ideas', box);
    if (ideas && thread.length) ideas.remove();
  }

  function ask(q) {
    q = q.trim();
    if (!q || busy() || !data.asksLeft) return;
    var history = thread.filter(function (t) { return t.a; }).slice(-6).map(function (t) { return { q: t.q, a: t.a }; });
    var turn = { q: q, pending: true };
    thread.push(turn);
    draft = '';
    var input = $('#fin-ask-q');
    if (input) { input.value = ''; grow(input); }
    drawAsk();
    Hub.api('fin-advice-ask', { body: { question: q, history: history } }).then(function (r) {
      turn.a = r.answer; turn.sources = r.sources; data.asksLeft = r.asksLeft;
    }, function (e) {
      turn.error = e.message;
    }).then(function () {
      turn.pending = false;
      drawAsk();
    });
  }
  function grow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px'; }

  function render(view) {
    view.innerHTML = banner() + '<p class="hub-loading">Working through your numbers…</p>';
    load().then(function (d) {
      if (!Fin.at('advice')) return;
      view.innerHTML = banner() + briefingHTML(d) + askHTML(d) + cardsHTML(d.cards) + factsHTML(d.facts);
      var input = $('#fin-ask-q', view);
      if (input) grow(input);
      // A briefing a month: write one when there's none yet or it's from an earlier month.
      var stale = !d.briefing || d.briefing.month !== Fin.data.today.slice(0, 7);
      if (d.claude && d.ready && stale && d.refreshesLeft && !autoTried) { autoTried = true; refresh(null, true); }
    }).catch(function (e) {
      view.innerHTML = banner() + '<p class="fin-muted">Couldn’t work out the advice: ' + esc(e.message) + '</p>';
    });
  }

  function refresh(btn, auto) {
    if (btn) btn.disabled = true;
    autoFailed = null;
    if (data) { data.briefing = auto ? data.briefing : null; if (!auto) Fin.rerender(); }
    return Hub.api('fin-advice', { body: { refresh: true } }).then(function (d) {
      data = d; Fin.rerender();
      if (!auto) Hub.toast('New briefing written');
    }).catch(function (e) {
      // Without this the "Writing your briefing…" card would wait forever.
      autoFailed = e.message;
      Hub.toast(e.message, true);
      load(true).then(function () { Fin.rerender(); });
    });
  }

  Fin.tab('advice', render);
  document.addEventListener('click', function (e) {
    if (!Fin.at('advice')) return;
    var b = e.target.closest('[data-advice-refresh]');
    if (b && $('#view').contains(b)) return refresh(b);
    var idea = e.target.closest('[data-ask-idea]');
    if (idea) return ask(idea.textContent);
    var about = e.target.closest('[data-ask-about]');
    if (about) {
      var input = $('#fin-ask-q');
      if (!input) return;
      input.value = draft = 'Tell me more about “' + about.getAttribute('data-ask-about') + '”: ';
      grow(input);
      $('#fin-ask').scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  document.addEventListener('submit', function (e) {
    if (!e.target.matches('[data-ask-form]')) return;
    e.preventDefault();
    ask($('#fin-ask-q').value);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'fin-ask-q') return;
    draft = e.target.value;
    grow(e.target);
  });
  // Enter asks; Shift+Enter is a new line.
  document.addEventListener('keydown', function (e) {
    if (e.target.id !== 'fin-ask-q' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    ask(e.target.value);
  });
})();
