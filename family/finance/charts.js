/* ============================================================
   Finance charts (window.FinCharts) - plain SVG, no library.
   Colors come from CSS custom properties in finance.css, so both
   themes work. Specs follow the site's chart rules: 2px lines,
   bars <= 24px with a 4px rounded data end, hairline solid grid,
   a crosshair tooltip on lines and a per-band tooltip on bars, a
   legend for 2+ series, and a table view under every chart.
   Every chart re-draws itself when its container changes width.
   Labels are set with textContent, never innerHTML.

   FinCharts.line(el, { labels, titles, series:[{name,color,values,area}],
                        est:[bool], format, axisFormat, height, ariaLabel })
   FinCharts.bars(el, { labels, titles, series:[{name,color,values}],
                        format, axisFormat, height, ariaLabel })
   FinCharts.hbars(el, { rows:[{label,value,sub}], color, format, ariaLabel })
   FinCharts.sparkline(el, { values, est, color, height })
   ============================================================ */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function htmlEl(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Round tick values: 0 / 2,000 / 4,000 rather than 0 / 1,873 / 3,746.
  function niceTicks(min, max, count, zero) {
    if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
    if (min === max) { var pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
    var rough = (max - min) / (count || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return { lo: lo, hi: hi, ticks: ticks };
  }
  function textWidth(s, px) { return String(s).length * (px || 11) * 0.6; }

  // Re-draw on width changes. Each container keeps its latest draw function.
  var observer = window.ResizeObserver ? new ResizeObserver(function (entries) {
    entries.forEach(function (e) {
      var el = e.target, w = Math.round(e.contentRect.width);
      if (el.__fcDraw && Math.abs(w - (el.__fcWidth || 0)) > 2) { el.__fcWidth = w; el.__fcDraw(); }
    });
  }) : null;
  function mount(el, draw) {
    el.__fcDraw = function () { el.textContent = ''; draw(el.clientWidth || 600); };
    el.__fcWidth = el.clientWidth;
    el.__fcDraw();
    if (observer && !el.__fcObserved) { el.__fcObserved = true; observer.observe(el); }
  }

  /* ---------- shared pieces ---------- */
  function legend(parent, series, kind) {
    var lg = htmlEl('div', 'fc-legend', parent);
    series.forEach(function (s) {
      var item = htmlEl('span', 'fc-legend-item', lg);
      var key = htmlEl('span', 'fc-key fc-key--' + kind, item);
      key.style.background = s.color;
      htmlEl('span', null, item, s.name);
    });
  }
  function tooltip(parent) {
    var tip = htmlEl('div', 'fc-tip', parent);
    tip.setAttribute('aria-live', 'polite');
    return {
      el: tip,
      show: function (title, rows, x, y, bounds) {
        tip.textContent = '';
        htmlEl('div', 'fc-tip-title', tip, title);
        rows.forEach(function (r) {
          var row = htmlEl('div', 'fc-tip-row', tip);
          var key = htmlEl('span', 'fc-key fc-key--line', row);
          key.style.background = r.color;
          htmlEl('strong', 'fc-val', row, r.value);
          htmlEl('span', 'fc-tip-name', row, r.name);
        });
        tip.classList.add('show');
        var w = tip.offsetWidth, left = x + 14;
        if (left + w > bounds) left = Math.max(0, x - w - 14);
        tip.style.left = left + 'px';
        tip.style.top = y + 'px';
      },
      hide: function () { tip.classList.remove('show'); }
    };
  }
  function table(parent, labels, series, format) {
    var d = htmlEl('details', 'fc-table', parent);
    htmlEl('summary', null, d, 'Show as table');
    var wrap = htmlEl('div', 'fc-table-wrap', d);
    var t = htmlEl('table', null, wrap);
    var hr = htmlEl('tr', null, htmlEl('thead', null, t));
    htmlEl('th', null, hr, '');
    series.forEach(function (s) { htmlEl('th', null, hr, s.name); });
    var tb = htmlEl('tbody', null, t);
    labels.forEach(function (l, i) {
      var tr = htmlEl('tr', null, tb);
      htmlEl('th', null, tr, l);
      series.forEach(function (s) { htmlEl('td', 'fc-val', tr, s.values[i] == null ? '–' : format(s.values[i])); });
    });
  }
  function frame(el, opts) {
    var fig = htmlEl('div', 'fc', el);
    if (opts.series && opts.series.length > 1) legend(fig, opts.series, opts.kind);
    var plot = htmlEl('div', 'fc-plot', fig);
    return { fig: fig, plot: plot };
  }

  // Y axis (gridlines + labels) and x labels thinned so they never collide.
  function axes(svg, g, ticks, y, labels, xAt, fmt) {
    ticks.forEach(function (v) {
      var yy = Math.round(y(v)) + 0.5;
      svgEl('line', { x1: g.left, x2: g.width - g.right, y1: yy, y2: yy, class: v === 0 ? 'fc-base' : 'fc-grid' }, svg);
      var t = svgEl('text', { x: g.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'fc-axis fc-val' }, svg);
      t.textContent = fmt(v);
    });
    var widest = labels.reduce(function (m, l) { return Math.max(m, textWidth(l)); }, 0) + 14;
    var room = labels.length > 1 ? (xAt(1) - xAt(0)) : Infinity;
    var every = Math.max(1, Math.ceil(widest / room));
    // Counted back from the newest, so the latest label always shows.
    for (var i = labels.length - 1; i >= 0; i -= every) {
      var t = svgEl('text', { x: xAt(i), y: g.height - 6, 'text-anchor': 'middle', class: 'fc-axis' }, svg);
      t.textContent = labels[i];
    }
  }

  /* ---------- line ---------- */
  function line(el, opts) {
    mount(el, function (width) {
      var series = opts.series, labels = opts.labels, n = labels.length;
      var fmt = opts.format || String, axisFmt = opts.axisFormat || fmt, est = opts.est || [];
      var f = frame(el, { series: series, kind: 'line' });
      var all = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
      var nt = niceTicks(Math.min.apply(null, all), Math.max.apply(null, all), 4, opts.zero);
      var multi = series.length > 1;
      var endRoom = multi ? series.reduce(function (m, s) { return Math.max(m, textWidth(s.name, 12)); }, 0) + 18 : 14;
      var g = {
        width: width, height: opts.height || 240, top: 12, bottom: 26, right: endRoom,
        left: Math.max.apply(null, nt.ticks.map(function (v) { return textWidth(axisFmt(v)); })) + 14
      };
      var pw = g.width - g.left - g.right, ph = g.height - g.top - g.bottom;
      var xAt = function (i) { return g.left + (n > 1 ? i * pw / (n - 1) : pw / 2); };
      var y = function (v) { return g.top + ph - (v - nt.lo) / (nt.hi - nt.lo) * ph; };
      var svg = svgEl('svg', { width: width, height: g.height, viewBox: '0 0 ' + width + ' ' + g.height, role: 'img', 'aria-label': opts.ariaLabel || '' }, f.plot);
      axes(svg, g, nt.ticks, y, labels, xAt, axisFmt);

      var ends = [];
      series.forEach(function (s) {
        var solid = '', dashed = '';
        for (var i = 1; i < n; i++) {
          if (s.values[i] == null || s.values[i - 1] == null) continue;
          var seg = 'M' + xAt(i - 1) + ',' + y(s.values[i - 1]) + 'L' + xAt(i) + ',' + y(s.values[i]);
          if (est[i] || est[i - 1]) dashed += seg; else solid += seg;
        }
        if (s.area && !multi) {
          var pts = [], base = y(Math.max(nt.lo, Math.min(nt.hi, 0)));
          if (nt.lo > 0) base = g.top + ph;
          s.values.forEach(function (v, i) { if (v != null) pts.push(xAt(i) + ',' + y(v)); });
          if (pts.length > 1) {
            var firstX = pts[0].split(',')[0], lastX = pts[pts.length - 1].split(',')[0];
            svgEl('path', { d: 'M' + firstX + ',' + base + 'L' + pts.join('L') + 'L' + lastX + ',' + base + 'Z', fill: s.color, class: 'fc-area' }, svg);
          }
        }
        if (dashed) svgEl('path', { d: dashed, stroke: s.color, class: 'fc-line fc-line--est' }, svg);
        if (solid) svgEl('path', { d: solid, stroke: s.color, class: 'fc-line' + (reduced ? '' : ' fc-draw') }, svg);
        for (var j = n - 1; j >= 0; j--) if (s.values[j] != null) { ends.push({ s: s, i: j, y: y(s.values[j]) }); break; }
      });
      ends.forEach(function (e) { svgEl('circle', { cx: xAt(e.i), cy: e.y, r: 4, fill: e.s.color, class: 'fc-dot' }, svg); });
      // Direct end labels for 2-4 series, unless two would collide (the legend carries them then).
      if (multi && series.length <= 4) {
        var ys = ends.map(function (e) { return e.y; }).sort(function (a, b) { return a - b; });
        var clash = ys.some(function (v, i) { return i && v - ys[i - 1] < 15; });
        if (!clash) ends.forEach(function (e) {
          var t = svgEl('text', { x: xAt(e.i) + 9, y: e.y + 4, class: 'fc-endlabel' }, svg);
          t.textContent = e.s.name;
        });
      }

      // Crosshair: a hairline that snaps to the nearest month, with every series in one tooltip.
      var tip = tooltip(f.plot);
      var hair = svgEl('line', { y1: g.top, y2: g.top + ph, class: 'fc-hair' }, svg);
      var marks = series.map(function (s) { return svgEl('circle', { r: 4, fill: s.color, class: 'fc-dot fc-hover-dot' }, svg); });
      var hit = svgEl('rect', { x: g.left - 8, y: g.top, width: pw + 16, height: ph, class: 'fc-hit' }, svg);
      var current = -1;
      function at(i) {
        current = i;
        var x = xAt(i);
        hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.classList.add('show');
        marks.forEach(function (m, k) {
          var v = series[k].values[i];
          if (v == null) { m.classList.remove('show'); return; }
          m.setAttribute('cx', x); m.setAttribute('cy', y(v)); m.classList.add('show');
        });
        var title = (opts.titles || labels)[i] + (est[i] ? ' · estimated' : '');
        tip.show(title, series.filter(function (s) { return s.values[i] != null; }).map(function (s) {
          return { color: s.color, value: fmt(s.values[i]), name: s.name };
        }), x, g.top, width);
      }
      function off() { current = -1; hair.classList.remove('show'); marks.forEach(function (m) { m.classList.remove('show'); }); tip.hide(); }
      hit.addEventListener('pointermove', function (e) {
        var r = svg.getBoundingClientRect();
        var i = Math.round(((e.clientX - r.left) - g.left) / (n > 1 ? pw / (n - 1) : 1));
        at(Math.max(0, Math.min(n - 1, i)));
      });
      hit.addEventListener('pointerleave', off);
      f.fig.tabIndex = 0;
      f.fig.setAttribute('aria-label', (opts.ariaLabel || 'Chart') + '. Use the left and right arrow keys to read each value.');
      f.fig.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        at(Math.max(0, Math.min(n - 1, current < 0 ? n - 1 : current + (e.key === 'ArrowRight' ? 1 : -1))));
      });
      f.fig.addEventListener('blur', off);
      if (opts.table !== false) table(f.fig, opts.titles || labels, series, fmt);
    });
  }

  /* ---------- vertical bars (grouped) ---------- */
  // A column with a 4px rounded data end and a square baseline end.
  function barPath(x, w, y0, y1) {
    var h = Math.abs(y1 - y0), r = Math.min(4, h, w / 2);
    if (h < 0.5) return '';
    if (y1 < y0) return 'M' + x + ',' + y0 + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 + r) + 'V' + y0 + 'Z';
    return 'M' + x + ',' + y0 + 'V' + (y1 - r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 - r) + 'V' + y0 + 'Z';
  }
  function bars(el, opts) {
    mount(el, function (width) {
      var series = opts.series, labels = opts.labels, n = labels.length, k = series.length;
      var fmt = opts.format || String, axisFmt = opts.axisFormat || fmt;
      var f = frame(el, { series: series, kind: 'bar' });
      var all = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
      var nt = niceTicks(Math.min.apply(null, all.concat(0)), Math.max.apply(null, all.concat(0)), 4, true);
      var g = {
        width: width, height: opts.height || 240, top: 12, bottom: 26, right: 8,
        left: Math.max.apply(null, nt.ticks.map(function (v) { return textWidth(axisFmt(v)); })) + 14
      };
      var pw = g.width - g.left - g.right, ph = g.height - g.top - g.bottom, band = pw / n;
      var barW = Math.max(3, Math.min(24, (band * 0.72 - (k - 1) * 2) / k));
      var groupW = barW * k + (k - 1) * 2;
      var xAt = function (i) { return g.left + band * i + band / 2; };
      var y = function (v) { return g.top + ph - (v - nt.lo) / (nt.hi - nt.lo) * ph; };
      var svg = svgEl('svg', { width: width, height: g.height, viewBox: '0 0 ' + width + ' ' + g.height, role: 'img', 'aria-label': opts.ariaLabel || '' }, f.plot);
      var hover = svgEl('rect', { y: g.top, width: band, height: ph, class: 'fc-band' }, svg);
      axes(svg, g, nt.ticks, y, labels, xAt, axisFmt);
      var tip = tooltip(f.plot);
      labels.forEach(function (l, i) {
        var x0 = xAt(i) - groupW / 2;
        series.forEach(function (s, j) {
          var v = s.values[i];
          if (v == null) return;
          var d = barPath(x0 + j * (barW + 2), barW, y(0), y(v));
          if (d) svgEl('path', { d: d, fill: s.color, class: 'fc-bar' }, svg);
        });
        var hit = svgEl('rect', { x: g.left + band * i, y: g.top, width: band, height: ph, class: 'fc-hit' }, svg);
        function show() {
          hover.setAttribute('x', g.left + band * i); hover.classList.add('show');
          tip.show((opts.titles || labels)[i], series.filter(function (s) { return s.values[i] != null; }).map(function (s) {
            return { color: s.color, value: fmt(s.values[i]), name: s.name };
          }), xAt(i) + groupW / 2, g.top, width);
        }
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointerleave', function () { hover.classList.remove('show'); tip.hide(); });
      });
      if (opts.table !== false) table(f.fig, opts.titles || labels, series, fmt);
    });
  }

  /* ---------- ranked horizontal bars (HTML, so labels wrap) ---------- */
  function hbars(el, opts) {
    el.textContent = '';
    var fmt = opts.format || String, rows = opts.rows || [];
    var max = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.value)); }, 0) || 1;
    var list = htmlEl('div', 'fc-hbars', el);
    list.setAttribute('role', 'list');
    if (opts.ariaLabel) list.setAttribute('aria-label', opts.ariaLabel);
    rows.forEach(function (r) {
      var row = htmlEl('div', 'fc-hrow', list);
      row.setAttribute('role', 'listitem');
      var head = htmlEl('div', 'fc-hrow-head', row);
      htmlEl('span', 'fc-hrow-label', head, r.label);
      if (r.sub) htmlEl('span', 'fc-hrow-sub', head, r.sub);
      htmlEl('span', 'fc-hrow-value fc-val', head, fmt(r.value));
      var track = htmlEl('div', 'fc-hrow-track', row);
      var bar = htmlEl('div', 'fc-hrow-bar', track);
      bar.style.width = Math.max(0.5, Math.abs(r.value) / max * 100) + '%';
      bar.style.background = opts.color || 'var(--fc-1)';
    });
  }

  /* ---------- sparkline (decoration beside a stat; the tile's text carries the value) ---------- */
  function sparkline(el, opts) {
    mount(el, function (width) {
      var vals = opts.values || [], n = vals.length, h = opts.height || 36, est = opts.est || [];
      if (n < 2) return;
      var nums = vals.filter(function (v) { return v != null; });
      var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
      if (hi === lo) { hi += 1; lo -= 1; }
      var x = function (i) { return 4 + i * (width - 8) / (n - 1); };
      var y = function (v) { return 4 + (h - 8) - (v - lo) / (hi - lo) * (h - 8); };
      var svg = svgEl('svg', { width: width, height: h, viewBox: '0 0 ' + width + ' ' + h, 'aria-hidden': 'true', class: 'fc-spark' }, el);
      var solid = '', dashed = '';
      for (var i = 1; i < n; i++) {
        if (vals[i] == null || vals[i - 1] == null) continue;
        var seg = 'M' + x(i - 1) + ',' + y(vals[i - 1]) + 'L' + x(i) + ',' + y(vals[i]);
        if (est[i] || est[i - 1]) dashed += seg; else solid += seg;
      }
      if (dashed) svgEl('path', { d: dashed, class: 'fc-spark-line fc-line--est' }, svg);
      if (solid) svgEl('path', { d: solid, class: 'fc-spark-line' }, svg);
      for (var j = n - 1; j >= 0; j--) if (vals[j] != null) {
        svgEl('circle', { cx: x(j), cy: y(vals[j]), r: 3.5, fill: opts.color || 'var(--accent)', class: 'fc-dot' }, svg);
        break;
      }
    });
  }

  window.FinCharts = { line: line, bars: bars, hbars: hbars, sparkline: sparkline, niceTicks: niceTicks };
})();
