/* ===========================================
   Logan Randall - Site interactions
   Theme toggle + GSAP scroll animations
   =========================================== */

(function () {
  'use strict';

  /* ---------- THEME ---------- */
  var THEME_KEY = 'lb-theme';
  var HINT_KEY = 'lb-dark-hint-dismissed';
  function getStored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setStored(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
  // Default to LIGHT (system preference intentionally ignored)
  applyTheme(getStored(THEME_KEY) || 'light');

  function wireThemeToggle() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        var cur = document.documentElement.getAttribute('data-theme') || 'light';
        var next = cur === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        setStored(THEME_KEY, next);
        document.querySelectorAll('.theme-hint').forEach(function (h) { h.classList.remove('show'); });
        setStored(HINT_KEY, '1');
      });
    });
    // First-visit hint
    var hintDismissed = getStored(HINT_KEY) === '1';
    var hasUsedTheme = !!getStored(THEME_KEY);
    if (!hintDismissed && !hasUsedTheme) {
      setTimeout(function () {
        document.querySelectorAll('.theme-hint').forEach(function (h) { h.classList.add('show'); });
      }, 1400);
      document.querySelectorAll('.theme-hint').forEach(function (h) {
        h.addEventListener('click', function (e) {
          e.stopPropagation();
          h.classList.remove('show');
          setStored(HINT_KEY, '1');
        });
      });
    }
  }

  /* ---------- NAV ---------- */
  var nav = document.querySelector('.nav');
  var navHamburger = document.querySelector('.nav-toggle');
  var navLinks = document.querySelector('.nav-links');
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 24) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (navHamburger && navLinks) {
    navHamburger.addEventListener('click', function () {
      navLinks.classList.toggle('open');
      navHamburger.textContent = navLinks.classList.contains('open') ? '✕' : '☰';
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('open');
        navHamburger.textContent = '☰';
      });
    });
  }
  var path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href) return;
    if (href === path || href.endsWith('/' + path) ||
        (path === '' && href === 'index.html') ||
        (path === 'index.html' && href === './')) {
      a.classList.add('active');
    }
  });

  /* ---------- ANIMATIONS ---------- */
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  /* ---------- CONTENT LOADERS (managed via /admin) ---------- */
  // Tiny element helper.
  function el(tag, props) {
    var e = document.createElement(tag);
    if (!props) return e;
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      var v = props[key];
      if (v == null) continue;
      if (key === 'class') e.className = v;
      else if (key === 'text') e.textContent = v;
      else if (key === 'html') e.innerHTML = v;
      else if (key === 'children') {
        v.forEach(function (c) { if (c) e.appendChild(c); });
      } else e.setAttribute(key, v);
    }
    return e;
  }

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ---- Site images ----
  function applySiteImages(data) {
    if (!data) return;
    document.querySelectorAll('[data-image]').forEach(function (node) {
      var key = node.getAttribute('data-image');
      var src = data[key];
      if (!src) return;
      if (node.tagName === 'IMG') {
        if (node.getAttribute('src') !== src) node.setAttribute('src', src);
      } else {
        node.style.backgroundImage = "url('" + src + "')";
      }
    });
  }

  // ---- Homepage hero (rotating) ----
  // In-code defaults so the page works even if the JSON fetch fails.
  var heroVariants = [
    {
      eyebrow: "Welcome",
      title_main: "Hi, I'm Logan.",
      title_accent: "Here's what I'm up to.",
      lede: "A college student who likes building, writing, and figuring out what's next. Stick around for projects, class notes, and the occasional essay."
    },
    {
      eyebrow: "Hi there",
      title_main: "Logan Randall",
      title_accent: "Welcome to my website!",
      lede: "Glad you found your way here. Have a look around - projects, blog posts, and a bit about who I am are all a click away."
    },
    {
      eyebrow: "Currently",
      title_main: "Logan Randall.",
      title_accent: "A site about what I'm doing.",
      lede: "Projects in progress, classes I'm taking, and the occasional essay - a running snapshot of what I'm working on right now."
    }
  ];

  function applyHeroVariant(idx) {
    var heroContent = document.querySelector('[data-render="homepage-hero"]');
    if (!heroContent || !heroVariants.length) return;
    var v = heroVariants[idx % heroVariants.length];
    var eyebrow = heroContent.querySelector('.eyebrow');
    var title = heroContent.querySelector('.hero-title');
    var lede = heroContent.querySelector('.hero-lede');
    if (eyebrow) eyebrow.textContent = v.eyebrow;
    if (title) {
      title.textContent = (v.title_main || '') + ' ';
      var accent = document.createElement('span');
      accent.className = 'accent';
      accent.textContent = v.title_accent || '';
      title.appendChild(accent);
    }
    if (lede) lede.textContent = v.lede || '';
  }

  function rotateHeroText() {
    if (!document.querySelector('[data-render="homepage-hero"]')) return;
    var stored = parseInt(getStored(HERO_KEY), 10);
    var nextIdx;
    if (isNaN(stored)) {
      nextIdx = 0;
      setStored(HERO_KEY, '0');
    } else {
      nextIdx = (stored + 1) % heroVariants.length;
      setStored(HERO_KEY, String(nextIdx));
    }
    applyHeroVariant(nextIdx);
  }
  var HERO_KEY = 'lb-hero-idx';

  function applyHeroVariants(data) {
    if (!data || !Array.isArray(data.variants) || !data.variants.length) return;
    heroVariants = data.variants;
    // Re-apply the current rotation index now that we have fresh data.
    var stored = parseInt(getStored(HERO_KEY), 10);
    if (isNaN(stored)) stored = 0;
    applyHeroVariant(stored);
  }

  // ---- Featured projects (homepage) ----
  function applyFeaturedProjects(data) {
    if (!data) return;
    var section = document.querySelector('[data-render="featured-projects"]');
    if (!section) return;
    var head = section.querySelector('.section-head');
    if (head) {
      var eb = head.querySelector('.eyebrow');
      var h2 = head.querySelector('h2');
      var p = head.querySelector('p');
      if (eb && data.eyebrow) eb.textContent = data.eyebrow;
      if (h2 && data.title) h2.textContent = data.title;
      if (p && data.description) p.textContent = data.description;
    }
    var grid = section.querySelector('.grid');
    if (!grid || !Array.isArray(data.items)) return;
    grid.innerHTML = '';
    data.items.forEach(function (item) {
      grid.appendChild(el('article', { class: 'card', children: [
        el('span', { class: 'card-tag', text: item.tag || '' }),
        el('h3', { text: item.title || '' }),
        el('p', { text: item.description || '' }),
        el('div', { class: 'card-meta', children: [
          el('span', { text: item.tech || '' }),
          el('span', { text: item.status || '' })
        ]})
      ]}));
    });
  }

  // ---- About page ----
  function applyAboutPage(data) {
    if (!data) return;
    // Hero text
    var heroContent = document.querySelector('.about-page .hero-content, [data-render="about-hero"]');
    if (heroContent) {
      var eb = heroContent.querySelector('.eyebrow');
      var title = heroContent.querySelector('.hero-title');
      if (eb && data.eyebrow) eb.textContent = data.eyebrow;
      if (title && (data.title_main || data.title_accent)) {
        title.textContent = (data.title_main || '') + ' ';
        var span = document.createElement('span');
        span.className = 'accent';
        span.textContent = data.title_accent || '';
        title.appendChild(span);
      }
    }
    // Body content
    var body = document.querySelector('[data-render="about-content"]');
    if (!body) return;
    body.innerHTML = '';
    if (data.lead) {
      body.appendChild(el('p', { class: 'reveal', style: 'font-size:1.2rem; color: var(--text);', text: data.lead }));
    }
    (data.sections || []).forEach(function (s) {
      body.appendChild(el('h2', { class: 'reveal', style: 'margin-top:3rem;', text: s.heading || '' }));
      body.appendChild(el('p', { class: 'reveal', text: s.body || '' }));
    });
    if (data.quote && data.quote.text) {
      var q = '"' + data.quote.text + '"';
      if (data.quote.author) q += ' - ' + data.quote.author;
      body.appendChild(el('blockquote', {
        class: 'reveal',
        style: 'margin-top:3rem; padding: 1rem 2rem; border-left: 3px solid var(--accent); font-style: italic; color: var(--text-soft); font-size: 1.15rem;',
        text: q
      }));
    }
    if (data.practical_heading) {
      body.appendChild(el('h2', { class: 'reveal', style: 'margin-top:3rem;', text: data.practical_heading }));
    }
    if (Array.isArray(data.practical) && data.practical.length) {
      var ul = el('ul', { class: 'reveal', style: 'padding-left:1.5rem; line-height:2;' });
      data.practical.forEach(function (item) {
        var li = el('li');
        li.innerHTML = linkifyEmails(escapeHTML(item));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function linkifyEmails(s) {
    return s.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
      '<a href="mailto:$1">$1</a>');
  }

  // ---- Resume page ----
  function resumeItem(item) {
    return el('div', { class: 'resume-item', children: [
      el('div', { class: 'when', text: item.when || '' }),
      el('div', { children: [
        el('h4', { text: item.title || '' }),
        item.where ? el('div', { class: 'where', text: item.where }) : null,
        item.description ? el('p', { text: item.description }) : null
      ]})
    ]});
  }

  function resumeSection(heading, items) {
    if (!Array.isArray(items) || !items.length) return null;
    var sec = el('div', { class: 'resume-section reveal', children: [
      el('h3', { text: heading })
    ]});
    items.forEach(function (it) { sec.appendChild(resumeItem(it)); });
    return sec;
  }

  function applyResumePage(data) {
    if (!data) return;
    var heroContent = document.querySelector('.resume-page .hero-content, [data-render="resume-hero"]');
    if (heroContent) {
      var eb = heroContent.querySelector('.eyebrow');
      var title = heroContent.querySelector('.hero-title');
      if (eb && data.eyebrow) eb.textContent = data.eyebrow;
      if (title && (data.title_main || data.title_accent)) {
        title.textContent = (data.title_main || '') + ' ';
        var span = document.createElement('span');
        span.className = 'accent';
        span.textContent = data.title_accent || '';
        title.appendChild(span);
      }
    }

    var body = document.querySelector('[data-render="resume-content"]');
    if (!body) return;
    body.innerHTML = '';

    var s;
    if ((s = resumeSection('Education', data.education))) body.appendChild(s);
    if ((s = resumeSection('Experience', data.experience))) body.appendChild(s);
    if ((s = resumeSection('Selected projects', data.projects))) body.appendChild(s);

    // Skills
    if (Array.isArray(data.skills) && data.skills.length) {
      var skillsSec = el('div', { class: 'resume-section reveal', children: [
        el('h3', { text: 'Skills' })
      ]});
      data.skills.forEach(function (group, i) {
        skillsSec.appendChild(el('h4', {
          style: 'font-family: var(--sans); margin: ' + (i === 0 ? '1rem' : '1.5rem') + ' 0 0.75rem;',
          text: group.category || ''
        }));
        var grid = el('div', { class: 'skills-grid' });
        String(group.items || '').split(',').forEach(function (item) {
          var name = item.trim();
          if (name) grid.appendChild(el('span', { class: 'skill-pill', text: name }));
        });
        skillsSec.appendChild(grid);
      });
      body.appendChild(skillsSec);
    }

    if ((s = resumeSection('Awards & honors', data.awards))) body.appendChild(s);

    if (data.footer_note) {
      var note = el('div', {
        class: 'reveal',
        style: 'margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--line); color: var(--text-muted); font-size: 0.95rem;'
      });
      note.appendChild(el('p', { html: linkifyEmails(escapeHTML(data.footer_note)) }));
      body.appendChild(note);
    }
  }

  // Kicks off all fetches in parallel; each renderer no-ops if its target isn't on the page.
  function loadContent() {
    fetchJSON('/data/images.json').then(applySiteImages);
    fetchJSON('/data/hero-variants.json').then(applyHeroVariants);
    fetchJSON('/data/featured-projects.json').then(applyFeaturedProjects);
    fetchJSON('/data/about.json').then(applyAboutPage);
    fetchJSON('/data/resume.json').then(applyResumePage);
  }

  function wrapHeroTitle() {
    var ht = document.querySelector('.hero-title');
    if (!ht || ht.dataset.split === 'true') return;
    ht.dataset.split = 'true';
    var html = ht.innerHTML;
    var parser = new DOMParser();
    var doc = parser.parseFromString('<div>' + html + '</div>', 'text/html');
    var root = doc.body.firstChild;
    var out = document.createDocumentFragment();
    root.childNodes.forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        var parts = node.textContent.split(/(\s+)/);
        parts.forEach(function (p) {
          if (/^\s+$/.test(p)) {
            out.appendChild(document.createTextNode(p));
          } else if (p.length) {
            var w = document.createElement('span');
            w.className = 'word';
            w.style.display = 'inline-block';
            w.textContent = p;
            out.appendChild(w);
          }
        });
      } else {
        var w2 = document.createElement('span');
        w2.className = 'word';
        w2.style.display = 'inline-block';
        w2.appendChild(node.cloneNode(true));
        out.appendChild(w2);
      }
    });
    ht.innerHTML = '';
    ht.appendChild(out);
  }

  ready(function () {
    wireThemeToggle();
    rotateHeroText();   // synchronous initial rotation using in-code defaults
    loadContent();      // async: fetches JSON, applies images + overrides text
    wrapHeroTitle();

    if (reduceMotion) {
      document.querySelectorAll('.reveal, .split-reveal').forEach(function (el) { el.classList.add('in'); });
      return;
    }

    if (window.gsap && window.ScrollTrigger) {
      gsap.registerPlugin(ScrollTrigger);

      var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      var eb = document.querySelector('.hero .eyebrow');
      var words = document.querySelectorAll('.hero-title .word');
      var lede = document.querySelector('.hero-lede');
      var btns = document.querySelectorAll('.hero .btn-row > *');
      var cue = document.querySelector('.scroll-cue');
      if (eb) tl.from(eb, { y: 24, opacity: 0, duration: 0.7 });
      if (words.length) tl.from(words, { y: 110, opacity: 0, stagger: 0.08, duration: 1.1 }, '-=0.4');
      if (lede) tl.from(lede, { y: 24, opacity: 0, duration: 0.8 }, '-=0.6');
      if (btns.length) tl.from(btns, { y: 18, opacity: 0, stagger: 0.1, duration: 0.6 }, '-=0.5');
      if (cue) tl.from(cue, { opacity: 0, duration: 0.8 }, '-=0.3');

      gsap.to('.hero-orb.one', { yPercent: 30, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('.hero-orb.two', { yPercent: -25, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

      gsap.utils.toArray('.reveal').forEach(function (el) {
        gsap.fromTo(el, { y: 40, opacity: 0 },
          { y: 0, opacity: 1, duration: 1, ease: 'power3.out',
            scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none none' } });
      });

      gsap.utils.toArray('.feature-row').forEach(function (row) {
        gsap.from(row, { y: 30, opacity: 0, duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: row, start: 'top 88%' } });
      });

      gsap.utils.toArray('.grid').forEach(function (grid) {
        var items = grid.querySelectorAll('.card');
        if (!items.length) return;
        gsap.from(items, { y: 40, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out',
          scrollTrigger: { trigger: grid, start: 'top 85%' } });
      });

      gsap.utils.toArray('.stat .num').forEach(function (el) {
        var target = parseFloat(el.dataset.count || el.textContent);
        var suffix = el.dataset.suffix || '';
        if (isNaN(target)) return;
        var obj = { v: 0 };
        ScrollTrigger.create({
          trigger: el, start: 'top 85%', once: true,
          onEnter: function () {
            gsap.to(obj, { v: target, duration: 1.6, ease: 'power2.out',
              onUpdate: function () { el.textContent = Math.round(obj.v) + suffix; } });
          }
        });
      });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.reveal, .split-reveal').forEach(function (el) { io.observe(el); });
  });

  ready(function () {
    document.querySelectorAll('[data-year]').forEach(function (el) {
      el.textContent = new Date().getFullYear();
    });
  });
})();
