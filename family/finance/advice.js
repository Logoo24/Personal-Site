/* ============================================================
   Finance > Advice: a monthly briefing written by Claude from the
   household's own numbers (with today's savings, Treasury and CD
   rates looked up on the web), above a set of plain checks worked
   out in code (api/_family/finance/advice.js), "About you two" (the
   household details the accounts can't show: ages, pay, 401(k) match,
   filing status, plans; api/_family/finance/profile.js), and a box for
   asking Claude about any of it (it can look up exact totals and do
   payoff and growth math). Educational, not personalized financial
   advice - the banner says so on every view.
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, esc = Hub.esc;
  var data = null, loading = null, autoTried = false, autoFailed = null;
  // This visit's questions and answers, oldest first: { q, a, sources, error, pending }.
  // Kept across tab switches, gone on reload (the server keeps only a count).
  var thread = [], draft = '';
  var IDEAS = ['What should we do first this month?', 'How much did we spend on dining out the last three months?', 'What if we paid $200 a month extra on our highest-rate debt?', 'Roth or traditional IRA for us?'];
  var TONES = [['do', 'Do next'], ['watch', 'Keep an eye on'], ['info', 'Good to know'], ['good', 'Going well']];
  var ICON = { do: Hub.icons.arrow, watch: Hub.icons.up, info: Hub.icons.sparkle, good: Hub.icons.check };

  function load(force) {
    if (data && !force) return Promise.resolve(data);
    return loading || (loading = Hub.api('fin-advice').then(function (d) { data = d; loading = null; return d; }, function (e) { loading = null; throw e; }));
  }
  var oldInvalidate = Fin.invalidateTx;
  Fin.invalidateTx = function () { data = null; if (oldInvalidate) oldInvalidate(); };

  // One line, opening to the rest.
  function banner() {
    return '<details class="fin-advice-note"><summary>' + Hub.icons.lock + '<span>Educational guidance from your own numbers, not personalized financial advice</span></summary>' +
      '<p>Claude isn’t a licensed advisor. For big decisions (investing, taxes, insurance), talk to a fiduciary professional.</p></details>';
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
          return '<li><b>' + Fin.amtText(x.title) + '</b>' + (x.amount ? ' <span class="fin-brief-amt fin-amt">' + esc(x.amount) + '</span>' : '') + askAbout(x.title) + '<p>' + Fin.amtText(x.why) + '</p></li>';
        }).join('') + '</ol>';
      }) +
      '<div class="fin-row">' +
        list('Spend less on', b.spendLess, function (xs) { return '<ul class="fin-brief-list">' + xs.map(function (x) { return '<li><b>' + Fin.amtText(x.title) + '</b><p>' + Fin.amtText(x.why) + '</p></li>'; }).join('') + '</ul>'; }) +
        list('Worth spending on', b.spendMore, function (xs) { return '<ul class="fin-brief-list">' + xs.map(function (x) { return '<li><b>' + Fin.amtText(x.title) + '</b><p>' + Fin.amtText(x.why) + '</p></li>'; }).join('') + '</ul>'; }) +
      '</div>' +
      // Questions whose answers would change the advice, with a way to answer them.
      (b.toSharpen && b.toSharpen.length ? '<div class="fin-brief-sharpen"><h3>To sharpen this</h3><ul>' + b.toSharpen.map(function (q) { return '<li>' + Fin.amtText(q) + '</li>'; }).join('') + '</ul>' +
        '<button class="fin-link" type="button" data-profile-open>Add it under About you two</button></div>' : '') +
      // "Going well" and "Keep an eye on" join the checks of the same name below.
      '<div class="fin-brief-foot"><span class="fin-muted">Written ' + esc(when) + (b.rates ? ' · rates as of ' + esc(new Date(b.rates.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '') +
        ' · ' + esc(String(d.referenceYear)) + ' IRS figures' + (b.irsCheckedAt ? ', checked on irs.gov ' + esc(new Date(b.irsCheckedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '') + '</span>' +
        (b.rates && b.rates.sources && b.rates.sources.length ? '<span class="fin-brief-sources">Sources: ' + b.rates.sources.map(function (s) {
          return '<a href="' + esc(/^https?:\/\//.test(s.url) ? s.url : '#') + '" target="_blank" rel="noopener noreferrer">' + esc(hostOf(s.url)) + '</a>';
        }).join(', ') + '</span>' : '') +
        '<button class="btn btn-ghost btn-sm" type="button" data-advice-refresh' + (d.refreshesLeft ? '' : ' disabled title="Five briefings a day"') + '>' + Hub.icons.refresh + 'Write a new one</button></div>' +
      (d.error ? '<p class="fin-muted">' + esc(d.error) + '</p>' : '') +
    '</section>';
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'source'; } }

  // The checks in four groups that open and close, each with a count; "Do
  // next" and "Keep an eye on" start open. The briefing's own short "going
  // well" and "keep an eye on" notes join their group, so nothing is said twice.
  var OPEN = { do: 1, watch: 1 };
  function cardsHTML(cards, b) {
    var extra = { good: (b && b.doingWell) || [], watch: (b && b.watch) || [] };
    return TONES.map(function (t) {
      var mine = cards.filter(function (c) { return c.tone === t[0]; }), notes = extra[t[0]] || [];
      if (!mine.length && !notes.length) return '';
      return '<details class="fin-card fin-checks-group"' + (OPEN[t[0]] ? ' open' : '') + '><summary><h2>' + esc(t[1]) + '</h2><span class="fin-checks-count">' + (mine.length + notes.length) + '</span></summary>' +
        '<ul class="fin-checks-list">' + mine.map(function (c) {
          return '<li class="fin-check-card ' + t[0] + '"><span class="fin-check-icon">' + ICON[t[0]] + '</span><div><b>' + Fin.amtText(c.title) + '</b>' + askAbout(c.title) + '<p>' + Fin.amtText(c.body) + '</p>' +
            (c.numbers && c.numbers.length ? '<dl class="fin-check-nums">' + c.numbers.map(function (n) { return '<div><dt>' + esc(n[0]) + '</dt><dd class="fin-amt">' + esc(n[1]) + '</dd></div>'; }).join('') + '</dl>' : '') +
          '</div></li>';
        }).join('') + notes.map(function (x) {
          return '<li class="fin-check-card ' + t[0] + ' fin-check-note"><span class="fin-check-icon">' + ICON[t[0]] + '</span><div><p>' + Fin.amtText(x) + '</p></div></li>';
        }).join('') + '</ul></details>';
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
      '<p class="fin-muted" style="margin:0.5rem 0">Worked out from the accounts you can see. Totals like these, with account, goal and merchant names and what you put under About you two, go to Claude for the briefing and your questions; questions can also look up totals by category, merchant or month. Never account numbers or your list of transactions.</p>' +
      '<dl class="fin-facts">' + rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd class="fin-amt">' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl></details>';
  }

  /* ---------- asking about it ---------- */
  var canAsk = function () { return data && data.claude && data.ready; };
  // A small chat button beside a briefing item or a check: fills the box.
  var CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  function askAbout(title) {
    return canAsk() ? '<button class="fin-ask-about" type="button" data-ask-about="' + esc(title) + '" aria-label="Ask about “' + esc(title) + '”" title="Ask about this">' + CHAT + '</button>' : '';
  }

  function askHTML(d) {
    if (!canAsk()) return '';
    return '<section class="fin-card fin-ask" id="fin-ask">' +
      '<div class="fin-card-head"><h2>Ask about your advice</h2></div>' +
      '<p class="fin-muted">Ask Claude to explain a step or walk you through it. It sees the same numbers as the briefing and can look up exact totals (by category, merchant or month), balances and payoff math. Never account numbers or your list of transactions.</p>' +
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
          : '<div class="fin-ask-a">' + answerHTML(t.a) + lookupsHTML(t.lookups) + sourcesHTML(t.sources) + '</div>') +
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
  // What it checked in your own numbers to answer ("Spending on Dining out, Jun 2026 to Aug 2026").
  function lookupsHTML(list) {
    if (!list || !list.length) return '';
    return '<p class="fin-ask-lookups">' + Hub.icons.search + '<span>Looked up: ' + list.map(esc).join(' · ') + '</span></p>';
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
      turn.a = r.answer; turn.sources = r.sources; turn.lookups = r.lookups; data.asksLeft = r.asksLeft;
    }, function (e) {
      turn.error = e.message;
    }).then(function () {
      turn.pending = false;
      drawAsk();
    });
  }
  function grow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px'; }

  /* ---------- About you two ---------- */
  function aboutFilled(d) { return !!(d.facts && d.facts.aboutUs && d.facts.aboutUs.filled); }
  // Unfilled: an invitation near the top. Filled: a short summary near the bottom.
  function aboutHTML(d) {
    if (!aboutFilled(d)) {
      return '<section class="fin-card fin-found fin-about-ask"><div class="fin-found-text">' + Hub.icons.sparkle +
        '<span><b>Tell the advice about you two.</b> Ages, pay, your 401(k) match and what’s coming up. The checks and briefing then get specific: match you’re missing, Roth or traditional, room left this year. About two minutes.</span></div>' +
        '<div class="hub-actions"><button class="btn btn-primary btn-sm" type="button" data-profile-open>Fill it in</button></div></section>';
    }
    var a = d.facts.aboutUs, bits = [];
    a.people.forEach(function (p) {
      var x = [p.name + (p.age ? ', ' + p.age : '')];
      if (p.workRetirementPlan) x.push(p.workRetirementPlan + (p.matchLeftUnclaimedAYear > 0 ? ' (missing some match)' : p.matchLeftUnclaimedAYear === 0 && p.employerMatchAYear ? ' (full match)' : ''));
      bits.push(x.join(' · '));
    });
    if (a.filingStatus) bits.push(a.filingStatus);
    if (a.state) bits.push(a.state);
    if (a.estimatedFederalBracket) bits.push('About the ' + a.estimatedFederalBracket + ' federal bracket');
    var who = d.profile && d.profile.updatedBy ? (d.people.filter(function (p) { return p.email === d.profile.updatedBy; })[0] || {}).name : '';
    return '<section class="fin-card fin-about"><div class="fin-card-head"><h2>About you two</h2>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-profile-open>' + Hub.icons.edit + 'Edit</button></div>' +
      '<ul class="fin-about-list">' + bits.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' +
      (d.profile && d.profile.updatedAt ? '<p class="fin-muted fin-about-when">Updated ' + esc(new Date(d.profile.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) + (who ? ' by ' + esc(who) : '') + '</p>' : '') +
    '</section>';
  }

  function options(table, value, blank) {
    return (blank != null ? '<option value="">' + esc(blank) + '</option>' : '') + Object.keys(table).map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === value ? ' selected' : '') + '>' + esc(table[k]) + '</option>';
    }).join('');
  }
  var CONTRIB = { traditional: 'Traditional (pre-tax)', roth: 'Roth', both: 'Some of each', unsure: 'Not sure' };
  var YESNO = { yes: 'Yes', no: 'No', unsure: 'Not sure' };
  var IRAS = { none: 'None', roth: 'Roth IRA', traditional: 'Traditional IRA', both: 'Both' };
  function val(v) { return v == null ? '' : esc(String(v)); }

  function personFields(person, x) {
    var hasPlan = x.plan && x.plan !== 'none';
    return '<fieldset class="fin-about-person" data-person="' + esc(person.email) + '"><legend>' + esc(person.name) + '</legend>' +
      '<div class="cf-row"><label class="field"><span>Birth year</span><input class="input" name="birthYear" inputmode="numeric" maxlength="4" placeholder="1995" value="' + val(x.birthYear) + '" /></label>' +
      '<label class="field"><span>Yearly pay before taxes</span><input class="input" name="income" inputmode="decimal" placeholder="0" value="' + (x.income != null ? esc(Fin.moneyInput(x.income)) : '') + '" /></label></div>' +
      '<label class="field"><span>Retirement plan at work</span><select name="plan">' + options(data.profileOptions.plans, x.plan, 'Not set') + '</select></label>' +
      '<div class="fin-about-plan"' + (hasPlan ? '' : ' hidden') + '>' +
        '<p class="fin-about-line">The employer puts in <input class="input fin-pct" name="matchRate" inputmode="decimal" aria-label="Match percentage" placeholder="100" value="' + val(x.matchRate) + '" />% of what ' + esc(person.name) + ' puts in, up to <input class="input fin-pct" name="matchUpTo" inputmode="decimal" aria-label="Up to this percent of pay" placeholder="4" value="' + val(x.matchUpTo) + '" />% of pay.</p>' +
        '<p class="fin-muted fin-about-hint">No match? Put 0 in both. The formula is in the benefits portal, often written as “100% up to 4%” or “50% up to 6%”.</p>' +
        '<div class="cf-row"><label class="field"><span>' + esc(person.name) + ' puts in (% of pay)</span><input class="input" name="contribPct" inputmode="decimal" placeholder="6" value="' + val(x.contribPct) + '" /></label>' +
        '<label class="field"><span>As</span><select name="contribType">' + options(CONTRIB, x.contribType, 'Not set') + '</select></label></div>' +
      '</div>' +
      '<div class="cf-row"><label class="field"><span>Health plan allows an HSA</span><select name="hsa">' + options(YESNO, x.hsa, 'Not set') + '</select></label>' +
      '<label class="field"><span>IRA</span><select name="ira">' + options(IRAS, x.ira, 'Not set') + '</select></label></div>' +
      '<label class="field"><span>Put into an IRA so far for ' + esc(String(data.referenceYear)) + '</span><input class="input" name="iraThisYear" inputmode="decimal" placeholder="0" value="' + (x.iraThisYear != null ? esc(Fin.moneyInput(x.iraThisYear)) : '') + '" /></label>' +
    '</fieldset>';
  }

  function openProfile() {
    if (!data) return;
    var pr = data.profile || {}, people = data.people || [], o = data.profileOptions;
    var body = Fin.openDrawer('About you two',
      '<p class="fin-muted">What the accounts can’t show. Both of you see this, and it goes to Claude with your numbers so the advice fits you. Leave out anything you’d rather not say.</p>' +
      '<form class="fin-tx-form fin-about-form" data-profile-form novalidate>' +
        '<fieldset><legend>Your household</legend>' +
          '<div class="cf-row"><label class="field"><span>State</span><select name="state">' + options(o.states, pr.state, 'Not set') + '</select></label>' +
          '<label class="field"><span>Taxes filed as</span><select name="filing">' + options(o.filing, pr.filing, 'Not set') + '</select></label></div>' +
          '<div class="cf-row"><label class="field"><span>Kids</span><input class="input" name="kids" inputmode="numeric" maxlength="2" placeholder="0" value="' + val(pr.kids) + '" /></label>' +
          '<label class="field"><span>Investing ups and downs</span><select name="risk">' + options(o.risk, pr.risk, 'Not set') + '</select></label></div>' +
          '<label class="field"><span>Plans in the next few years</span><textarea name="plans" rows="2" maxlength="300" placeholder="Buying a house in about two years, a baby, a new car…">' + val(pr.plans) + '</textarea></label>' +
        '</fieldset>' +
        people.map(function (p) { return personFields(p, (pr.people || {})[p.email] || {}); }).join('') +
        '<p class="cf-error" role="alert" hidden></p>' +
        '<div class="fin-drawer-actions"><button class="btn btn-primary btn-sm" type="submit">' + Hub.icons.check + 'Save</button></div>' +
      '</form>');
    var form = $('[data-profile-form]', body);
    form.addEventListener('change', function (e) {
      if (e.target.name !== 'plan') return;
      $('.fin-about-plan', e.target.closest('fieldset')).hidden = !e.target.value || e.target.value === 'none';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('.cf-error', form), el = form.elements;
      function money(v) { var c = Fin.parseMoney(v); if (c != null && isNaN(c)) throw new Error('Enter amounts like 65000.'); return c == null ? null : c / 100; }
      function n(v) { v = String(v || '').replace(/[%\s,]/g, ''); if (!v) return null; if (isNaN(+v)) throw new Error('Enter numbers only, like 4 or 6.5.'); return +v; }
      var out;
      try {
        out = { state: el.state.value || null, filing: el.filing.value || null, kids: n(el.kids.value), risk: el.risk.value || null, plans: el.plans.value, people: {} };
        Hub.$$('[data-person]', form).forEach(function (fs) {
          var q = function (name) { return fs.querySelector('[name="' + name + '"]'); };
          var plan = q('plan').value;
          var x = { birthYear: n(q('birthYear').value), income: money(q('income').value), plan: plan || null, hsa: q('hsa').value || null, ira: q('ira').value || null, iraThisYear: money(q('iraThisYear').value) };
          if (plan && plan !== 'none') Object.assign(x, { matchRate: n(q('matchRate').value), matchUpTo: n(q('matchUpTo').value), contribPct: n(q('contribPct').value), contribType: q('contribType').value || null });
          out.people[fs.getAttribute('data-person')] = x;
        });
      } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
      var btn = $('[type=submit]', form); btn.disabled = true; err.hidden = true;
      Hub.api('fin-profile', { body: out }).then(function (d) {
        data = d; Fin.closeDrawer(); Fin.rerender();
        Hub.toast(d.briefing ? 'Saved. The checks use it now, and the next briefing will too.' : 'Saved');
      }).catch(function (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; });
    });
  }
  Fin.openProfile = openProfile;

  function render(view) {
    view.innerHTML = banner() + '<p class="hub-loading">Working through your numbers…</p>';
    load().then(function (d) {
      if (!Fin.at('advice')) return;
      view.innerHTML = banner() + (aboutFilled(d) ? '' : aboutHTML(d)) + briefingHTML(d) + askHTML(d) + cardsHTML(d.cards, d.briefing) + (aboutFilled(d) ? aboutHTML(d) : '') + factsHTML(d.facts);
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
      if (!auto) Hub.toast(e.message, true); // an automatic one says so on its card
      load(true).then(function () { Fin.rerender(); });
    });
  }

  Fin.tab('advice', render);
  document.addEventListener('click', function (e) {
    if (!Fin.at('advice')) return;
    var b = e.target.closest('[data-advice-refresh]');
    if (b && $('#view').contains(b)) return refresh(b);
    if (e.target.closest('[data-profile-open]') && $('#view').contains(e.target)) return openProfile();
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
