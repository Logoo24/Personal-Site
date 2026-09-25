/* ===========================================
   Logan Randall - Site interactions
   Theme toggle + GSAP scroll animations
   =========================================== */

(function () {
  'use strict';

  /* ---------- THEME ---------- */
  // The initial theme is set by the inline script in each page's <head> (so
  // there's no light-mode flash for dark-mode users); this re-applies it and
  // keeps the toggle's aria-label in sync.
  var THEME_KEY = 'lb-theme';
  var HINT_KEY = 'lb-dark-hint-dismissed';
  function getStored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setStored(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0B0B0E' : '#FAFAFA');
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
  // Default to LIGHT (system preference intentionally ignored)
  applyTheme(getStored(THEME_KEY) || 'light');

  function wireThemeToggle() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
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
      var open = navLinks.classList.toggle('open');
      navHamburger.textContent = open ? '✕' : '☰';
      navHamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('open');
        navHamburger.textContent = '☰';
        navHamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Active nav link. Compare bare page names so it works both locally
  // (about.html) and on Vercel, where cleanUrls serves /about. Post pages
  // highlight Blog.
  function pageName(p) {
    return (p.split(/[?#]/)[0].split('/').pop() || 'index').replace(/\.html$/, '');
  }
  var current = /\/posts\//.test(location.pathname) ? 'blog' : pageName(location.pathname);
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (href && pageName(href) === current) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });

  /* ---------- ANIMATIONS ---------- */
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // Splits the hero title into word spans so GSAP can stagger them in.
  function wrapHeroTitle() {
    var ht = document.querySelector('.hero-title');
    if (!ht || ht.dataset.split === 'true') return;
    ht.dataset.split = 'true';
    var out = document.createDocumentFragment();
    Array.prototype.slice.call(ht.childNodes).forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent.split(/(\s+)/).forEach(function (p) {
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
        w2.appendChild(node);
        out.appendChild(w2);
      }
    });
    ht.innerHTML = '';
    ht.appendChild(out);
  }

  ready(function () {
    wireThemeToggle();
    document.querySelectorAll('[data-year]').forEach(function (el) {
      el.textContent = new Date().getFullYear();
    });

    // Scroll-reveal for .reveal elements: plain visibility under reduced
    // motion, GSAP when it loaded, IntersectionObserver otherwise.
    if (reduceMotion) {
      document.querySelectorAll('.reveal, .split-reveal').forEach(function (n) { n.classList.add('in'); });
      return;
    }

    wrapHeroTitle();

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

      if (document.querySelector('.hero-orb.one')) {
        gsap.to('.hero-orb.one', { yPercent: 30, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      }
      if (document.querySelector('.hero-orb.two')) {
        gsap.to('.hero-orb.two', { yPercent: -25, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      }

      gsap.utils.toArray('.reveal').forEach(function (node) {
        gsap.fromTo(node, { y: 40, opacity: 0 },
          { y: 0, opacity: 1, duration: 1, ease: 'power3.out',
            scrollTrigger: { trigger: node, start: 'top 85%', toggleActions: 'play none none none' } });
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

      // Stat count-up. Target values are baked into data-count (build.js
      // writes the post counts on every build).
      gsap.utils.toArray('.stat .num').forEach(function (el) {
        var suffix = el.dataset.suffix || '';
        var target = parseFloat(el.dataset.count || el.textContent);
        if (isNaN(target)) return;
        el.textContent = '0' + suffix;
        ScrollTrigger.create({
          trigger: el, start: 'top 85%', once: true,
          onEnter: function () {
            var obj = { v: 0 };
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
    document.querySelectorAll('.reveal, .split-reveal').forEach(function (n) { io.observe(n); });
  });
})();
