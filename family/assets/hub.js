/* ============================================================
   Family hub - shared page code (window.Hub).
   Every hub page has <header class="hub-bar" data-crumbs='[...]'>
   and calls Hub.ready(function (user) { ... }) to start.
   ============================================================ */
(function () {
  'use strict';

  var I = function (d, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + d + '</svg>';
  };
  var ICONS = {
    home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>'),
    book: I('<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5"/><path d="M19 17v4H6.5"/><path d="M9 7h6M9 11h4"/>'),
    chef: I('<path d="M6 13.9A4 4 0 0 1 7.6 6.2a5 5 0 0 1 8.8 0A4 4 0 0 1 18 13.9V20H6z"/><path d="M6 17h12"/>'),
    calendar: I('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="M7.5 13.5h.01M12 13.5h.01M16.5 13.5h.01M7.5 17h.01M12 17h.01"/>'),
    pen: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    print: I('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
    edit: I('<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
    share: I('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4M12 2v13"/>'),
    trash: I('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    users: I('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
    up: I('<path d="m18 15-6-6-6 6"/>'),
    down: I('<path d="m6 9 6 6 6-6"/>'),
    left: I('<path d="m15 18-6-6 6-6"/>'),
    right: I('<path d="m9 18 6-6-6-6"/>'),
    x: I('<path d="M18 6 6 18M6 6l12 12"/>'),
    check: I('<path d="M20 6 9 17l-5-5"/>', ' stroke-width="3"'),
    image: I('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
    logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    external: I('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    arrow: I('<path d="M7 17 17 7M8 7h9v9"/>'),
    globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    lock: I('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    list: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    quote: I('<path d="M3 21c3 0 7-1 7-8V5H3v7h4c0 3.5-1.5 5-4 6zM14 21c3 0 7-1 7-8V5h-7v7h4c0 3.5-1.5 5-4 6z"/>'),
    sparkle: I('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
    sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>', ' class="sun" stroke-width="2.25"'),
    moon: I('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', ' class="moon" stroke-width="2.25"')
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- theme (same storage key as the main site) ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0B0B0E' : '#FAFAFA');
  }
  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('lb-theme', next); } catch (e) {}
  }

  /* ---------- API ---------- */
  function toLogin() {
    location.href = '/family/login?next=' + encodeURIComponent(location.pathname + location.search);
  }
  function api(r, opts) {
    opts = opts || {};
    var q = new URLSearchParams(Object.assign({ r: r }, opts.query || {}));
    var init = { method: opts.method || (opts.body !== undefined || opts.raw ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (init.method !== 'GET') init.headers['x-family-hub'] = '1';
    if (opts.raw) { init.body = opts.raw; init.headers['content-type'] = opts.contentType; }
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    return fetch('/api/family?' + q, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && !opts.noRedirect) { toLogin(); throw new Error('Please sign in.'); }
        if (!res.ok) { var e = new Error(data.error || 'Something went wrong (' + res.status + ').'); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  var sessionP;
  function session() { return sessionP || (sessionP = api('session', { noRedirect: true })); }

  /* ---------- header ---------- */
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  }
  function renderBar(user) {
    var bar = $('.hub-bar');
    if (!bar) return;
    var crumbs = [];
    try { crumbs = JSON.parse(bar.getAttribute('data-crumbs') || '[]'); } catch (e) {}
    bar.innerHTML =
      '<a class="hub-brand" href="/family"><span class="hub-logo">' + ICONS.home + '</span><span class="hub-brand-text">Randall Family</span></a>' +
      crumbs.map(function (c) { return '<span class="hub-crumb"><a href="' + esc(c[1]) + '">' + esc(c[0]) + '</a></span>'; }).join('') +
      '<div class="hub-bar-right">' +
        '<button class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">' + ICONS.moon + ICONS.sun + '</button>' +
        '<div class="hub-user">' +
          '<button class="hub-user-btn" type="button" aria-haspopup="true" aria-expanded="false">' +
            '<span class="hub-avatar">' + (user.picture ? '<img src="' + esc(user.picture) + '" alt="" referrerpolicy="no-referrer" />' : esc(initials(user.name))) + '</span>' +
            '<span class="hub-user-name">' + esc(user.name) + '</span>' +
          '</button>' +
          '<div class="hub-menu" role="menu">' +
            '<div class="hub-menu-head"><strong>' + esc(user.name) + '</strong>' + esc(user.email || 'Signed in with the family password') + '</div>' +
            '<a href="/family" role="menuitem">' + ICONS.home + 'Family hub</a>' +
            '<a href="/" role="menuitem">' + ICONS.globe + 'loganbrandall.com</a>' +
            '<button type="button" data-logout role="menuitem">' + ICONS.logout + 'Sign out</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    $('.theme-toggle', bar).addEventListener('click', toggleTheme);
    var wrap = $('.hub-user', bar), btn = $('.hub-user-btn', bar);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function () { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); });
    $('[data-logout]', bar).addEventListener('click', function () {
      api('logout', { method: 'POST' }).finally(function () { location.href = '/family/login'; });
    });
  }

  function ready(fn) {
    session().then(function (s) {
      if (!s.user) return toLogin();
      renderBar(s.user);
      fn(s.user, s);
    }).catch(function (e) {
      var main = $('.hub-main');
      if (main) main.innerHTML = '<div class="hub-empty"><h3>Couldn’t load the family hub</h3><p>' + esc(e.message) + '</p><button class="btn btn-ghost" onclick="location.reload()">Try again</button></div>';
    });
  }

  /* ---------- small UI helpers ---------- */
  var toastEl, toastTimer;
  function toast(msg, isError) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'hub-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', !!isError);
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, isError ? 5000 : 2600);
  }

  // Resolves true/false. opts: { title, body (html), confirm, danger }
  function confirmBox(opts) {
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'hub-modal';
      m.innerHTML = '<div class="hub-modal-box" role="dialog" aria-modal="true"><h3>' + esc(opts.title) + '</h3><div>' + (opts.body || '') + '</div>' +
        '<div class="hub-modal-actions"><button class="btn btn-ghost" data-no type="button">Cancel</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-yes type="button">' + esc(opts.confirm || 'OK') + '</button></div></div>';
      function done(v) { m.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(false); }
      m.addEventListener('click', function (e) { if (e.target === m) done(false); });
      $('[data-no]', m).onclick = function () { done(false); };
      $('[data-yes]', m).onclick = function () { done(true); };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(m);
      $('[data-yes]', m).focus();
    });
  }

  function minutes(n) {
    n = +n || 0;
    if (!n) return '';
    var h = Math.floor(n / 60), m = n % 60;
    return (h ? h + ' hr' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
  }
  function hue(s) {
    var h = 0;
    for (var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function placeholderBg(title) {
    var h = hue(title || 'r');
    return 'linear-gradient(135deg, hsl(' + h + ' 62% 52%), hsl(' + ((h + 40) % 360) + ' 70% 42%))';
  }
  function mediaUrl(name) { return '/api/family?r=media&f=' + encodeURIComponent(name); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /* ---------- markdown (same image placement rules as build.js) ---------- */
  var markedReady = false;
  function md(text) {
    if (!window.marked) return '<p>' + esc(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    if (!markedReady) {
      markedReady = true;
      window.marked.use({
        renderer: {
          image: function (href, title, alt) {
            var raw = function (s) { return String(s || '').replace(/&(amp|lt|gt|quot|#39);/g, function (a, e) { return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]; }); };
            href = raw(href); title = raw(title); alt = raw(alt);
            var m = /^\s*(left|right|center|centre)\b\s*[:|\-–—]?\s*([\s\S]*)$/i.exec(title || '');
            var pos = m ? m[1].toLowerCase().replace('centre', 'center') : 'center';
            var cap = (m ? m[2] : (title || '')).trim();
            return '<figure class="post-img post-img--' + pos + '"><img src="' + esc(href) + '" alt="' + esc(alt) + '" loading="lazy" />' +
              (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') + '</figure>';
          }
        }
      });
    }
    var html = window.marked.parse(String(text || ''));
    // Lift figures out of their paragraphs, as build.js does.
    return html.replace(/<p>((?:(?!<\/p>)[\s\S])*?)(<figure class="post-img[\s\S]*?<\/figure>)\s*/g, function (a, before, fig) {
      return (before.trim() ? '<p>' + before.trim() + '</p>\n' : '') + fig + '\n<p>';
    }).replace(/<p>\s*<\/p>\n?/g, '');
  }

  /* ---------- recipe rendering (view page + cookbook export) ---------- */
  function ingredientsHTML(list, factor) {
    var RS = window.RecipeScale;
    return (list || []).map(function (ing) {
      if (ing.section != null) return '<li class="rc-ing-section">' + esc(ing.section) + '</li>';
      var q = RS.parseQty(ing.qty);
      var qty = q ? RS.scaleQty(ing.qty, factor) : (ing.qty || '');
      var unit = RS.unitFor(ing.unit, q ? q.max * factor : null);
      var head = [qty, unit].filter(Boolean).join(' ');
      return '<li>' + '<span>' + (head ? '<span class="rc-qty">' + esc(head) + '</span> ' : '') + esc(ing.item) +
        (ing.note ? '<span class="rc-note">, ' + esc(ing.note) + '</span>' : '') + '</span></li>';
    }).join('');
  }

  // opts: { factor, servings, story, photos, interactive, headingTag }
  function recipeHTML(r, opts) {
    opts = opts || {};
    var factor = opts.factor || 1;
    var total = (r.prepMinutes || 0) + (r.cookMinutes || 0);
    var facts = [];
    if (r.servings) facts.push('<span class="pill">' + ICONS.users + '<span data-yield>' + esc(RecipeScale.formatNum(r.servings * factor)) + ' ' + esc(r.yieldUnit || 'servings') + '</span></span>');
    if (r.prepMinutes) facts.push('<span class="pill">' + ICONS.clock + 'Prep ' + minutes(r.prepMinutes) + '</span>');
    if (r.cookMinutes) facts.push('<span class="pill">' + ICONS.clock + 'Cook ' + minutes(r.cookMinutes) + '</span>');
    if (r.prepMinutes && r.cookMinutes) facts.push('<span class="pill">' + ICONS.clock + 'Total ' + minutes(total) + '</span>');
    var h = opts.headingTag || 'h1';
    var photos = opts.photos !== false;
    var story = r.story && opts.story !== false ? md(r.story) : '';
    if (!photos) story = story.replace(/<figure class="post-img[\s\S]*?<\/figure>/g, '');

    var scale = opts.interactive && r.servings
      ? '<div class="rc-scale"><span class="rc-scale-count"><button type="button" data-scale-step="-1" aria-label="Fewer">−</button>' +
        '<input type="number" min="0.25" step="any" value="' + (+(r.servings * factor).toFixed(2)) + '" data-scale-input aria-label="Servings" />' +
        '<button type="button" data-scale-step="1" aria-label="More">+</button></span><span class="rc-scale-unit">' + esc(r.yieldUnit || 'servings') + '</span>' +
        '<div class="chips">' + [0.5, 1, 2, 3].map(function (f) { return '<button type="button" class="chip' + (f === factor ? ' on' : '') + '" data-scale-factor="' + f + '">' + (f === 0.5 ? '½' : f) + '×</button>'; }).join('') + '</div></div>'
      : (opts.interactive ? '' : (r.servings && factor !== 1 ? '<p class="rc-source">Scaled to ' + esc(RecipeScale.formatNum(r.servings * factor)) + ' ' + esc(r.yieldUnit) + '</p>' : ''));

    return '<header class="rc-hero">' +
        (photos && r.cover ? '<img class="rc-cover" src="' + mediaUrl(r.cover) + '" alt="" />' : '') +
        (r.tags && r.tags.length ? '<div class="rc-tags">' + r.tags.map(function (t) { return '<span class="rc-tag">' + esc(t) + '</span>'; }).join('<span class="rc-tag">·</span>') + '</div>' : '') +
        '<' + h + ' class="rc-title">' + esc(r.title) + '</' + h + '>' +
        (r.summary ? '<p class="rc-summary">' + esc(r.summary) + '</p>' : '') +
        (r.source ? '<p class="rc-source">From ' + esc(r.source) + '</p>' : '') +
        (facts.length ? '<div class="rc-facts">' + facts.join('') + '</div>' : '') +
      '</header>' +
      '<div class="rc-body">' +
        '<section class="rc-ingredients"><h2>Ingredients</h2>' + scale +
          (r.ingredients && r.ingredients.length ? '<ul class="rc-ing-list" data-ingredients>' + ingredientsHTML(r.ingredients, factor) + '</ul>' : '<p class="rc-source">No ingredients listed.</p>') +
        '</section>' +
        '<section class="rc-steps"><div class="rc-steps-head"><h2>Steps</h2>' +
          (opts.interactive && 'wakeLock' in navigator ? '<label class="rc-awake"><input type="checkbox" data-wake /> Keep screen on</label>' : '') + '</div>' +
          (r.steps && r.steps.length ? '<ol>' + r.steps.map(function (s) { return '<li>' + esc(s).replace(/\n/g, '<br>') + '</li>'; }).join('') + '</ol>' : '<p class="rc-source">No steps yet.</p>') +
          (r.notes ? '<div class="rc-notes"><h2>Notes &amp; tips</h2><div class="rc-prose">' + md(r.notes) + '</div></div>' : '') +
        '</section>' +
      '</div>' +
      (story ? '<section class="rc-story"><h2>The story</h2><div class="rc-prose">' + story + '</div></section>' : '');
  }

  /* ---------- photos: shrink in the browser, then upload ---------- */
  function downscale(file, max) {
    max = max || 1600;
    return new Promise(function (resolve, reject) {
      if (file.type === 'image/gif') return resolve(file);
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (b && b.type === 'image/webp') return resolve(b);
          c.toBlob(function (j) { j ? resolve(j) : reject(new Error('Couldn’t read that photo.')); }, 'image/jpeg', 0.86);
        }, 'image/webp', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file doesn’t look like a photo this browser can open.')); };
      img.src = url;
    });
  }
  function upload(file) {
    return downscale(file).then(function (blob) {
      return api('upload', { raw: blob, contentType: blob.type });
    });
  }

  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  window.Hub = {
    icons: ICONS, esc: esc, $: $, $$: $$, api: api, session: session, ready: ready, toast: toast,
    confirm: confirmBox, minutes: minutes, hue: hue, placeholderBg: placeholderBg, mediaUrl: mediaUrl,
    plural: plural, md: md, recipeHTML: recipeHTML, ingredientsHTML: ingredientsHTML, upload: upload,
    initials: initials, applyTheme: applyTheme, toggleTheme: toggleTheme
  };
})();
