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
   FinCharts.bars(el, { labels, titles, series:[{name,color,values}], line?,
                        format, axisFormat, height, ariaLabel })
   FinCharts.stackedBars(el, { labels, titles, series, line?, format, ... })
                        (positive values stack up, negative ones down)
                        bars and stackedBars take partial: an index to draw
                        faded (the month that isn't over yet)
   FinCharts.moneyFlow(el, { sources:[{name,value,color}], trunk,
                        groups:[{name,value,color,items:[{name,value}]}],
                        format, ariaLabel })
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
      var key = htmlEl('span', 'fc-key fc-key--' + (s.kind || kind), item);
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
    var keys = (opts.series || []).concat(opts.line ? [Object.assign({ kind: 'line' }, opts.line)] : []);
    if (keys.length > 1) legend(fig, keys, opts.kind);
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
  // opts.line: { name, color, values } - one line drawn over the bars on
  // the same axis (the same unit), e.g. the net under money in and out.
  function bars(el, opts) {
    mount(el, function (width) {
      var series = opts.series, labels = opts.labels, n = labels.length, k = series.length;
      var fmt = opts.format || String, axisFmt = opts.axisFormat || fmt;
      var f = frame(el, { series: series, kind: 'bar', line: opts.line });
      var all = [];
      series.concat(opts.line ? [opts.line] : []).forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
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
          if (d) svgEl('path', { d: d, fill: s.color, class: 'fc-bar' + (i === opts.partial ? ' fc-bar--partial' : '') }, svg);
        });
      });
      if (opts.line) {
        var d = '';
        opts.line.values.forEach(function (v, i) { if (v != null) d += (d && opts.line.values[i - 1] != null ? 'L' : 'M') + xAt(i) + ',' + y(v); });
        svgEl('path', { d: d, stroke: opts.line.color, class: 'fc-line' }, svg);
        opts.line.values.forEach(function (v, i) { if (v != null) svgEl('circle', { cx: xAt(i), cy: y(v), r: 4, fill: opts.line.color, class: 'fc-dot' }, svg); });
      }
      var everything = series.concat(opts.line ? [opts.line] : []);
      labels.forEach(function (l, i) {
        var hit = svgEl('rect', { x: g.left + band * i, y: g.top, width: band, height: ph, class: 'fc-hit' }, svg);
        function show() {
          hover.setAttribute('x', g.left + band * i); hover.classList.add('show');
          tip.show((opts.titles || labels)[i], everything.filter(function (s) { return s.values[i] != null; }).map(function (s) {
            return { color: s.color, value: fmt(s.values[i]), name: s.name };
          }), xAt(i) + groupW / 2, g.top, width);
        }
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointerleave', function () { hover.classList.remove('show'); tip.hide(); });
      });
      if (opts.table !== false) table(f.fig, opts.titles || labels, everything, fmt);
    });
  }

  /* ---------- stacked bars (positive values stack up, negative down) ---------- */
  // Segments are separated by a 2px surface gap; only the outermost
  // segment of each stack gets the rounded data end.
  function stackedBars(el, opts) {
    mount(el, function (width) {
      var series = opts.series, labels = opts.labels, n = labels.length;
      var fmt = opts.format || String, axisFmt = opts.axisFormat || fmt;
      var f = frame(el, { series: series, kind: 'bar', line: opts.line });
      var hi = 0, lo = 0;
      for (var i = 0; i < n; i++) {
        var up = 0, down = 0;
        series.forEach(function (s) { var v = s.values[i] || 0; if (v > 0) up += v; else down += v; });
        hi = Math.max(hi, up); lo = Math.min(lo, down);
      }
      if (opts.line) opts.line.values.forEach(function (v) { if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
      var nt = niceTicks(lo, hi, 4, true);
      var g = {
        width: width, height: opts.height || 260, top: 12, bottom: 26, right: 8,
        left: Math.max.apply(null, nt.ticks.map(function (v) { return textWidth(axisFmt(v)); })) + 14
      };
      var pw = g.width - g.left - g.right, ph = g.height - g.top - g.bottom, band = pw / n;
      var barW = Math.max(4, Math.min(24, band * 0.6));
      var xAt = function (i) { return g.left + band * i + band / 2; };
      var y = function (v) { return g.top + ph - (v - nt.lo) / (nt.hi - nt.lo) * ph; };
      var svg = svgEl('svg', { width: width, height: g.height, viewBox: '0 0 ' + width + ' ' + g.height, role: 'img', 'aria-label': opts.ariaLabel || '' }, f.plot);
      var hover = svgEl('rect', { y: g.top, width: band, height: ph, class: 'fc-band' }, svg);
      axes(svg, g, nt.ticks, y, labels, xAt, axisFmt);
      var tip = tooltip(f.plot);
      labels.forEach(function (l, i) {
        var x0 = xAt(i) - barW / 2;
        [1, -1].forEach(function (sign) {
          var segs = series.map(function (s) { return { s: s, v: s.values[i] || 0 }; }).filter(function (p) { return p.v * sign > 0; });
          var base = 0;
          segs.forEach(function (p, j) {
            var outer = j === segs.length - 1;
            var y0 = y(base), y1 = y(base + p.v);
            // the 2px gap: pull each segment's inner edge away from the one below
            var gapped = j > 0 ? (sign > 0 ? y0 - 2 : y0 + 2) : y0;
            if (Math.abs(y1 - gapped) >= 1) {
              var d = outer ? barPath(x0, barW, gapped, y1)
                : 'M' + x0 + ',' + gapped + 'V' + y1 + 'H' + (x0 + barW) + 'V' + gapped + 'Z';
              if (d) svgEl('path', { d: d, fill: p.s.color, class: 'fc-bar' + (i === opts.partial ? ' fc-bar--partial' : '') }, svg);
            }
            base += p.v;
          });
        });
      });
      if (opts.line) {
        var d = '';
        opts.line.values.forEach(function (v, i) { if (v != null) d += (d && opts.line.values[i - 1] != null ? 'L' : 'M') + xAt(i) + ',' + y(v); });
        svgEl('path', { d: d, stroke: opts.line.color, class: 'fc-line' }, svg);
        opts.line.values.forEach(function (v, i) { if (v != null) svgEl('circle', { cx: xAt(i), cy: y(v), r: 4, fill: opts.line.color, class: 'fc-dot' }, svg); });
      }
      var everything = series.concat(opts.line ? [opts.line] : []);
      labels.forEach(function (l, i) {
        var hit = svgEl('rect', { x: g.left + band * i, y: g.top, width: band, height: ph, class: 'fc-hit' }, svg);
        hit.addEventListener('pointerenter', function () {
          hover.setAttribute('x', g.left + band * i); hover.classList.add('show');
          tip.show((opts.titles || labels)[i], everything.filter(function (s) { return s.values[i]; }).map(function (s) {
            return { color: s.color, value: fmt(s.values[i]), name: s.name };
          }), xAt(i) + barW / 2, g.top, width);
        });
        hit.addEventListener('pointerleave', function () { hover.classList.remove('show'); tip.hide(); });
      });
      if (opts.table !== false) table(f.fig, opts.titles || labels, everything, fmt);
    });
  }

  /* ---------- money flow: every source into one trunk, out to a few groups ---------- */
  // opts: { sources: [{ name, value, color }], trunk: 'Came in',
  //         groups: [{ name, value, color, items: [{ name, value }] }],
  //         format, ariaLabel }
  // One trunk in the middle means no ribbons cross. Wide: left to right, with
  // labels beside the nodes. Narrow (phones): top to bottom, the sources named
  // above. Under either, the groups as a list that opens to show what's in
  // each (a tap on a group in the chart opens its row too).
  function moneyFlow(el, opts) {
    mount(el, function (width) {
      var fmt = opts.format || String, S = opts.sources, G = opts.groups;
      var sum = function (list) { return list.reduce(function (m, x) { return m + Math.max(0, x.value); }, 0) || 1; };
      var sTotal = sum(S), gTotal = sum(G);
      var pct = function (v) { return Math.round(v / gTotal * 100) + '%'; };
      var fig = htmlEl('div', 'fc fc-mflow', el), plot = htmlEl('div', 'fc-plot', fig);
      var tip = tooltip(plot), rows = [], svg;
      var curve = function (x1, ya, ha, x2, yb, hb) {
        var mx = (x1 + x2) / 2;
        return 'M' + x1 + ',' + ya + 'C' + mx + ',' + ya + ' ' + mx + ',' + yb + ' ' + x2 + ',' + yb +
          'L' + x2 + ',' + (yb + hb) + 'C' + mx + ',' + (yb + hb) + ' ' + mx + ',' + (ya + ha) + ' ' + x1 + ',' + (ya + ha) + 'Z';
      };
      // The same, turned on its side (top to bottom).
      var curveDown = function (xa, wa, y1, xb, wb, y2) {
        var my = (y1 + y2) / 2;
        return 'M' + xa + ',' + y1 + 'C' + xa + ',' + my + ' ' + xb + ',' + my + ' ' + xb + ',' + y2 +
          'L' + (xb + wb) + ',' + y2 + 'C' + (xb + wb) + ',' + my + ' ' + (xa + wa) + ',' + my + ' ' + (xa + wa) + ',' + y1 + 'Z';
      };
      function hover(node, title, value, color, i) {
        node.addEventListener('pointerenter', function (e) {
          node.classList.add('on');
          var r = svg.getBoundingClientRect();
          tip.show(title, [{ color: color, value: value, name: '' }], e.clientX - r.left, Math.max(0, e.clientY - r.top - 60), width);
        });
        node.addEventListener('pointerleave', function () { node.classList.remove('on'); tip.hide(); });
        if (i != null) node.addEventListener('click', function () { openRow(i); });
      }
      function openRow(i) {
        var d = rows[i];
        if (!d) return;
        if (d.tagName === 'DETAILS') d.open = true;
        d.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      }
      var groupTitle = function (g) { return g.name + ' · ' + pct(g.value); };

      if (width >= 560) {
        var nodeW = 12, top = 38, gap = 8;
        var lw = Math.min(190, Math.max.apply(null, S.map(function (x) { return Math.max(textWidth(x.name, 12), textWidth(fmt(x.value), 11)); })) + 14);
        var rw = Math.min(210, Math.max.apply(null, G.map(function (x) { return Math.max(textWidth(x.name, 12), textWidth(fmt(x.value) + ' · 00%', 11)); })) + 14);
        var hh = Math.max(240, G.length * 50, S.length * 44), h = top + hh;
        svg = svgEl('svg', { width: width, height: h, viewBox: '0 0 ' + width + ' ' + h, role: 'img', 'aria-label': opts.ariaLabel || '' }, plot);
        var xS = lw, xG = width - rw - nodeW, xT = Math.round((xS + xG) / 2);
        // Each node at least 20px tall, so a small group still has room for
        // its label; the bigger ones give up the difference.
        var place = function (list, total) {
          var avail = hh - gap * (list.length - 1), minH = Math.min(20, avail / list.length), y = top;
          var hs = list.map(function (x) { return Math.max(0, x.value) / total * avail; });
          var small = hs.filter(function (v) { return v < minH; });
          var extra = small.reduce(function (m, v) { return m + minH - v; }, 0);
          var big = hs.reduce(function (m, v) { return v >= minH ? m + v : m; }, 0);
          return hs.map(function (v) {
            var hh2 = v < minH ? minH : v - (big ? extra * v / big : 0);
            var o = { y: y, h: hh2 }; y += hh2 + gap; return o;
          });
        };
        var ps = place(S, sTotal), pg = place(G, gTotal);
        // Into the trunk, then out of it, each in order, so nothing crosses.
        var at = top;
        S.forEach(function (s, i) {
          var hb = Math.max(0, s.value) / sTotal * hh;
          hover(svgEl('path', { d: curve(xS + nodeW, ps[i].y, ps[i].h, xT, at, hb), fill: s.color, class: 'fc-ribbon' }, svg), s.name, fmt(s.value), s.color);
          at += hb;
        });
        at = top;
        G.forEach(function (g, i) {
          var ha = Math.max(0, g.value) / gTotal * hh;
          hover(svgEl('path', { d: curve(xT + nodeW, at, ha, xG, pg[i].y, pg[i].h), fill: g.color, class: 'fc-ribbon fc-ribbon--pick' }, svg), groupTitle(g), fmt(g.value), g.color, i);
          at += ha;
        });
        S.forEach(function (s, i) {
          svgEl('rect', { x: xS, y: ps[i].y, width: nodeW, height: ps[i].h, rx: 3, fill: s.color, class: 'fc-node' }, svg);
          var cy = ps[i].y + ps[i].h / 2;
          svgEl('text', { x: xS - 8, y: cy - 1, 'text-anchor': 'end', class: 'fc-flow-label' }, svg).textContent = s.name;
          if (ps[i].h >= 26) svgEl('text', { x: xS - 8, y: cy + 13, 'text-anchor': 'end', class: 'fc-flow-value fc-val' }, svg).textContent = fmt(s.value);
        });
        svgEl('rect', { x: xT, y: top, width: nodeW, height: hh, rx: 3, fill: S[0] ? S[0].color : 'var(--fc-1)', class: 'fc-node' }, svg);
        svgEl('text', { x: xT + nodeW / 2, y: 13, 'text-anchor': 'middle', class: 'fc-flow-label' }, svg).textContent = opts.trunk || 'Came in';
        svgEl('text', { x: xT + nodeW / 2, y: 28, 'text-anchor': 'middle', class: 'fc-flow-value fc-val' }, svg).textContent = fmt(sTotal);
        G.forEach(function (g, i) {
          var node = svgEl('rect', { x: xG, y: pg[i].y, width: nodeW, height: pg[i].h, rx: 3, fill: g.color, class: 'fc-node fc-node--pick' }, svg);
          hover(node, groupTitle(g), fmt(g.value), g.color, i);
          var cy = pg[i].y + pg[i].h / 2;
          svgEl('text', { x: xG + nodeW + 8, y: cy - 1, class: 'fc-flow-label' }, svg).textContent = g.name;
          if (pg[i].h >= 26) svgEl('text', { x: xG + nodeW + 8, y: cy + 13, class: 'fc-flow-value fc-val' }, svg).textContent = fmt(g.value) + ' · ' + pct(g.value);
        });
      } else {
        // Phones: what came in across the top (sources named above it),
        // fanning down into the groups, which the list below names.
        var head = htmlEl('div', 'fc-mflow-head', plot);
        var ht = htmlEl('div', 'fc-mflow-total', head);
        htmlEl('span', null, ht, (opts.trunk || 'Came in') + ' ');
        htmlEl('strong', 'fc-val', ht, fmt(sTotal));
        var srcs = htmlEl('div', 'fc-mflow-srcs', head);
        S.forEach(function (s) {
          var it = htmlEl('span', 'fc-legend-item', srcs);
          htmlEl('span', 'fc-key', it).style.background = s.color;
          htmlEl('span', null, it, s.name + ' ');
          htmlEl('span', 'fc-val fc-mflow-sv', it, fmt(s.value));
        });
        var barH = 12, h2 = 150, gapX = 6;
        svg = svgEl('svg', { width: width, height: h2, viewBox: '0 0 ' + width + ' ' + h2, role: 'img', 'aria-label': opts.ariaLabel || '' }, plot);
        var x = 0;
        S.forEach(function (s, i) {
          var w = Math.max(0, s.value) / sTotal * width;
          svgEl('rect', { x: x + (i ? 1 : 0), y: 0, width: Math.max(1, w - (i ? 1 : 0)), height: barH, rx: 3, fill: s.color, class: 'fc-node' }, svg);
          x += w;
        });
        var avail = width - gapX * (G.length - 1), gx = 0, tx = 0;
        G.forEach(function (g, i) {
          var tw = Math.max(0, g.value) / gTotal * width, gw = Math.max(3, Math.max(0, g.value) / gTotal * avail);
          hover(svgEl('path', { d: curveDown(tx, tw, barH, gx, gw, h2 - barH), fill: g.color, class: 'fc-ribbon fc-ribbon--pick' }, svg), groupTitle(g), fmt(g.value), g.color, i);
          var node = svgEl('rect', { x: gx, y: h2 - barH, width: gw, height: barH, rx: 3, fill: g.color, class: 'fc-node fc-node--pick' }, svg);
          hover(node, groupTitle(g), fmt(g.value), g.color, i);
          tx += tw; gx += gw + gapX;
        });
      }

      // The groups as a list: a row each, opening to its categories.
      var list = htmlEl('div', 'fc-mflow-list', fig);
      G.forEach(function (g, i) {
        var items = (g.items || []).filter(function (x) { return x.value > 0; });
        var row = htmlEl(items.length ? 'details' : 'div', 'fc-mflow-row', list);
        var sum2 = htmlEl(items.length ? 'summary' : 'div', 'fc-mflow-sum', row);
        htmlEl('span', 'fc-key', sum2).style.background = g.color;
        htmlEl('span', 'fc-mflow-name', sum2, g.name);
        htmlEl('span', 'fc-mflow-pct', sum2, pct(g.value));
        htmlEl('strong', 'fc-val', sum2, fmt(g.value));
        if (items.length) {
          var ul = htmlEl('ul', 'fc-mflow-items', row);
          items.forEach(function (x) {
            var li = htmlEl('li', null, ul);
            htmlEl('span', null, li, x.name);
            htmlEl('span', 'fc-val', li, fmt(x.value));
          });
        }
        rows.push(row);
      });
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
      // opts.attr: rows become tappable, carrying their key in that attribute.
      if (opts.attr && r.key != null) { row.setAttribute(opts.attr, r.key); row.classList.add('fc-hrow--link'); row.tabIndex = 0; }
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

  window.FinCharts = { line: line, bars: bars, stackedBars: stackedBars, moneyFlow: moneyFlow, hbars: hbars, sparkline: sparkline, niceTicks: niceTicks };
})();
