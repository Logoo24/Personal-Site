/* ============================================================
   Finance > Credit: each person's credit score over time (typed in,
   or read from a screenshot by Claude), where it sits in its model's
   bands, a monthly reminder, and how much of the credit cards'
   limits is in use (from the cards' balances and limits).
   ============================================================ */
(function () {
  'use strict';
  var $ = Hub.$, $$ = Hub.$$, esc = Hub.esc;
  var FICO = [[300, 579, 'Poor'], [580, 669, 'Fair'], [670, 739, 'Good'], [740, 799, 'Very good'], [800, 850, 'Exceptional']];
  var VANTAGE = [[300, 499, 'Very poor'], [500, 600, 'Poor'], [601, 660, 'Fair'], [661, 780, 'Good'], [781, 850, 'Excellent']];

  function bandsFor(model) { return /vantage/i.test(model || '') ? VANTAGE : FICO; }
  function bandOf(score, model) {
    var b = bandsFor(model);
    for (var i = 0; i < b.length; i++) if (score <= b[i][1]) return { i: i, name: b[i][2] };
    return { i: b.length - 1, name: b[b.length - 1][2] };
  }
  function people() { return Fin.data.people || []; }
  function scoresOf(email) { return (Fin.data.credit || []).filter(function (c) { return c.person === email; }); }
  function latest(email) { var s = scoresOf(email); return s[s.length - 1] || null; }
  function day(d, opts) { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' }); }
  function daysSince(d) { return Math.round((new Date(Fin.data.today + 'T12:00:00') - new Date(d + 'T12:00:00')) / 864e5); }

  // A score's place on its model's scale: five steps, light to dark, with a marker.
  function bandBar(score, model) {
    var b = bandsFor(model), lo = 300, hi = 850;
    var pos = Math.max(0, Math.min(1, (score - lo) / (hi - lo))) * 100, here = bandOf(score, model);
    return '<div class="fin-band" role="img" aria-label="' + esc(score + ', ' + here.name + ' on a scale from 300 to 850') + '">' +
      '<div class="fin-band-track">' + b.map(function (x, i) {
        return '<span class="fin-band-seg b' + (i + 1) + '" style="flex:' + (x[1] - x[0] + 1) + '"></span>';
      }).join('') + '<span class="fin-band-mark" style="left:' + pos + '%"></span></div>' +
      // The ends of the scale, and only the current band's name (the others
      // are too narrow to label without cutting words off).
      (function () {
        var at = Math.max(12, Math.min(88, ((b[here.i][0] + b[here.i][1]) / 2 - lo) / (hi - lo) * 100));
        // An end number the band name would run into is left out.
        return '<div class="fin-band-labels"><span' + (at < 30 ? ' hidden' : '') + '>300</span><span class="on" style="left:' + at + '%">' + esc(here.name) + '</span><span' + (at > 70 ? ' hidden' : '') + '>850</span></div></div>';
      })();
  }

  function personCard(p) {
    var list = scoresOf(p.email), last = list[list.length - 1], prev = list[list.length - 2];
    if (!last) return '<section class="fin-card fin-score"><span class="fin-label">' + esc(p.name) + '</span><p class="fin-muted">No scores yet.</p>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-score-add="' + esc(p.email) + '">' + Hub.icons.plus + 'Add ' + esc(p.name) + '’s score</button></section>';
    var change = prev ? last.score - prev.score : null;
    return '<section class="fin-card fin-score"><div class="fin-card-head"><span class="fin-label">' + esc(p.name) + (last.private ? ' · only you' : '') + '</span>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-score-add="' + esc(p.email) + '">' + Hub.icons.plus + 'New score</button></div>' +
      '<div class="fin-hero"><div class="fin-hero-value fin-amt">' + last.score + '</div><div class="fin-hero-side">' +
        '<span class="fin-score-band">' + esc(bandOf(last.score, last.model).name) + '</span>' +
        (change != null ? '<span class="fin-delta ' + (change > 0 ? 'good' : change < 0 ? 'bad' : 'flat') + '">' + (change > 0 ? Hub.icons.up : change < 0 ? Hub.icons.down : '') + (change > 0 ? '+' : '') + change + ' <small>since ' + esc(day(prev.date, { month: 'short', day: 'numeric' })) + '</small></span>' : '') +
      '</div></div>' + bandBar(last.score, last.model) +
      '<p class="fin-muted">' + esc([last.model, last.bureau, last.source].filter(Boolean).join(' · ') || 'Model not noted') + ' · ' + esc(day(last.date)) + '</p></section>';
  }

  function chart(el, shown) {
    var entries = (Fin.data.credit || []).filter(function (c) { return shown.some(function (p) { return p.email === c.person; }); });
    var months = [];
    entries.forEach(function (c) { var m = c.date.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });
    months.sort();
    months = months.slice(-24);
    if (months.length < 2) { el.innerHTML = '<p class="fin-muted">The chart appears once there are two months of scores.</p>'; return; }
    var series = shown.filter(function (p) { return scoresOf(p.email).length; }).map(function (p, i) {
      return { name: p.name, color: 'var(--fc-' + (i + 1) + ')', values: months.map(function (m) {
        var inMonth = scoresOf(p.email).filter(function (c) { return c.date.slice(0, 7) === m; });
        return inMonth.length ? inMonth[inMonth.length - 1].score : null;
      }) };
    });
    FinCharts.line(el, {
      labels: months.map(function (m) { var d = Fin.monthDate(m); return d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? ' ’' + String(d.getFullYear()).slice(2) : ''); }),
      titles: months.map(function (m) { return Fin.monthDate(m).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }),
      series: series, format: function (v) { return String(v); }, axisFormat: function (v) { return String(Math.round(v)); }, height: 240,
      ariaLabel: 'Credit scores each month'
    });
  }

  // How much of the cards' limits is in use, overall and per card.
  function utilization() {
    var cards = Fin.accounts().filter(function (a) { return a.type === 'credit'; });
    if (!cards.length) return '';
    var withLimit = cards.filter(function (a) { return a.limit; });
    var bal = withLimit.reduce(function (m, a) { return m + Math.max(0, a.balance || 0); }, 0), lim = withLimit.reduce(function (m, a) { return m + a.limit; }, 0);
    function grade(p) { return p <= 0.1 ? ['ok', 'Excellent'] : p <= 0.3 ? ['ok', 'Good'] : p <= 0.5 ? ['warn', 'High'] : ['over', 'Very high']; }
    var all = lim ? bal / lim : 0, g = grade(all);
    return '<section class="fin-card"><div class="fin-card-head"><h2>Credit card use</h2><span class="fin-muted">How much of your limits you’re using</span></div>' +
      (lim ? '<div class="fin-hero"><div class="fin-hero-value">' + Math.round(all * 100) + '%</div><div class="fin-hero-side"><span class="fin-budget-status ' + g[0] + '">' + (g[0] === 'ok' ? Hub.icons.check : Hub.icons.up) + esc(g[1]) + '</span>' +
        '<span class="fin-muted"><span class="fin-amt">' + esc(Fin.money(bal)) + '</span> of <span class="fin-amt">' + esc(Fin.money(lim)) + '</span></span></div></div>' +
        '<span class="fin-meter ' + g[0] + '"><span class="fin-meter-fill" style="width:' + Math.min(100, all * 100) + '%"></span><span class="fin-meter-pace" style="left:30%" title="30%"></span></span>' : '') +
      '<ul class="fin-budgets fin-util">' + cards.map(function (a) {
        if (!a.limit) return '<li><div class="fin-budget-head"><span class="fin-budget-name">' + esc(a.nick || a.name) + '</span><span class="fin-muted">No limit noted. Add it in Accounts.</span></div></li>';
        var p = Math.max(0, a.balance || 0) / a.limit, gg = grade(p);
        return '<li><div class="fin-budget-head"><span class="fin-budget-name">' + esc(a.nick || a.name) + '</span><span class="fin-budget-nums"><b>' + Math.round(p * 100) + '%</b> <span class="fin-muted"><span class="fin-amt">' + esc(Fin.money(a.balance || 0)) + '</span> of <span class="fin-amt">' + esc(Fin.money(a.limit)) + '</span></span></span></div>' +
          '<span class="fin-meter ' + gg[0] + '"><span class="fin-meter-fill" style="width:' + Math.min(100, p * 100) + '%"></span></span></li>';
      }).join('') + '</ul>' +
      '<p class="fin-muted fin-budget-note">Under 30% is good and under 10% is better. Card companies usually report your statement balance, so paying it down before the statement closes lowers what the credit bureaus see.</p></section>';
  }

  function render(view) {
    var me = Fin.data.viewer.email, mine = latest(me);
    var shown = Fin.person === 'all' || Fin.person === 'joint' ? people() : people().filter(function (p) { return p.email === Fin.person; });
    var reminder = !mine ? 'You haven’t added a credit score yet.' : daysSince(mine.date) > 30 ? 'Your last score is from ' + day(mine.date, { month: 'long', day: 'numeric' }) + '. Most card apps update monthly.' : '';
    var hist = (Fin.data.credit || []).filter(function (c) { return shown.some(function (p) { return p.email === c.person; }); }).slice().reverse();
    view.innerHTML =
      (reminder ? '<div class="fin-alerts"><button class="fin-alert" type="button" data-score-add="' + esc(me) + '">' + Hub.icons.plus + '<span>' + esc(reminder) + ' Add it now, typed or from a screenshot.</span>' + Hub.icons.right + '</button></div>' : '') +
      '<div class="fin-row">' + shown.map(personCard).join('') + '</div>' +
      '<section class="fin-card"><div class="fin-card-head"><h2>Over time</h2></div><div data-credit-chart></div></section>' +
      utilization() +
      (hist.length ? '<section class="fin-card"><div class="fin-card-head"><h2>Every score</h2></div>' +
        '<div class="fin-table-wrap"><table class="fin-table fin-scores"><thead><tr><th>Date</th><th>Whose</th><th class="num">Score</th><th>Model</th><th>From</th></tr></thead><tbody>' +
        hist.map(function (c) {
          return '<tr class="fin-click" data-score="' + esc(c.id) + '" tabindex="0"><td>' + esc(day(c.date)) + '</td><td>' + esc(Fin.ownerName(c.person)) + (c.private ? ' <span class="fin-tag">' + Hub.icons.lock + 'Only me</span>' : '') + '</td>' +
            '<td class="num fin-amt">' + c.score + '</td><td>' + esc([c.model, c.bureau].filter(Boolean).join(' · ') || '–') + '</td><td>' + esc(c.source || '–') + '</td></tr>';
        }).join('') + '</tbody></table></div></section>' : '') +
      '<section class="fin-card fin-tips"><h2>What moves a score</h2><ul>' +
        '<li><b>Paying on time</b> matters most. Autopay for at least the minimum keeps a slip from counting against you.</li>' +
        '<li><b>Card use</b> (above) is next. Lower is better, and it bounces back as soon as balances come down.</li>' +
        '<li><b>Age of accounts.</b> Keeping old cards open, even unused, helps.</li>' +
        '<li><b>New applications</b> cause a small, temporary dip. Space them out.</li>' +
        '<li>Check your full reports free at annualcreditreport.com.</li>' +
      '</ul><p class="fin-muted">General information, not financial advice.</p></section>';
    chart($('[data-credit-chart]', view), shown);
  }

  /* ---------- add / edit (typed, or read from a screenshot) ---------- */
  function scoreForm(entry, person) {
    var me = Fin.data.viewer.email;
    var m = document.createElement('div');
    m.className = 'hub-modal';
    m.innerHTML = '<div class="hub-modal-box cal-form" role="dialog" aria-modal="true" aria-labelledby="cs-title"><h3 id="cs-title">' + (entry ? 'Edit score' : 'Add a credit score') + '</h3>' +
      (entry ? '' : '<label class="fin-shot"><input type="file" accept="image/*" data-shot hidden />' + Hub.icons.image + '<span><b>Read it from a screenshot</b><small>Of your bank or card app, or Credit Karma. The picture isn’t kept.</small></span></label>') +
      '<form novalidate><p class="fin-muted" data-shot-note hidden></p>' +
      '<div class="cf-row"><label class="field"><span>Whose</span><select name="person">' + people().map(function (p) { return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Score</span><input class="input" name="score" inputmode="numeric" placeholder="740" maxlength="3" /></label></div>' +
      '<div class="cf-row"><label class="field"><span>Model</span><select name="model"><option value="">Not sure</option>' + (Fin.data.creditModels || []).map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Bureau</span><select name="bureau"><option value="">Not sure</option>' + (Fin.data.creditBureaus || []).map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="cf-row"><label class="field"><span>Date</span><input class="input" type="date" name="date" max="' + Fin.data.today + '" /></label>' +
      '<label class="field"><span>From</span><input class="input" name="source" maxlength="40" placeholder="Credit Karma, Chase…" /></label></div>' +
      '<label class="cf-check"><input type="checkbox" name="private" /> Only me</label>' +
      '<p class="cf-error" role="alert" hidden></p>' +
      '<div class="hub-modal-actions">' + (entry ? '<button class="btn btn-danger" type="button" data-del style="margin-right:auto">Delete</button>' : '') +
        '<button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">' + (entry ? 'Save' : 'Add score') + '</button></div></form></div>';
    var form = $('form', m), el = form.elements;
    el.person.value = entry ? entry.person : person || me;
    el.score.value = entry ? entry.score : '';
    el.model.value = entry ? entry.model || '' : '';
    el.bureau.value = entry ? entry.bureau || '' : '';
    el.date.value = entry ? entry.date : Fin.data.today;
    el.source.value = entry ? entry.source || '' : '';
    el.private.checked = !!(entry && entry.private);
    function sync() { el.person.disabled = el.private.checked; if (el.private.checked) el.person.value = me; }
    el.private.addEventListener('change', sync); sync();
    function close() { m.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    $('[data-cancel]', m).addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    var shot = $('[data-shot]', m);
    if (shot) shot.addEventListener('change', function () {
      var file = shot.files && shot.files[0];
      if (!file) return;
      var note = $('[data-shot-note]', m), label = $('.fin-shot', m);
      label.classList.add('is-busy'); note.hidden = false; note.textContent = 'Reading the screenshot…';
      Hub.downscale(file, 1600).then(function (blob) {
        return Hub.api('fin-credit-read', { raw: blob, contentType: blob.type });
      }).then(function (r) {
        el.score.value = r.score; el.model.value = r.model || ''; el.bureau.value = r.bureau || ''; el.date.value = r.date || Fin.data.today; el.source.value = r.source || '';
        note.textContent = 'Filled in from the screenshot. Check it matches before saving.';
      }).catch(function (e) { note.textContent = e.message; })
        .then(function () { label.classList.remove('is-busy'); shot.value = ''; });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('.cf-error', m), score = Number(el.score.value);
      if (!Number.isInteger(score) || score < 250 || score > 900) { err.textContent = 'Credit scores run from about 300 to 850.'; err.hidden = false; return; }
      var btn = $('[type=submit]', m); btn.disabled = true;
      Fin.save('fin-credit', { body: { id: entry ? entry.id : undefined, person: el.person.value, score: score, model: el.model.value, bureau: el.bureau.value, date: el.date.value, source: el.source.value, private: el.private.checked } })
        .then(function () { close(); Hub.toast(entry ? 'Saved' : 'Score added'); })
        .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
    });
    var del = $('[data-del]', m);
    if (del) del.addEventListener('click', function () {
      Fin.save('fin-credit', { method: 'DELETE', query: { id: entry.id } }).then(function () { close(); Hub.toast('Deleted'); }).catch(function (e) { Hub.toast(e.message, true); });
    });
    document.body.appendChild(m);
    el.score.focus();
  }

  Fin.tab('credit', render);
  Fin.addScore = function (person) { scoreForm(null, person); };
  Fin.creditBandOf = bandOf;
  document.addEventListener('click', function (e) {
    if (!Fin.at('credit') || !$('#view').contains(e.target)) return;
    var t = e.target.closest('[data-score-add],[data-score]');
    if (!t) return;
    if (t.hasAttribute('data-score-add')) scoreForm(null, t.getAttribute('data-score-add'));
    else scoreForm((Fin.data.credit || []).filter(function (c) { return c.id === t.getAttribute('data-score'); })[0]);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !Fin.at('credit')) return;
    var t = e.target.closest && e.target.closest('[data-score]');
    if (t) scoreForm((Fin.data.credit || []).filter(function (c) { return c.id === t.getAttribute('data-score'); })[0]);
  });
})();
