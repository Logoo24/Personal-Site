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
