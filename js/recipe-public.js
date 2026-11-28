/* ============================================================
   A public recipe page (/recipes/<slug>, api/_family/share-page.js):
   the same things the family hub's recipe view does, without editing.
   - servings: − / + / type a number / ½× 1× 2× 3×, with the ingredient
     amounts redrawn (js/recipe-scale.js, the hub's rules)
   - tap an ingredient or a step to tick it off
   - keep the screen on (where the browser can)
   - Share (the phone's share sheet, or copy the link) and Print
   - "Ask about this recipe" (POST /api/recipe?slug=…&ask=1)
   The recipe comes in a JSON block on the page (#recipe-data).
   ============================================================ */
(function () {
  'use strict';
  var dataEl = document.getElementById('recipe-data');
  if (!dataEl) return;
  var recipe = JSON.parse(dataEl.textContent);
  var RS = window.RecipeScale, factor = 1, wakeLock = null;
  var $ = function (s, root) { return (root || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ---------- a small toast (the hub's look: .hub-toast) ---------- */
  var toastEl = null, toastTimer = 0;
  function toast(msg, isError) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'hub-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', !!isError);
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, isError ? 5000 : 2600);
  }

  /* ---------- servings ---------- */
  // The same markup as the page drew (share-page.js ingredientsHTML).
  function ingredientsHTML(list, f) {
    return (list || []).map(function (ing) {
      if (ing.section != null) return '<li class="rc-ing-section">' + esc(ing.section) + '</li>';
      var q = RS.parseQty(ing.qty);
      var qty = q ? RS.scaleQty(ing.qty, f) : (ing.qty || '');
      var unit = RS.unitFor(ing.unit, q ? q.max * f : null);
      var head = [qty, unit].filter(Boolean).join(' ');
      return '<li><span>' + (head ? '<span class="rc-qty">' + esc(head) + '</span> ' : '') + esc(ing.item) +
        (ing.note ? '<span class="rc-note">, ' + esc(ing.note) + '</span>' : '') + '</span></li>';
    }).join('');
  }
  function setFactor(f) {
    if (!(f > 0) || !recipe.servings || !RS) return;
    factor = Math.min(f, 100);
    var list = $('[data-ingredients]');
    if (list) list.innerHTML = ingredientsHTML(recipe.ingredients, factor);
    var amount = recipe.servings * factor;
    var y = $('[data-yield]'); if (y) y.textContent = RS.formatNum(amount) + ' ' + recipe.yieldUnit;
    var input = $('[data-scale-input]'); if (input && document.activeElement !== input) input.value = +amount.toFixed(2);
    Array.prototype.forEach.call(document.querySelectorAll('[data-scale-factor]'), function (c) { c.classList.toggle('on', +c.getAttribute('data-scale-factor') === factor); });
  }

  var article = $('#recipe');
  article.addEventListener('click', function (e) {
    var t = e.target;
    var chip = t.closest('[data-scale-factor]');
    if (chip) return setFactor(+chip.getAttribute('data-scale-factor'));
    var step = t.closest('[data-scale-step]');
    if (step) {
      // As in the hub: halves up to 2, then whole servings.
      var cur = recipe.servings * factor, d = +step.getAttribute('data-scale-step');
      var next = cur + d * (cur <= 2 ? 0.5 : 1);
      if (next > 0) setFactor(next / recipe.servings);
      return;
    }
    if (t.closest('a, button, input, label')) return;
    // Tick off an ingredient or a step.
    var li = t.closest('.rc-ing-list li:not(.rc-ing-section), .rc-steps > ol > li');
    if (li) li.classList.toggle('done');
  });
  article.addEventListener('input', function (e) {
    if (e.target.matches('[data-scale-input]')) { var v = parseFloat(e.target.value); if (v > 0) setFactor(v / recipe.servings); }
  });

  /* ---------- keep the screen on ---------- */
  var awake = $('.rc-awake');
  if (awake && 'wakeLock' in navigator) awake.hidden = false;
  article.addEventListener('change', function (e) {
    if (!e.target.matches('[data-wake]')) return;
    if (e.target.checked) {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; toast('The screen will stay on while this page is open.'); })
        .catch(function () { e.target.checked = false; toast('This browser won’t keep the screen on.', true); });
    } else if (wakeLock) { wakeLock.release(); wakeLock = null; }
  });
  document.addEventListener('visibilitychange', function () {
    var box = $('[data-wake]');
    if (document.visibilityState === 'visible' && box && box.checked && !wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
    if (document.visibilityState === 'hidden') wakeLock = null;
  });

  /* ---------- share and print ---------- */
  function copyLink() {
    var done = function () { toast('Link copied.'); };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(recipe.url).then(done, function () { prompt('Copy this link:', recipe.url); });
    prompt('Copy this link:', recipe.url);
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-print]')) return window.print();
    if (!e.target.closest('[data-share]')) return;
    var data = { title: recipe.title, text: recipe.title + ', from the Randall family kitchen', url: recipe.url };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      navigator.share(data).catch(function (err) { if (err && err.name !== 'AbortError') copyLink(); });
    } else copyLink();
  });

  /* ---------- ask about this recipe ----------
     As on the hub's recipe page: the conversation lives on the page (and
     in sessionStorage, so a reload keeps it) and each question sends the
     last six turns along; the server stores nothing. */
  var askBox = $('#ask');
  if (!askBox) return;
  var ask = { turns: [], busy: false };
  var STARTERS = ['Can I make it ahead?', 'What can I substitute?', 'How do I store leftovers?', 'Any tips for getting it right?'];
  var KEY = 'rc-ask-pub-' + recipe.slug;
  function saveTurns() { try { sessionStorage.setItem(KEY, JSON.stringify(ask.turns.filter(function (t) { return t.a; }).slice(-20))); } catch (e) { /* private mode */ } }
  // Answers: escaped first, then only bold, italics, lists and paragraphs.
  function answerHTML(text) {
    var inline = function (s) {
      return esc(s).replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    };
    return String(text).trim().split(/\n{2,}/).map(function (block) {
      var lines = block.split('\n');
      if (lines.every(function (l) { return /^\s*[-*•]\s+/.test(l); })) return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*•]\s+/, '')) + '</li>'; }).join('') + '</ul>';
      if (lines.every(function (l) { return /^\s*\d+[.)]\s+/.test(l); })) return '<ol>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>'; }).join('') + '</ol>';
      return '<p>' + lines.map(inline).join('<br>') + '</p>';
    }).join('');
  }
  function drawAsk() {
    $('#ask-thread').innerHTML = ask.turns.map(function (t) {
      return '<div class="rc-ask-q">' + esc(t.q) + '</div>' +
        (t.a ? '<div class="rc-ask-a">' + answerHTML(t.a) + '</div>'
          : '<div class="rc-ask-a rc-ask-wait" aria-label="Thinking">Thinking<span class="rc-ask-dots"><i></i><i></i><i></i></span></div>');
    }).join('');
    $('#ask-starters').innerHTML = ask.turns.length ? '' : STARTERS.map(function (s) { return '<button type="button" class="chip" data-ask="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
    $('#ask-clear').hidden = !ask.turns.length || ask.busy;
    $('#ask-send').disabled = ask.busy;
    $('#ask-send').textContent = ask.busy ? 'Asking…' : 'Ask';
    $('#ask-input').placeholder = ask.turns.length ? 'Ask a follow-up' : 'Ask a question';
  }
  function growAsk() {
    var t = $('#ask-input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight + 2, 200) + 'px';
    t.style.overflowY = t.scrollHeight > 200 ? 'auto' : 'hidden';
  }
  function sendQuestion(q) {
    q = String(q || '').trim();
    if (!q || ask.busy) return;
    var history = ask.turns.filter(function (t) { return t.a; }).slice(-4).map(function (t) { return { q: t.q, a: t.a, s: t.s }; });
    var turn = { q: q, a: '' };
    ask.turns.push(turn);
    ask.busy = true;
    $('#ask-input').value = ''; growAsk();
    drawAsk();
    fetch('/api/recipe?slug=' + encodeURIComponent(recipe.slug) + '&ask=1', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-recipe-ask': '1' },
      body: JSON.stringify({ question: q, history: history, factor: factor })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || !d.answer) throw new Error(d.error || 'Couldn’t get an answer. Try again.');
        turn.a = d.answer;
        turn.s = d.sig; // sent back with follow-ups, so the server knows it gave this answer
        saveTurns();
      });
    }).catch(function (e) {
      ask.turns.splice(ask.turns.indexOf(turn), 1);
      if (!$('#ask-input').value) { $('#ask-input').value = q; growAsk(); }
      toast(e.message || 'Couldn’t get an answer. Try again.', true);
    }).then(function () {
      ask.busy = false;
      drawAsk();
      var answers = document.querySelectorAll('#ask-thread .rc-ask-a');
      if (answers.length) answers[answers.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  try { ask.turns = (JSON.parse(sessionStorage.getItem(KEY) || '[]') || []).filter(function (t) { return t && t.q && t.a; }); } catch (e) { ask.turns = []; }
  askBox.hidden = false;
  drawAsk();
  $('#ask-form').addEventListener('submit', function (e) { e.preventDefault(); sendQuestion($('#ask-input').value); });
  $('#ask-input').addEventListener('input', growAsk);
  $('#ask-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendQuestion(this.value); }
  });
  $('#ask-starters').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ask]');
    if (b) sendQuestion(b.getAttribute('data-ask'));
  });
  $('#ask-clear').addEventListener('click', function () { ask.turns = []; saveTurns(); drawAsk(); $('#ask-input').focus(); });
})();
