/* ============================================================
   Documents - the page scanner (window.DocScanner).
   Photograph a manual page by page: the camera runs inside the page (or
   the phone's camera app, as a fallback); each shot is cropped to the page
   and straightened (OpenCV), an open book is split into its two pages, the
   text is recognized on the device (Tesseract), and it all becomes one PDF
   with an invisible text layer, so it can be searched and copied (pdf-lib).

   Used for manuals, and for receipts and other documents on phones.
   DocScanner.open({ title, start: [Blob], mode }) resolves to
     { pdf: Blob, pages, thumb: Blob, read: [Blob] }  or null (closed).
   Needs hub.js. The libraries load from CDNs the first time it opens.
   ============================================================ */
(function () {
  'use strict';
  var esc = Hub.esc, I = Hub.icons;

  var LIB = {
    cv: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
    tess: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    tessWorker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    tessCore: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    tessLang: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
  };
  var PAGE_MAX = 2400;   // longest side of a finished page, in pixels
  var PAGE_MIN = 1700;   // a smaller page (a card, a little booklet) is enlarged to this...
  var GROW_MAX = 2.5;    // ...but never more than this many times its size in the photo
  var SHOT_MAX = 4096;   // longest side a shot is worked on at (a 12 MP photo, untouched)
  var PDF_WIDTH = 612;   // points: pages are 8.5 inches wide, as tall as the page is
  var LIVE_MS = 175;     // how often the live outline looks for the page
  var LIVE_AT = 360;     // ...and the size of the frame it looks at
  var SHOT_AT = 800;     // the size a shot is searched at

  /* ---------- loading the libraries ---------- */
  var scripts = {};
  function script(src) {
    if (!scripts[src]) scripts[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { delete scripts[src]; reject(new Error('Couldn’t load part of the scanner. Check the connection and try again.')); };
      document.head.appendChild(s);
    });
    return scripts[src];
  }
  var cvP = null;
  function opencv() {
    if (!cvP) {
      cvP = script(LIB.cv).then(function () {
        return new Promise(function (resolve, reject) {
          var c = window.cv;
          // OpenCV's module has its own then(), which hands back the module
          // itself: resolving a promise with it would wait on it forever and
          // freeze the page. Take then() off before passing it on.
          function ready(m) {
            if (m && typeof m.then === 'function') { try { delete m.then; } catch (e) { m.then = undefined; } }
            window.cv = m;
            resolve(m);
          }
          if (!c) return reject(new Error('Couldn’t start the page finder.'));
          if (c.Mat) return ready(c);
          if (typeof c.then === 'function') return c.then(ready);
          c.onRuntimeInitialized = function () { ready(c); };
        });
      });
      cvP.catch(function () { cvP = null; });
    }
    return cvP;
  }

  /* ---------- geometry ---------- */
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  // Corners in order: top-left, top-right, bottom-right, bottom-left. Sorted
  // around their middle first, so even a page turned 45° comes out in order.
  function orderQuad(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0] / pts.length; cy += p[1] / pts.length; });
    var ring = pts.slice().sort(function (a, b) { return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx); });
    var first = 0;
    ring.forEach(function (p, i) { if (p[0] + p[1] < ring[first][0] + ring[first][1]) first = i; });
    return ring.slice(first).concat(ring.slice(0, first));
  }
  function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }
  function quadArea(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) { var p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return Math.abs(a) / 2;
  }
  // How far apart two outlines are: the most any corner moved.
  function quadGap(a, b) {
    var g = 0;
    for (var i = 0; i < 4; i++) g = Math.max(g, dist(a[i], b[i]));
    return g;
  }
  function scaleQuad(q, s) { return q.map(function (p) { return [p[0] * s, p[1] * s]; }); }
  // The flattened size of an outline: its longer top/bottom and left/right.
  function quadSize(q) {
    return { w: Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h: Math.max(dist(q[0], q[3]), dist(q[1], q[2])) };
  }

  /* ---------- finding the page in a photo (OpenCV) ----------
     Every four-cornered shape the edges (and the bright areas) make is a
     candidate, and each one has to look like a page lying in the picture:
     convex, no corner too sharp or too flat, not a sliver, not the frame
     itself, and, above all, with a real edge running under each side. That
     last test is what keeps a patch of white table or a lamp's glare from
     turning into an outline that fills the screen. The best candidate is
     the largest, best-edged one, preferring the middle of the picture and
     wherever the page was a moment ago. */
  var MIN_PAGE = 0.04;   // of the picture: smaller shapes aren't the page
  var MAX_PAGE = 0.96;   // ...and one this big is the frame, not a page
  var finder = null;     // the small canvas detect() draws into, kept between calls
  function finderCanvas(w, h) {
    if (!finder) {
      finder = document.createElement('canvas');
      finder.ctx = finder.getContext('2d', { willReadFrequently: true });
    }
    if (finder.width !== w) finder.width = w;
    if (finder.height !== h) finder.height = h;
    return finder;
  }
  // Four-cornered outlines of every big enough shape in a black and white image.
  function shapes(cv, bin, W, H, out) {
    var contours = new cv.MatVector(), hier = new cv.Mat(), hull = new cv.Mat(), approx = new cv.Mat();
    try {
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      var n = contours.size(), minArea = W * H * MIN_PAGE;
      for (var i = 0; i < n; i++) {
        var cnt = contours.get(i);
        cv.convexHull(cnt, hull);
        // The hull, so a page edge broken by a thumb (or not seen at all
        // on one side) still closes into the page's shape.
        if (cv.contourArea(hull) >= minArea) {
          var peri = cv.arcLength(hull, true);
          for (var e = 0; e < 3; e++) {
            cv.approxPolyDP(hull, approx, [0.015, 0.03, 0.045][e] * peri, true);
            if (approx.rows === 4) {
              var d = approx.data32S;
              out.push(orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]));
              break;
            }
            if (approx.rows < 4) break;
          }
        }
        cnt.delete();
      }
    } finally {
      contours.delete(); hier.delete(); hull.delete(); approx.delete();
    }
  }
  // Which sides lie along the edge of the picture (the frame, not the page).
  function framedSides(q, W, H) {
    var mx = Math.max(3, W * 0.02), my = Math.max(3, H * 0.02), out = [];
    for (var i = 0; i < 4; i++) {
      var p = q[i], n = q[(i + 1) % 4];
      out.push((p[0] < mx && n[0] < mx) || (p[0] > W - mx && n[0] > W - mx) || (p[1] < my && n[1] < my) || (p[1] > H - my && n[1] > H - my));
    }
    return out;
  }
  // Is it shaped like a page seen through a camera? "long" is a part of a
  // long receipt, which may run off both the top and the bottom.
  function pageShaped(q, W, H, long) {
    var sign = 0, i;
    for (i = 0; i < 4; i++) {
      var a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      var ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
      var lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 8 || lv < 8) return false;
      var cross = ux * vy - uy * vx, s = cross > 0 ? 1 : -1;
      if (sign && s !== sign) return false; // not convex
      sign = s;
      var cos = (ux * vx + uy * vy) / (lu * lv);
      if (cos > 0.77 || cos < -0.77) return false; // a corner sharper than 40° or flatter than 140°
    }
    var top = dist(q[0], q[1]), bottom = dist(q[3], q[2]), left = dist(q[0], q[3]), right = dist(q[1], q[2]);
    if (Math.min(top, bottom) < Math.max(top, bottom) * 0.45 || Math.min(left, right) < Math.max(left, right) * 0.45) return false;
    var w = (top + bottom) / 2, h = (left + right) / 2;
    if (Math.max(w, h) > Math.min(w, h) * (long ? 9 : 4.5)) return false; // a receipt is long, but not a strip
    var area = quadArea(q) / (W * H);
    if (area < MIN_PAGE || area > MAX_PAGE) return false;
    // A side lying along the edge of the picture is the frame, not the
    // page's edge. One is fine (the page runs off the bottom); two is a
    // shape made by the frame, except a receipt running off both ends.
    var f = framedSides(q, W, H), framed = f.filter(Boolean).length;
    if (long && framed === 2) return (f[0] && f[2]) || (f[1] && f[3]);
    return framed < 2;
  }
  // For each side, the share of it with an edge underneath: a strong change
  // in brightness running the same way as the side, within a few pixels,
  // and lining up along the side (a straight edge), not scattered about
  // like the grain of a table or a pile of clutter.
  function edgeSupport(q, gx, gy, W, H) {
    var reach = Math.max(2, Math.round(Math.max(W, H) * 0.012)), out = [];
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len, ny = dx / len, steps = Math.max(12, Math.round(len / 3)), ts = [], offs = [];
      for (var k = 0; k < steps; k++) {
        var t = 0.08 + 0.84 * (k + 0.5) / steps, px = a[0] + dx * t, py = a[1] + dy * t;
        for (var o = 0; o <= reach * 2; o++) {
          var off = (o & 1 ? -1 : 1) * ((o + 1) >> 1); // 0, 1, -1, 2, -2…
          var x = Math.round(px + nx * off), y = Math.round(py + ny * off);
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          var j = y * W + x, ex = gx[j], ey = gy[j], across = ex * nx + ey * ny;
          if (across * across > 400 && across * across > 0.7 * (ex * ex + ey * ey)) { ts.push(t); offs.push(off); break; }
        }
      }
      out.push(straight(ts, offs) / steps);
    }
    return out;
  }
  // How many of the hits lie on one straight line (fitted twice, the
  // second time without the strays). The line may lean a little, since the
  // corners are only roughly placed, and may bow a little (a book's pages).
  function straight(ts, offs) {
    var keep = ts.map(function () { return true; }), line = [0, 0];
    for (var pass = 0; pass < 2; pass++) {
      var n = 0, st = 0, so = 0, stt = 0, sto = 0;
      ts.forEach(function (t, i) { if (keep[i]) { n++; st += t; so += offs[i]; stt += t * t; sto += t * offs[i]; } });
      if (n < 2) return n;
      var d = n * stt - st * st, slope = d > 1e-9 ? (n * sto - st * so) / d : 0;
      line = [(so - slope * st) / n, slope];
      var tol = pass ? 1.6 : 3;
      keep = ts.map(function (t, i) { return Math.abs(offs[i] - (line[0] + line[1] * t)) <= tol; });
    }
    return keep.filter(Boolean).length;
  }
  // The share of the inside that looks like paper: pale and without much
  // colour. A colourful cover still counts as a page when its edges are
  // clear; this only decides the doubtful shapes, like a patch of a
  // cluttered table.
  function paperShare(q, rgba, W, H, light) {
    var paper = 0, n = 0;
    for (var v = 0.1; v < 0.95; v += 0.1) {
      for (var u = 0.1; u < 0.95; u += 0.1) {
        var tx = q[0][0] + (q[1][0] - q[0][0]) * u, ty = q[0][1] + (q[1][1] - q[0][1]) * u;
        var bx = q[3][0] + (q[2][0] - q[3][0]) * u, by = q[3][1] + (q[2][1] - q[3][1]) * u;
        var x = Math.round(tx + (bx - tx) * v), y = Math.round(ty + (by - ty) * v);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        var j = (y * W + x) * 4, r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
        var hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        n++;
        if (hi - lo < 45 && hi > light) paper++;
      }
    }
    return n ? paper / n : 0;
  }
  // The page's four corners in the source's own pixels, or null. "near" is
  // an outline (in the same pixels) to prefer: where the page just was.
  function detect(cv, source, w, h, workAt, near, long) {
    var s = Math.min(1, (workAt || 640) / Math.max(w, h));
    var W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    var c = finderCanvas(W, H);
    c.ctx.drawImage(source, 0, 0, W, H);
    var src = cv.imread(c), gray = new cv.Mat(), edges = new cv.Mat(), bright = new cv.Mat();
    var dx = new cv.Mat(), dy = new cv.Mat(), k = cv.Mat.ones(3, 3, cv.CV_8U);
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      var blur = W * H > 300000 ? 7 : 5;
      cv.GaussianBlur(gray, gray, new cv.Size(blur, blur), 0);
      cv.Sobel(gray, dx, cv.CV_16S, 1, 0, 3);
      cv.Sobel(gray, dy, cv.CV_16S, 0, 1, 3);
      var cands = [];
      cv.Canny(gray, edges, 20, 60);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
      cv.dilate(edges, edges, k);
      shapes(cv, edges, W, H, cands);
      // Bright areas too: a page whose edges are faint is often still the
      // brightest thing in the picture.
      cv.threshold(gray, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      shapes(cv, bright, W, H, cands);
      var gx = dx.data16S, gy = dy.data16S, best = null, bestScore = 0;
      var prior = near ? scaleQuad(near, s) : null, diag = Math.hypot(W, H);
      var light = Math.min(200, cv.mean(gray)[0] + 10);
      cands.forEach(function (q) {
        if (!pageShaped(q, W, H, long)) return;
        var sup = edgeSupport(q, gx, gy, W, H), fr = framedSides(q, W, H);
        // A receipt's ends at the edge of the picture have no edge to show.
        var real = long ? sup.filter(function (v, i) { return !fr[i]; }) : sup;
        var mean = real.reduce(function (a, v) { return a + v; }, 0) / real.length;
        if (real.length === 4) {
          // Three sides need a clear edge; the fourth may be faint (white
          // paper on a white table) or hidden by a hand.
          var sorted = sup.slice().sort(function (a, b) { return b - a; });
          if (sorted[2] < 0.5 || mean < 0.6) return;
        } else if (Math.min.apply(null, real) < 0.5 || mean < 0.6) return;
        var area = quadArea(q) / (W * H), paper = paperShare(q, src.data, W, H, light);
        // A shape with so-so edges, or a small one, has to look like paper.
        if ((mean < 0.8 || area < 0.1) && paper < 0.45) return;
        var score = area * mean * mean * (0.6 + 0.4 * paper);
        if (!pointInQuad([W / 2, H / 2], q)) score *= 0.6;
        if (prior && quadGap(q, prior) < diag * 0.1) score *= 1.5;
        if (score > bestScore) { bestScore = score; best = q; }
      });
      return best ? scaleQuad(best, 1 / s) : null;
    } finally {
      src.delete(); gray.delete(); edges.delete(); bright.delete(); dx.delete(); dy.delete(); k.delete();
    }
  }
  // A photo: looked at in some detail first, then more coarsely (where
  // the paper's own texture or a busy table can hide the page's edges).
  function findPage(cv, canvas, near, long) {
    var w = canvas.width, h = canvas.height;
    return detect(cv, canvas, w, h, SHOT_AT, near, long) || detect(cv, canvas, w, h, 480, near, long);
  }
  function pointInQuad(p, q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      var cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]), s = cross > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }
  // The quad flattened into a w×h rectangle in one step (cubic, which keeps
  // the edges of letters crisper than linear), then lightly sharpened.
  // Only the part of the photo under the quad goes into OpenCV.
  function warp(cv, canvas, q, w, h) {
    var xs = q.map(function (p) { return p[0]; }), ys = q.map(function (p) { return p[1]; });
    var x0 = Math.max(0, Math.floor(Math.min.apply(null, xs)) - 2), y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)) - 2);
    var x1 = Math.min(canvas.width, Math.ceil(Math.max.apply(null, xs)) + 2), y1 = Math.min(canvas.height, Math.ceil(Math.max.apply(null, ys)) + 2);
    var part = document.createElement('canvas');
    part.width = Math.max(1, x1 - x0); part.height = Math.max(1, y1 - y0);
    part.getContext('2d').drawImage(canvas, x0, y0, part.width, part.height, 0, 0, part.width, part.height);
    var src = cv.imread(part), dst = new cv.Mat(), soft = new cv.Mat();
    var from = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat.apply([], q.map(function (p) { return [p[0] - x0, p[1] - y0]; })));
    var to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    var M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
      // Unsharp mask, wider when the page was enlarged (its blur is too).
      var grow = w / Math.max(1, quadSize(q).w), sigma = Math.min(2.2, Math.max(1, grow));
      cv.GaussianBlur(dst, soft, new cv.Size(0, 0), sigma);
      cv.addWeighted(dst, 1.7, soft, -0.7, 0, dst);
      var out = document.createElement('canvas');
      cv.imshow(out, dst);
      return out;
    } finally {
      src.delete(); dst.delete(); soft.delete(); from.delete(); to.delete(); M.delete(); part.width = part.height = 0;
    }
  }
  // How big to make the flattened page(s): pages capped at PAGE_MAX, and a
  // small one enlarged towards PAGE_MIN so its text isn't a smudge in the PDF.
  function pageScale(q, spread) {
    var z = quadSize(q), long = Math.max(spread ? z.w / 2 : z.w, z.h);
    if (long > PAGE_MAX) return PAGE_MAX / long;
    if (long < PAGE_MIN) return Math.min(GROW_MAX, PAGE_MIN / long);
    return 1;
  }

  /* ---------- tidying a page ---------- */
  function crop(canvas, x, y, w, h, max) {
    var s = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }
  // "Color": paper to white and ink to black, the way a scanner does it.
  function levels(canvas) {
    var ctx = canvas.getContext('2d'), img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
    var hist = new Uint32Array(256), n = 0, i;
    for (i = 0; i < d.length; i += 16) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++; }
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.9) { hi = i; break; } }
    if (hi - lo < 60) return;
    var lut = new Uint8ClampedArray(256);
    for (i = 0; i < 256; i++) lut[i] = (i - lo) * 255 / (hi - lo);
    for (i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    ctx.putImageData(img, 0, 0);
  }
  // "Black & white": crisp text, small files.
  function blackWhite(cv, canvas) {
    var src = cv.imread(canvas), gray = new cv.Mat(), bw = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      var block = Math.max(15, Math.round(Math.max(canvas.width, canvas.height) / 60) | 1);
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
      cv.imshow(canvas, bw);
    } finally {
      src.delete(); gray.delete(); bw.delete();
    }
  }
  // Shadow and lighting clean-up, before "Color" or "Black & white". The
  // light falling on the page is worked out from the bare paper alone
  // (on a small copy: the pixels nearly as bright as the brightest paper
  // around them, so not ink and not pictures), then filled in smoothly
  // under the text and pictures. Every pixel is then brightened by however
  // much less light its spot got than the best-lit paper: the shadow of a
  // hand or the phone, a dim corner and a lamp's glow all even out, and a
  // picture on the page is lit the same as the paper around it. A colour
  // cast (yellow indoor light) is taken out using the paper's colour,
  // unless that "paper" is strongly coloured (a coloured cover).
  var PAPER = 242;
  function clean(cv, canvas) {
    var W = canvas.width, H = canvas.height, s = Math.min(1, 640 / Math.max(W, H));
    var sw = Math.max(8, Math.round(W * s)), sh = Math.max(8, Math.round(H * s));
    var small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
    var src = cv.imread(small), lum = new cv.Mat(), top = new cv.Mat(), lf = new cv.Mat(), mask = new cv.Mat();
    var num1 = new cv.Mat(), den1 = new cv.Mat(), num2 = new cv.Mat(), den2 = new cv.Mat(), light = new cv.Mat(), big = new cv.Mat();
    var k = Math.max(7, Math.round(Math.max(sw, sh) / 30) | 1);
    var kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
    try {
      cv.cvtColor(src, lum, cv.COLOR_RGBA2GRAY);
      cv.dilate(lum, top, kernel); // the brightest nearby: the paper around the ink
      var L = lum.data, T = top.data, n = L.length, hist = new Uint32Array(256), i;
      for (i = 0; i < n; i++) hist[T[i]]++;
      var paper = 255, acc = 0;
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.1) { paper = i; break; } }
      if (paper < 40) return; // too dark to tell paper from anything
      // Bare paper: close to the brightest nearby, and not far below the
      // best-lit paper (a deep shadow still counts; a dark picture doesn't).
      lum.convertTo(lf, cv.CV_32F);
      mask.create(sh, sw, cv.CV_32F);
      var M = mask.data32F, F = lf.data32F, S = src.data, pr = 0, pg = 0, pb = 0, pn = 0;
      for (i = 0; i < n; i++) {
        var bare = L[i] >= T[i] * 0.82 && L[i] >= paper * 0.45;
        M[i] = bare ? 1 : 0;
        if (!bare) F[i] = 0;
        else if (L[i] >= paper * 0.85) { pr += S[i * 4]; pg += S[i * 4 + 1]; pb += S[i * 4 + 2]; pn++; }
      }
      // Fill in the light under everything else: a close look where
      // there's paper nearby, a wider one in big pictures.
      var s1 = Math.max(sw, sh) / 40, s2 = Math.max(sw, sh) / 8;
      cv.GaussianBlur(lf, num1, new cv.Size(0, 0), s1); cv.GaussianBlur(mask, den1, new cv.Size(0, 0), s1);
      cv.GaussianBlur(lf, num2, new cv.Size(0, 0), s2); cv.GaussianBlur(mask, den2, new cv.Size(0, 0), s2);
      var N1 = num1.data32F, D1 = den1.data32F, N2 = num2.data32F, D2 = den2.data32F;
      light.create(sh, sw, cv.CV_8U);
      var Lt = light.data;
      for (i = 0; i < n; i++) {
        var wide = D2[i] > 0.02 ? N2[i] / D2[i] : paper, w = Math.min(1, D1[i] / 0.3);
        Lt[i] = Math.max(1, Math.min(255, Math.round(w > 0 && D1[i] > 1e-4 ? w * N1[i] / D1[i] + (1 - w) * wide : wide)));
      }
      // The paper's colour: take a cast out, but not a coloured card's or
      // cover's own colour. Lamp light tints paper orange-yellow (red over
      // green over blue), so that's corrected even when strong; any other
      // tint only when very slight (the phone already balances colour),
      // since pale pink or blue paper is real.
      var gain = [1, 1, 1];
      if (pn) {
        var white = [pr / pn, pg / pn, pb / pn], hi = Math.max.apply(null, white), lo = Math.min.apply(null, white);
        var warm = white[0] >= white[1] && white[1] >= white[2];
        if (lo > 0 && hi / lo < (warm ? 1.8 : 1.06)) gain = white.map(function (v) { return Math.max(0.7, Math.min(1.6, (white[0] + white[1] + white[2]) / 3 / v)); });
      }
      cv.resize(light, big, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      var G = big.data, ctx = canvas.getContext('2d'), img = ctx.getImageData(0, 0, W, H), d = img.data;
      var lut = new Float32Array(256);
      for (i = 0; i < 256; i++) lut[i] = Math.min(3, Math.max(0.85, PAPER / Math.max(1, i)));
      var gr = gain[0], gg = gain[1], gb = gain[2];
      for (i = 0; i < G.length; i++) {
        var f = lut[G[i]], j = i * 4;
        d[j] = d[j] * gr * f; d[j + 1] = d[j + 1] * gg * f; d[j + 2] = d[j + 2] * gb * f;
      }
      ctx.putImageData(img, 0, 0);
    } finally {
      [src, lum, top, lf, mask, num1, den1, num2, den2, light, big, kernel].forEach(function (m) { m.delete(); });
      small.width = small.height = 0;
    }
  }

  /* ---------- which way up ---------- */
  // Lines of text running up and down instead of across: the page needs a
  // quarter turn. Counted from the ink: summed along each row, the lines
  // of a page the right way round make a strong stripe pattern; summed
  // along each column they mostly even out. Returns 1 (turn) or 0.
  function lineTurn(cv, canvas) {
    var s = Math.min(1, 700 / Math.max(canvas.width, canvas.height));
    var w = Math.max(8, Math.round(canvas.width * s)), h = Math.max(8, Math.round(canvas.height * s));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    var src = cv.imread(c), gray = new cv.Mat(), ink = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.adaptiveThreshold(gray, ink, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 15);
      var d = ink.data, rows = new Float32Array(h), cols = new Float32Array(w), total = 0;
      // Leave a margin out: page edges and shadows aren't text.
      var x0 = Math.round(w * 0.06), x1 = w - x0, y0 = Math.round(h * 0.06), y1 = h - y0;
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) if (d[y * w + x]) { rows[y]++; cols[x]++; total++; }
      var share = total / ((x1 - x0) * (y1 - y0));
      if (share < 0.01 || share > 0.35) return 0;
      var tr = stripes(rows, y0, y1), tc = stripes(cols, x0, x1);
      return tc > tr * 1.6 && tc > 0.25 ? 1 : 0;
    } finally {
      src.delete(); gray.delete(); ink.delete(); c.width = c.height = 0;
    }
  }
  // How stripy a profile is: its ups and downs (lightly smoothed), against its total.
  function stripes(p, a, b) {
    var sum = 0, tv = 0, prev = null;
    for (var i = a + 1; i < b - 1; i++) {
      var v = (p[i - 1] + 2 * p[i] + p[i + 1]) / 4;
      sum += v;
      if (prev != null) tv += Math.abs(v - prev);
      prev = v;
    }
    return sum ? tv / sum : 0;
  }
  // A canvas turned clockwise by this many quarter turns.
  function turnCanvas(canvas, quarters) {
    quarters = ((quarters % 4) + 4) % 4;
    if (!quarters) return canvas;
    var c = document.createElement('canvas'), odd = quarters % 2;
    c.width = odd ? canvas.height : canvas.width; c.height = odd ? canvas.width : canvas.height;
    var ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(quarters * Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }

  /* ---------- long receipts: lining up the parts ----------
     Each part is flattened to the same width, then each one is matched to
     the one above it (where the two pictures overlap) and laid in place:
     first by matching corners in the print (ORB features, then the
     shift/turn/zoom most of the matches agree on), and failing that by
     sliding the top of the lower part over the upper one. A part that
     can't be matched goes straight underneath. */
  function stitch(cv, strips) {
    if (strips.length === 1) return { canvas: strips[0], lost: 0 };
    var W = strips[0].width, T = [[1, 0, 0, 1, 0, 0]], lost = 0;
    for (var k = 1; k < strips.length; k++) {
      var m = null;
      try { m = matchFeatures(cv, strips[k - 1], strips[k]) || matchSlide(cv, strips[k - 1], strips[k]); } catch (e) { m = null; }
      if (!m) { m = [1, 0, 0, 1, 0, strips[k - 1].height]; lost++; }
      T.push(compose(T[k - 1], m));
    }
    // Where each part starts and stops on the long page, and the seams
    // between them (halfway through each overlap).
    var at = function (t, x, y) { return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]; };
    var seams = [0], bottom = 0;
    for (k = 1; k < strips.length; k++) {
      var top = at(T[k], W / 2, 0)[1], prevBottom = at(T[k - 1], W / 2, strips[k - 1].height)[1], seam = top;
      if (top < prevBottom) {
        // In the overlap, cut along a blank row between lines of print
        // (looked for around its middle), so no line is cut in two.
        var scale = Math.hypot(T[k][2], T[k][3]) || 1, a = (prevBottom - top) / scale;
        seam = at(T[k], W / 2, quietRow(strips[k], a * 0.25, a * 0.75))[1];
      }
      seams.push(Math.max(seams[k - 1] + 1, seam));
    }
    strips.forEach(function (c, i) { bottom = Math.max(bottom, at(T[i], 0, c.height)[1], at(T[i], W, c.height)[1]); });
    var H = Math.round(bottom);
    // Keep it inside what phones allow for one canvas.
    var f = Math.min(1, Math.sqrt(14e6 / (W * H)));
    var out = document.createElement('canvas');
    out.width = Math.round(W * f); out.height = Math.round(H * f);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = 'high';
    strips.forEach(function (c, i) {
      var y0 = seams[i] * f, y1 = (i + 1 < strips.length ? seams[i + 1] : H) * f, t = T[i];
      ctx.save();
      ctx.beginPath(); ctx.rect(0, y0, out.width, y1 - y0); ctx.clip();
      ctx.setTransform(t[0] * f, t[1] * f, t[2] * f, t[3] * f, t[4] * f, t[5] * f);
      ctx.drawImage(c, 0, 0);
      ctx.restore();
    });
    return { canvas: out, lost: lost };
  }
  // The row between y0 and y1 with the least ink (the middle, if all blank).
  function quietRow(c, y0, y1) {
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(c.height, Math.ceil(y1));
    if (y1 - y0 < 3) return (y0 + y1) / 2;
    var x0 = Math.round(c.width * 0.04), w = c.width - 2 * x0;
    var d = c.getContext('2d').getImageData(x0, y0, w, y1 - y0).data, best = (y0 + y1) / 2, bestInk = Infinity, mid = (y0 + y1) / 2;
    for (var r = 0; r < y1 - y0; r++) {
      var ink = 0;
      for (var x = 0; x < w; x += 2) { var j = (r * w + x) * 4; ink += 255 - (d[j] + d[j + 1] + d[j + 2]) / 3; }
      // Ties go to the middle of the overlap.
      ink += Math.abs(y0 + r - mid) * 0.01;
      if (ink < bestInk) { bestInk = ink; best = y0 + r; }
    }
    return best;
  }
  // a ∘ b, as canvas transforms [a, b, c, d, e, f].
  function compose(p, m) {
    return [p[0] * m[0] + p[2] * m[1], p[1] * m[0] + p[3] * m[1], p[0] * m[2] + p[2] * m[3], p[1] * m[2] + p[3] * m[3],
      p[0] * m[4] + p[2] * m[5] + p[4], p[1] * m[4] + p[3] * m[5] + p[5]];
  }
  function grayCopy(cv, canvas, s) {
    var c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(canvas.width * s)); c.height = Math.max(8, Math.round(canvas.height * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    var m = cv.imread(c), g = new cv.Mat();
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
    m.delete(); c.width = c.height = 0;
    return g;
  }
  // Where the lower part b sits on the upper part a, from matching
  // features: a transform from b's pixels to a's, or null.
  function matchFeatures(cv, a, b) {
    if (!cv.ORB || !cv.BFMatcher) return null;
    var s = Math.min(1, 720 / a.width);
    var ga = grayCopy(cv, a, s), gb = grayCopy(cv, b, s);
    // Only the bottom of the upper part and the top of the lower one can overlap.
    var ma = new cv.Mat(ga.rows, ga.cols, cv.CV_8UC1, new cv.Scalar(0)), mb = new cv.Mat(gb.rows, gb.cols, cv.CV_8UC1, new cv.Scalar(0));
    cv.rectangle(ma, new cv.Point(0, Math.round(ga.rows * 0.2)), new cv.Point(ga.cols, ga.rows), new cv.Scalar(255), -1);
    cv.rectangle(mb, new cv.Point(0, 0), new cv.Point(gb.cols, Math.round(gb.rows * 0.8)), new cv.Scalar(255), -1);
    var orb = new cv.ORB(2000), ka = new cv.KeyPointVector(), kb = new cv.KeyPointVector(), da = new cv.Mat(), db = new cv.Mat();
    var bf = null, knn = null;
    try {
      orb.detectAndCompute(ga, ma, ka, da);
      orb.detectAndCompute(gb, mb, kb, db);
      if (da.rows < 10 || db.rows < 10) return null;
      bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
      knn = new cv.DMatchVectorVector();
      bf.knnMatch(db, da, knn, 2);
      var pairs = [];
      for (var i = 0; i < knn.size(); i++) {
        var two = knn.get(i);
        if (two.size() < 2) continue;
        var m1 = two.get(0), m2 = two.get(1);
        if (m1.distance < 0.8 * m2.distance) {
          var pb = kb.get(m1.queryIdx).pt, pa = ka.get(m1.trainIdx).pt;
          pairs.push([pb.x, pb.y, pa.x, pa.y]);
        }
      }
      var t = similarity(pairs, 3);
      if (!t || t.inliers < 12) return null;
      var scale = Math.hypot(t.a, t.b), turn = Math.atan2(t.b, t.a);
      // Sensible for the next part of the same receipt: about the same
      // size and angle, starting lower down and overlapping.
      if (scale < 0.85 || scale > 1.18 || Math.abs(turn) > 0.12) return null;
      if (t.ty < ga.rows * 0.1 || t.ty > ga.rows - 8 || Math.abs(t.tx) > ga.cols * 0.2) return null;
      return [t.a, t.b, -t.b, t.a, t.tx / s, t.ty / s];
    } finally {
      ga.delete(); gb.delete(); ma.delete(); mb.delete(); orb.delete(); ka.delete(); kb.delete(); da.delete(); db.delete();
      if (bf) bf.delete();
      if (knn) knn.delete();
    }
  }
  // The shift, turn and zoom most of the matched points agree on (RANSAC
  // on pairs of matches, then refined on the ones that agree).
  function similarity(pairs, tol) {
    if (pairs.length < 4) return null;
    var seed = 12345, rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    var best = null, bestN = 0;
    function fit(p, q) {
      var dbx = q[0] - p[0], dby = q[1] - p[1], dax = q[2] - p[2], day = q[3] - p[3], n = dbx * dbx + dby * dby;
      if (n < 25) return null;
      var a = (dax * dbx + day * dby) / n, b = (day * dbx - dax * dby) / n;
      return { a: a, b: b, tx: p[2] - a * p[0] + b * p[1], ty: p[3] - b * p[0] - a * p[1] };
    }
    function agree(t) {
      return pairs.filter(function (p) {
        var x = t.a * p[0] - t.b * p[1] + t.tx, y = t.b * p[0] + t.a * p[1] + t.ty;
        return Math.hypot(x - p[2], y - p[3]) <= tol;
      });
    }
    for (var it = 0; it < 600; it++) {
      var t = fit(pairs[Math.floor(rnd() * pairs.length)], pairs[Math.floor(rnd() * pairs.length)]);
      if (!t) continue;
      var n = agree(t).length;
      if (n > bestN) { bestN = n; best = t; }
    }
    if (!best) return null;
    var inl = agree(best), mbx = 0, mby = 0, max = 0, may = 0;
    inl.forEach(function (p) { mbx += p[0]; mby += p[1]; max += p[2]; may += p[3]; });
    mbx /= inl.length; mby /= inl.length; max /= inl.length; may /= inl.length;
    var sa = 0, sb = 0, sn = 0;
    inl.forEach(function (p) {
      var bx = p[0] - mbx, by = p[1] - mby, ax = p[2] - max, ay = p[3] - may;
      sa += ax * bx + ay * by; sb += ay * bx - ax * by; sn += bx * bx + by * by;
    });
    if (!sn) return null;
    var A = sa / sn, Bv = sb / sn;
    return { a: A, b: Bv, tx: max - A * mbx + Bv * mby, ty: may - Bv * mbx - A * mby, inliers: agree({ a: A, b: Bv, tx: max - A * mbx + Bv * mby, ty: may - Bv * mbx - A * mby }).length };
  }
  // Fallback: slide a band from the top of b over a to find where it fits.
  function matchSlide(cv, a, b) {
    var s = Math.min(1, 600 / a.width);
    var ga = grayCopy(cv, a, s), gb = grayCopy(cv, b, s), res = new cv.Mat();
    var bx = Math.round(gb.cols * 0.05), by = Math.round(gb.rows * 0.03), bw = gb.cols - 2 * bx, bh = Math.round(gb.rows * 0.22);
    var ay = Math.round(ga.rows * 0.15);
    var band = null, area = null;
    try {
      if (bh < 12 || ga.rows - ay <= bh || ga.cols < bw) return null;
      band = gb.roi(new cv.Rect(bx, by, bw, bh));
      area = ga.roi(new cv.Rect(0, ay, ga.cols, ga.rows - ay));
      cv.matchTemplate(area, band, res, cv.TM_CCOEFF_NORMED);
      var mm = cv.minMaxLoc(res);
      if (mm.maxVal < 0.55) return null;
      return [1, 0, 0, 1, (mm.maxLoc.x - bx) / s, (ay + mm.maxLoc.y - by) / s];
    } finally {
      ga.delete(); gb.delete(); res.delete();
      if (band) band.delete();
      if (area) area.delete();
    }
  }

  function toBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Couldn’t save that page.')); }, type, q);
    });
  }
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo couldn’t be opened.')); };
      img.src = url;
    });
  }
  function shrink(blob, max, type) {
    return loadImage(blob).then(function (img) {
      return toBlob(crop(img, 0, 0, img.naturalWidth, img.naturalHeight, max), type || 'image/jpeg', 0.8);
    });
  }

  /* ---------- reading the text (Tesseract, on the device) ---------- */
  var tessP = null;
  function tesseract() {
    if (!tessP) {
      tessP = script(LIB.tess).then(function () {
        return window.Tesseract.createWorker('eng', 1, { workerPath: LIB.tessWorker, corePath: LIB.tessCore, langPath: LIB.tessLang });
      });
      tessP.catch(function () { tessP = null; });
    }
    return tessP;
  }

  /* ---------- building the PDF (pdf-lib) ---------- */
  // Helvetica only knows Western characters; anything else becomes "?".
  function pdfText(s) {
    return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E -ÿ]/g, '?').trim();
  }
  function buildPdf(pages, title, progress) {
    return script(LIB.pdf).then(function () {
      var L = window.PDFLib;
      return L.PDFDocument.create().then(function (doc) {
        doc.setTitle(title || 'Scanned document');
        doc.setProducer('Randall Family Hub');
        doc.setCreator('Randall Family Hub · Documents');
        return doc.embedFont(L.StandardFonts.Helvetica).then(function (font) {
          var chain = Promise.resolve();
          pages.forEach(function (pg, n) {
            chain = chain.then(function () {
              if (progress) progress(n, pages.length);
              return pg.blob.arrayBuffer();
            }).then(function (bytes) {
              return doc.embedJpg(bytes);
            }).then(function (img) {
              var W = PDF_WIDTH, H = Math.round(W * pg.h / pg.w), s = W / pg.w;
              var page = doc.addPage([W, H]);
              page.drawImage(img, { x: 0, y: 0, width: W, height: H });
              // The recognized text, invisible, laid over the picture line by line.
              var lines = (pg.lines || []).filter(function (l) { return pdfText(l.t); });
              if (!lines.length) return;
              var key = page.node.newFontDictionary(font.name, font.ref);
              var ops = [L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
              lines.forEach(function (l) {
                var t = pdfText(l.t), b = l.b;
                var bw = (b[2] - b[0]) * s, bh = (b[3] - b[1]) * s;
                if (!(bw > 1 && bh > 1)) return;
                var size = bh * 0.85, natural = font.widthOfTextAtSize(t, size);
                if (!(natural > 0)) return;
                ops.push(L.setFontAndSize(key, size), L.setCharacterSqueeze(Math.max(10, Math.min(400, bw / natural * 100))),
                  L.setTextMatrix(1, 0, 0, 1, b[0] * s, H - b[3] * s + bh * 0.2), L.showText(font.encodeText(t)));
              });
              ops.push(L.endText());
              page.pushOperators.apply(page, ops);
            });
          });
          return chain;
        }).then(function () { return doc.save(); });
      }).then(function (bytes) { return new Blob([bytes], { type: 'application/pdf' }); });
    });
  }

  /* ---------- the scanner ---------- */
  function open(opts) {
    opts = opts || {};
    return new Promise(function (resolveOpen) {
      var shots = [], pages = [], seq = 0;
      // opts.mode: the mode it opens in ('long' = Receipt, for adding a receipt).
      var mode = ['auto', 'single', 'spread', 'long'].indexOf(opts.mode) > -1 ? opts.mode : 'auto';
      var filter = 'color', handsFree = false, receipt = [];
      try { handsFree = localStorage.getItem('sc-handsfree') === '1'; } catch (e) { /* private mode */ }
      var stream = null, live = null, capturing = false, cropping = null, finished = false, wake = null;
      var work = Promise.resolve(), ocrQueue = [], ocrBusy = false, ocrBroken = false;

      var el = document.createElement('div');
      el.className = 'sc';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Scan pages');
      var modes = '<div class="sc-seg" data-modes>' + [['auto', 'Auto'], ['single', '1 page'], ['spread', 'Open book'], ['long', 'Receipt']].map(function (m) {
        return '<button type="button" data-mode="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>';
      el.innerHTML =
        '<section class="sc-cam" data-view="camera">' +
          '<div class="sc-bar"><button type="button" class="sc-icon" data-act="close" aria-label="Close">' + I.x + '</button>' +
            '<div class="sc-bar-end"><button type="button" class="sc-pill" data-act="handsfree" aria-pressed="false" title="Takes the picture by itself when the page is held still">' + I.sparkle + 'Hands-free</button>' +
            '<button type="button" class="sc-pill" data-act="filter"></button></div></div>' +
          '<div class="sc-modes">' + modes + '</div>' +
          '<div class="sc-stage">' +
            '<video playsinline muted autoplay></video><canvas class="sc-outline"></canvas><div class="sc-flash"></div>' +
            '<div class="sc-receipt" hidden><span data-rcount></span>' +
              '<button type="button" class="sc-pill" data-act="receipt-undo">Undo</button>' +
              '<button type="button" class="sc-pill sc-pill--on" data-act="receipt-done">Finish receipt</button></div>' +
            '<div class="sc-nocam" hidden><p></p><div class="sc-nocam-btns">' +
              '<button type="button" class="btn btn-primary" data-act="snap">' + I.camera + 'Take a photo</button>' +
              '<button type="button" class="btn btn-ghost" data-act="pick">' + I.image + 'Choose photos</button></div></div>' +
            '<p class="sc-tip"></p>' +
          '</div>' +
          '<div class="sc-controls">' +
            '<button type="button" class="sc-last" data-act="review" aria-label="See the pages"><span class="sc-last-img"></span><b>0</b></button>' +
            '<button type="button" class="sc-shutter" data-act="shoot" aria-label="Take a picture of the page"></button>' +
            '<div class="sc-side"><button type="button" class="sc-pill" data-act="snap" title="Use the camera app, for the sharpest photo">' + I.camera + 'Camera app</button>' +
              '<button type="button" class="sc-done" data-act="review">Done</button></div>' +
          '</div>' +
        '</section>' +
        '<section class="sc-review" data-view="review" hidden>' +
          '<div class="sc-rhead"><div><h2>Pages</h2><p data-status></p></div>' +
            '<div class="hub-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="filter"></button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="camera">' + I.camera + 'Add more</button></div></div>' +
          '<div class="sc-grid" data-grid></div>' +
          '<div class="sc-rfoot"><button type="button" class="btn btn-ghost" data-act="close">Cancel</button>' +
            '<button type="button" class="btn btn-primary" data-act="save">Save as PDF</button></div>' +
        '</section>' +
        '<section class="sc-crop" data-view="crop" hidden>' +
          '<div class="sc-bar"><button type="button" class="sc-pill" data-act="crop-cancel">Cancel</button><strong>Drag the corners to the page edges</strong>' +
            '<button type="button" class="sc-pill sc-pill--on" data-act="crop-apply">Done</button></div>' +
          '<div class="sc-crop-stage"><div class="sc-crop-box"><img alt="" /><svg preserveAspectRatio="none"><polygon /></svg></div></div>' +
          '<div class="sc-crop-tools"><div class="sc-seg" data-cropmodes>' +
            '<button type="button" data-cmode="single">One page</button><button type="button" data-cmode="spread">Open book (two pages)</button></div>' +
            '<button type="button" class="sc-pill" data-act="crop-full">Whole photo</button></div>' +
        '</section>' +
        '<div class="sc-saving" hidden><div class="sc-saving-box"><p data-saving>Getting the pages ready…</p><div class="sc-meter"><i></i></div>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="skip-ocr" hidden>Save without waiting for the text</button></div></div>' +
        '<input type="file" accept="image/*" capture="environment" hidden data-in="snap" />' +
        '<input type="file" accept="image/*" multiple hidden data-in="pick" />';
      document.body.appendChild(el);
      document.documentElement.classList.add('sc-open');
      var $ = function (s) { return el.querySelector(s); };
      var video = $('video'), outline = $('.sc-outline');

      function view(name) {
        if (name !== 'camera') finishReceipt();
        Array.prototype.forEach.call(el.querySelectorAll('[data-view]'), function (v) { v.hidden = v.getAttribute('data-view') !== name; });
        if (name === 'camera') startCamera(); else stopCamera();
        if (name === 'review') drawReview();
      }
      // Color: cleaned up (shadows and colour cast taken out). Black &
      // white: cleaned up, then turned to pure black and white. Original:
      // just as the camera saw it (photos, glossy covers).
      var FILTERS = { color: ['Color', 'bw'], bw: ['Black & white', 'photo'], photo: ['Original', 'color'] };
      var FILTER_TIPS = { bw: 'black & white (crisper text, smaller file)', photo: 'original (as the camera saw it, for photos and covers)', color: 'color (shadows and lighting cleaned up)' };
      function drawModes() {
        Array.prototype.forEach.call(el.querySelectorAll('[data-mode]'), function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
        Array.prototype.forEach.call(el.querySelectorAll('[data-act="filter"]'), function (b) {
          b.textContent = FILTERS[filter][0];
          b.title = 'Switch to ' + FILTER_TIPS[FILTERS[filter][1]];
        });
        var hf = $('[data-act="handsfree"]');
        hf.classList.toggle('sc-pill--on', handsFree);
        hf.setAttribute('aria-pressed', String(handsFree));
        $('.sc-shutter').classList.toggle('hf', handsFree);
        drawTip();
      }
      function drawTip() {
        var r = $('.sc-receipt');
        r.hidden = mode !== 'long';
        $('[data-rcount]').textContent = receipt.length ? 'Receipt: ' + Hub.plural(receipt.length, 'part') : 'Receipt';
        $('[data-act="receipt-undo"]').hidden = $('[data-act="receipt-done"]').hidden = !receipt.length;
        $('.sc-tip').textContent = mode === 'long'
          ? (receipt.length ? 'Move down so the next picture overlaps this one by about a third.' : 'Start at the top of the receipt. You’ll take it in parts, top to bottom.')
          : handsFree ? 'Hold steady over a page and it takes the picture. Turn the page for the next one.'
          : 'Hold the phone back until the words look sharp. The page doesn’t need to fill the screen.';
      }
      function drawCounter() {
        $('.sc-last b').textContent = pages.length;
        var last = pages[pages.length - 1];
        $('.sc-last-img').style.backgroundImage = last ? 'url("' + last.url + '")' : '';
        $('.sc-done').disabled = !shots.length && !receipt.length;
      }

      /* ----- camera ----- */
      function noCamera(msg) {
        $('.sc-nocam').hidden = false;
        $('.sc-nocam p').textContent = msg;
        $('.sc-shutter').disabled = true;
        $('.sc-tip').hidden = true;
      }
      function startCamera() {
        if (stream || finished) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCamera('This browser can’t show the camera here. Take each page with the camera app instead.');
        // As many pixels as the camera gives. Asked for as a square, so the
        // best mode wins whether the browser counts the phone as held
        // upright or sideways (asking for 3840×2160 on an upright phone can
        // land on 1080p, as that's "closer" to the sideways numbers).
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 4096 } } })
          .then(function (s) {
            if (finished || el.querySelector('[data-view="camera"]').hidden) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            stream = s;
            video.srcObject = s;
            video.play().catch(function () {});
            $('.sc-nocam').hidden = true;
            $('.sc-shutter').disabled = false;
            $('.sc-tip').hidden = false;
            keepFocusing(s.getVideoTracks()[0]);
            keepAwake(true);
            startOutline();
          })
          .catch(function (e) {
            noCamera(e && e.name === 'NotAllowedError'
              ? 'The camera is turned off for this site. Allow it in the browser’s settings, or take each page with the camera app.'
              : 'The camera isn’t available. Take each page with the camera app instead.');
          });
      }
      // Where the browser lets us (Chrome on Android), keep the focus
      // following the page instead of locking at whatever it found first.
      function keepFocusing(track) {
        try {
          var caps = track && track.getCapabilities ? track.getCapabilities() : {};
          if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
        } catch (e) { /* not supported: the camera's own default */ }
      }
      function stopCamera() {
        stopOutline();
        keepAwake(false);
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
        video.srcObject = null;
      }
      // Scanning hands-free means not touching the phone for a while: keep
      // the screen on while the camera's up (the browser lets go of this
      // whenever the page is hidden, so it's asked for again on return).
      function keepAwake(on) {
        if (!on) { if (wake) wake.release().catch(function () {}); wake = null; return; }
        if (wake || !navigator.wakeLock || document.visibilityState !== 'visible') return;
        navigator.wakeLock.request('screen').then(function (w) {
          if (!stream) { w.release().catch(function () {}); return; }
          wake = w;
          w.addEventListener('release', function () { if (wake === w) wake = null; });
        }).catch(function () { /* not allowed: the phone's own timeout */ });
      }
      function onVisible() { if (document.visibilityState === 'visible' && stream) keepAwake(true); }
      document.addEventListener('visibilitychange', onVisible);

      /* ----- the live outline -----
         Looks for the page about six times a second, and glides the green
         outline towards each new find on every screen frame, so it moves
         smoothly instead of jumping. A find far from the current outline
         has to be seen twice in a row before the outline goes there, and a
         page has to go missing three times running before it fades out:
         one odd frame (glare, a hand) can't throw it around. */
      function startOutline() {
        stopOutline();
        opencv().then(function (cv) {
          if (!stream || live) return;
          live = { cv: cv, raf: 0, w: 0, h: 0, lastLook: 0, lastFrame: 0, target: null, shown: null, alpha: 0, misses: 0, maybe: null, seen: 0, drawn: '',
            sig: null, prevQ: null, steadySince: 0, changed: true, shotSig: null, lastShot: 0, ring: -1 };
          live.raf = requestAnimationFrame(liveFrame);
        }).catch(function () {});
      }
      function stopOutline() {
        if (live) cancelAnimationFrame(live.raf);
        live = null;
        outline.getContext('2d').clearRect(0, 0, outline.width, outline.height);
      }
      function liveFrame(now) {
        var L = live;
        if (!L || !stream) return;
        L.raf = requestAnimationFrame(liveFrame);
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw) return;
        if (L.w !== vw || L.h !== vh) { L.w = vw; L.h = vh; L.target = L.shown = L.maybe = null; L.alpha = 0; } // the phone turned
        if (!capturing && now - L.lastLook >= LIVE_MS) {
          L.lastLook = now;
          var q = null;
          try { q = detect(L.cv, video, vw, vh, LIVE_AT, L.target, mode === 'long'); } catch (e) { q = null; }
          follow(L, q, Math.hypot(vw, vh));
          watchStill(L, now, Math.hypot(vw, vh));
        }
        glide(L, now);
        drawOutline(L);
        drawRing(L, now);
      }

      /* ----- hands-free -----
         Takes the picture once the outline and the picture have both held
         still for HOLD_MS, but only after something has changed since the
         last picture: the page went out of view, a hand went past (turning
         the page), or the view looks different. So it takes each page
         once, however long the phone stays over it. The shutter's ring
         fills up while it waits. */
      var HOLD_MS = 900;
      var sigCanvas = document.createElement('canvas');
      sigCanvas.width = 40; sigCanvas.height = 30;
      var sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
      // A tiny grey copy of the frame, brightness levelled, for spotting movement.
      function frameSig() {
        sigCtx.drawImage(video, 0, 0, 40, 30);
        var d = sigCtx.getImageData(0, 0, 40, 30).data, g = new Float32Array(1200), mean = 0, i;
        for (i = 0; i < 1200; i++) { g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; mean += g[i] / 1200; }
        for (i = 0; i < 1200; i++) g[i] -= mean;
        return g;
      }
      function sigDiff(a, b) {
        var s = 0;
        for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
        return s / a.length;
      }
      function watchStill(L, now, diag) {
        if (!handsFree) { L.steadySince = 0; return; }
        var sig = frameSig(), motion = L.sig ? sigDiff(sig, L.sig) : 99;
        L.sig = sig;
        var still = L.target && L.prevQ && quadGap(L.target, L.prevQ) < diag * 0.015 && motion < 5;
        L.prevQ = L.target ? L.target.map(function (p) { return p.slice(); }) : null;
        if (!L.target || motion > 12 || (L.shotSig && sigDiff(sig, L.shotSig) > 16)) L.changed = true;
        if (!still) L.steadySince = 0;
        else if (!L.steadySince) L.steadySince = now;
        if (L.changed && L.steadySince && now - L.steadySince >= HOLD_MS && now - L.lastShot > 1200 && !capturing) shoot();
      }
      function drawRing(L, now) {
        var p = handsFree && L.changed && L.steadySince && !capturing ? Math.min(1, (now - L.steadySince) / HOLD_MS) : 0;
        p = Math.round(p * 100) / 100;
        if (p !== L.ring) { L.ring = p; $('.sc-shutter').style.setProperty('--p', p); }
      }
      function follow(L, q, diag) {
        if (!q) {
          L.maybe = null;
          if (++L.misses >= 3) L.target = null;
          return;
        }
        L.misses = 0;
        if (L.target && quadGap(q, L.target) < diag * 0.15) { L.target = q; L.maybe = null; return; }
        // Somewhere new (or the first sighting): only once it's seen again.
        if (L.maybe && quadGap(q, L.maybe) < diag * 0.15) {
          if (++L.seen >= 2) { L.target = q; L.maybe = null; return; }
        } else L.seen = 1;
        L.maybe = q;
      }
      function glide(L, now) {
        var dt = L.lastFrame ? Math.min(100, now - L.lastFrame) : 16;
        L.lastFrame = now;
        if (L.target) {
          if (!L.shown || L.alpha < 0.03) L.shown = L.target.map(function (p) { return p.slice(); }); // appears where it is
          else {
            var k = 1 - Math.exp(-dt / 85);
            L.shown.forEach(function (p, i) { p[0] += (L.target[i][0] - p[0]) * k; p[1] += (L.target[i][1] - p[1]) * k; });
          }
        }
        var goal = L.target ? 1 : 0;
        L.alpha += (goal - L.alpha) * (1 - Math.exp(-dt / (goal ? 90 : 160)));
        if (Math.abs(goal - L.alpha) < 0.005) L.alpha = goal;
      }
      function drawOutline(L) {
        var r = video.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        var cw = Math.round(r.width * dpr), ch = Math.round(r.height * dpr);
        // Redraw only when something on it changed.
        var key = cw + 'x' + ch + ':' + L.alpha.toFixed(3) + ':' + (L.shown && L.alpha ? L.shown.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') : '');
        if (key === L.drawn) return;
        L.drawn = key;
        if (outline.width !== cw) outline.width = cw;
        if (outline.height !== ch) outline.height = ch;
        var ctx = outline.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        if (!L.shown || !L.alpha) return;
        // The video is drawn "cover", so map its pixels the same way.
        var s = Math.max(cw / L.w, ch / L.h), ox = (cw - L.w * s) / 2, oy = (ch - L.h * s) / 2;
        ctx.globalAlpha = L.alpha;
        ctx.beginPath();
        L.shown.forEach(function (p, i) { var x = ox + p[0] * s, y = oy + p[1] * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.closePath();
        ctx.lineWidth = 3 * dpr;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#34D399';
        ctx.fillStyle = 'rgba(52, 211, 153, 0.15)';
        ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      /* ----- taking a picture -----
         Pressing the shutter shakes the phone, so it watches the next few
         frames (about half a second) and keeps the sharpest one, judged on
         a patch of the page at full size. The flash comes once it has it. */
      function shoot() {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !stream || capturing) return;
        capturing = true;
        var shutter = $('.sc-shutter');
        shutter.classList.add('busy');
        var hint = live && live.target ? { quad: live.target.map(function (p) { return p.slice(); }), w: vw, h: vh } : null;
        var forLong = mode === 'long';
        sharpestFrame(hint).then(function (c) {
          if (!c) return;
          var f = $('.sc-flash');
          f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
          // (Only after a tap: browsers refuse it before, and say so in the console.)
          if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(15);
          // This view is taken: hands-free waits for something to change.
          if (live) { live.changed = false; live.steadySince = 0; live.lastShot = performance.now(); try { live.shotSig = frameSig(); } catch (e) { live.shotSig = null; } }
          return toBlob(c, 'image/jpeg', 0.95).then(function (b) {
            c.width = c.height = 0;
            if (forLong) { receipt.push({ blob: b, hint: hint }); drawTip(); drawCounter(); }
            else addShot(b, null, hint);
          });
        }).catch(function () {
          Hub.toast('Couldn’t take that picture. Try again.', true);
        }).then(function () {
          capturing = false;
          shutter.classList.remove('busy');
        });
      }
      function sharpestFrame(hint) {
        var cv = window.cv && window.cv.Mat ? window.cv : null;
        var vw = video.videoWidth, vh = video.videoHeight, start = performance.now(), n = 0, bestScore = -1;
        var best = document.createElement('canvas');
        best.width = vw; best.height = vh;
        var bctx = best.getContext('2d');
        // Judge it in the middle of the page (or of the picture).
        var cx = vw / 2, cy = vh / 2;
        if (hint) { cx = 0; cy = 0; hint.quad.forEach(function (p) { cx += p[0] / 4; cy += p[1] / 4; }); }
        return new Promise(function (resolve) {
          function look() {
            if (!stream || video.videoWidth !== vw) return resolve(n ? best : null);
            var score = 0;
            if (cv) { try { score = sharpness(cv, cx, cy, vw, vh); } catch (e) { cv = null; } }
            if (score > bestScore) { bestScore = score; bctx.drawImage(video, 0, 0, vw, vh); }
            n++;
            if (!cv || n >= 6 || performance.now() - start > 550) return resolve(best);
            nextFrame(look);
          }
          look();
        });
      }
      function nextFrame(fn) {
        var done = false, go = function () { if (!done) { done = true; fn(); } };
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(go);
        else requestAnimationFrame(go);
        setTimeout(go, 120); // in case no new frame comes
      }
      var probe = document.createElement('canvas');
      // Sharpness: how much the fine detail varies (the variance of the
      // Laplacian) in a 320px patch of the frame, at full size.
      function sharpness(cv, cx, cy, vw, vh) {
        var S = Math.min(320, vw, vh);
        probe.width = probe.height = S;
        var sx = Math.max(0, Math.min(vw - S, Math.round(cx - S / 2))), sy = Math.max(0, Math.min(vh - S, Math.round(cy - S / 2)));
        probe.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, S, S, 0, 0, S, S);
        var m = cv.imread(probe), g = new cv.Mat(), lap = new cv.Mat(), mean = new cv.Mat(), sd = new cv.Mat();
        try {
          cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
          cv.Laplacian(g, lap, cv.CV_32F, 3);
          cv.meanStdDev(lap, mean, sd);
          return sd.data64F[0] * sd.data64F[0];
        } finally {
          m.delete(); g.delete(); lap.delete(); mean.delete(); sd.delete();
        }
      }

      /* ----- shots and pages ----- */
      // hint: the live outline when the shutter was pressed, in video pixels.
      // turns: quarter turns per page of the shot (worked out once, then
      // kept, along with any turning by hand); checked: which pages have
      // had their text checked for being upside down.
      function addShot(blob, forceMode, hint) {
        var m = forceMode || mode;
        var shot = { id: ++seq, blob: blob, mode: m === 'long' ? 'single' : m, filter: filter, quad: null, hint: hint || null, w: 0, h: 0, busy: true, turns: [], checked: [] };
        shots.push(shot);
        drawCounter();
        process(shot);
      }
      // A long receipt: its parts, top to bottom, become one long page.
      function addLong(parts) {
        var shot = { id: ++seq, parts: parts, mode: 'long', filter: filter, busy: true, turns: [], checked: [] };
        shots.push(shot);
        drawCounter();
        process(shot);
      }
      function finishReceipt() {
        if (!receipt.length) return;
        addLong(receipt);
        receipt = [];
        drawTip();
        drawCounter();
      }
      // The live outline in this working copy's pixels, if the picture is
      // the frame it was found on.
      function hintFor(t, w, h) {
        if (!t || Math.abs(t.w / t.h - w / h) > 0.01) return null;
        return scaleQuad(t.quad, w / t.w);
      }
      // Turns a shot into its page(s), one shot at a time (the phone's memory).
      // The page's corners in a working copy: what the live outline showed
      // when the shutter was pressed is what was promised, so a sharper look
      // at the photo may fine-tune those corners, but not jump elsewhere.
      function cornersFor(cv, canvas, hint, long) {
        var near = hintFor(hint, canvas.width, canvas.height), q = null;
        try { q = findPage(cv, canvas, near, long); } catch (e) { q = null; }
        if (near && (!q || quadGap(q, near) > Math.hypot(canvas.width, canvas.height) * 0.1)) q = near;
        return q;
      }
      // An ordinary shot: one page, or two from an open book.
      function shotPages(cv, shot) {
        return loadImage(shot.blob).then(function (img) {
          // Corners are kept in this working copy's pixels (the crop editor uses them too).
          var canvas = crop(img, 0, 0, img.naturalWidth, img.naturalHeight, SHOT_MAX);
          shot.w = canvas.width; shot.h = canvas.height;
          if (!shot.quad) {
            var q = cornersFor(cv, canvas, shot.hint, false);
            shot.found = !!q;
            shot.quad = q || fullQuad(canvas.width, canvas.height);
          }
          // Auto splits a wide page in two (an open book), but not a whole
          // photo where no page was found: that's just a sideways phone.
          var z = quadSize(shot.quad);
          var spread = shot.mode === 'spread' || (shot.mode === 'auto' && shot.found && z.w > z.h * 1.2);
          var s = pageScale(shot.quad, spread);
          var flat = warp(cv, canvas, shot.quad, Math.max(1, Math.round(z.w * s)), Math.max(1, Math.round(z.h * s)));
          canvas.width = canvas.height = 0; // let the phone have the memory back
          var half = Math.floor(flat.width / 2);
          shot.spread = spread;
          return spread
            ? [crop(flat, 0, 0, half, flat.height, Infinity), crop(flat, half, 0, flat.width - half, flat.height, Infinity)]
            : [flat];
        });
      }
      // A long receipt: each part flattened to one width, then lined up.
      function longPage(cv, shot) {
        var strips = [], sizes = [];
        var chain = Promise.resolve();
        shot.parts.forEach(function (part) {
          chain = chain.then(function () { return loadImage(part.blob); }).then(function (img) {
            var canvas = crop(img, 0, 0, img.naturalWidth, img.naturalHeight, SHOT_MAX);
            if (!part.quad) part.quad = cornersFor(cv, canvas, part.hint, true) || fullQuad(canvas.width, canvas.height);
            part.canvas = canvas;
            sizes.push(quadSize(part.quad).w);
          });
        });
        return chain.then(function () {
          // One width for every part: a narrow receipt enlarged towards
          // 1000px (up to GROW_MAX), a wide one capped at 1400px.
          var mid = sizes.slice().sort(function (a, b) { return a - b; })[sizes.length >> 1];
          var W = Math.round(Math.min(1400, mid * Math.min(GROW_MAX, Math.max(1, 1000 / mid))));
          shot.parts.forEach(function (part) {
            var z = quadSize(part.quad);
            strips.push(warp(cv, part.canvas, part.quad, W, Math.max(1, Math.round(z.h * W / z.w))));
            part.canvas.width = part.canvas.height = 0;
            part.canvas = null;
          });
          var r = stitch(cv, strips);
          if (r.lost && !shot.warned) {
            shot.warned = true;
            Hub.toast('A part of the receipt couldn’t be lined up, so it’s added underneath. Overlap each picture with the last by about a third.', true);
          }
          return [r.canvas];
        });
      }
      // Clean-up and filter, as chosen.
      function finishPage(cv, p, f) {
        if (f === 'photo') return;
        clean(cv, p);
        if (f === 'bw') blackWhite(cv, p); else levels(p);
      }
      function process(shot) {
        shot.busy = true;
        work = work.then(function () {
          return opencv().then(function (cv) {
            return (shot.parts ? longPage(cv, shot) : shotPages(cv, shot)).then(function (parts) {
              return Promise.all(parts.map(function (p, i) {
                // Which way up: worked out the first time (a receipt is
                // always taken top to bottom), then kept.
                if (shot.turns[i] == null) {
                  var t = 0;
                  if (!shot.parts) { try { t = lineTurn(cv, p); } catch (e) { t = 0; } }
                  shot.turns[i] = t;
                }
                p = turnCanvas(p, shot.turns[i]);
                finishPage(cv, p, shot.filter);
                return toBlob(p, 'image/jpeg', shot.filter === 'bw' ? 0.85 : 0.88).then(function (b) { return { blob: b, w: p.width, h: p.height, part: i }; });
              }));
            });
          }).then(function (made) {
            // Replace this shot's old pages in place, or add to the end.
            var at = -1;
            pages = pages.filter(function (p, i) {
              if (p.shot !== shot) return true;
              if (at < 0) at = i;
              p.gone = true; URL.revokeObjectURL(p.url);
              return false;
            });
            var fresh = made.map(function (m) {
              return { id: ++seq, shot: shot, part: m.part, blob: m.blob, w: m.w, h: m.h, url: URL.createObjectURL(m.blob), lines: null, text: '', ocr: 'waiting' };
            });
            if (at < 0) pages = pages.concat(fresh); else pages.splice.apply(pages, [at, 0].concat(fresh));
            shot.busy = false;
            fresh.forEach(queueOcr);
            drawCounter();
            if (!el.querySelector('[data-view="review"]').hidden) drawReview();
          }).catch(function (e) {
            shot.busy = false;
            shot.failed = true;
            Hub.toast(e.message || 'Couldn’t use that photo.', true);
            drawCounter();
          });
        });
        return work;
      }

      /* ----- text ----- */
      function queueOcr(p) {
        if (ocrBroken) { p.ocr = 'skipped'; return; }
        p.ocr = 'waiting';
        ocrQueue.push(p);
        pumpOcr();
      }
      function pumpOcr() {
        if (ocrBusy || finished) return;
        var p = ocrQueue.shift();
        if (!p) { drawStatus(); return; }
        if (p.gone) return pumpOcr();
        ocrBusy = true;
        p.ocr = 'working';
        drawStatus();
        tesseract().then(function (w) {
          return w.recognize(p.blob).then(function (r) { return upright(w, p, r); });
        }).then(function (r) {
          var d = r.data || {};
          p.lines = (d.lines || []).map(function (l) { return { t: String(l.text || '').trim(), b: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1] }; }).filter(function (l) { return l.t; });
          p.text = String(d.text || '');
          p.ocr = 'done';
        }).catch(function () {
          p.ocr = 'failed';
          // The text reader couldn't load: carry on without it.
          if (!tessP) { ocrBroken = true; ocrQueue.forEach(function (q) { q.ocr = 'skipped'; }); ocrQueue = []; }
        }).then(function () {
          ocrBusy = false;
          var t = el.querySelector('.sc-page[data-id="' + p.id + '"] .sc-ocr');
          if (t) t.outerHTML = ocrBadge(p);
          pumpOcr();
        });
      }
      // Upside down (or sideways the wrong way)? Text the reader is unsure
      // of gets a second look, on a smaller copy, the other way up (and,
      // if it read almost nothing, both ways sideways too). If one way
      // reads clearly better, the page is turned that way and read again.
      // Once per page; turning a page by hand counts as checked.
      function upright(w, p, r) {
        var shot = p.shot, i = p.part || 0;
        if (shot.checked[i] || p.gone) return r;
        shot.checked[i] = true;
        var d = r.data || {}, conf = d.confidence || 0, chars = String(d.text || '').replace(/\s/g, '').length;
        if (conf >= 60 || chars < 15) return r;
        return loadImage(p.blob).then(function (img) {
          var small = crop(img, 0, 0, img.naturalWidth, img.naturalHeight, 1100);
          var tries = conf < 40 ? [0, 2, 1, 3] : [0, 2], scores = [];
          return tries.reduce(function (chain, t) {
            return chain.then(function () {
              return w.recognize(turnCanvas(small, t)).then(function (x) { scores.push((x.data && x.data.confidence) || 0); });
            });
          }, Promise.resolve()).then(function () {
            var best = 0;
            scores.forEach(function (s, k) { if (s > scores[best]) best = k; });
            if (!best || scores[best] < scores[0] + 15 || scores[best] < 50 || p.gone) return r;
            return turnBlob(p.blob, tries[best]).then(function (t) {
              if (p.gone) return r;
              URL.revokeObjectURL(p.url);
              p.blob = t.blob; p.w = t.w; p.h = t.h; p.url = URL.createObjectURL(t.blob);
              shot.turns[i] = ((shot.turns[i] || 0) + tries[best]) % 4;
              var tile = el.querySelector('.sc-page[data-id="' + p.id + '"] img');
              if (tile) tile.src = p.url;
              drawCounter();
              return w.recognize(p.blob);
            });
          });
        }).catch(function () { return r; });
      }
      function turnBlob(blob, quarters) {
        return loadImage(blob).then(function (img) {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          var t = turnCanvas(c, quarters);
          return toBlob(t, 'image/jpeg', 0.92).then(function (b) { return { blob: b, w: t.width, h: t.height }; });
        });
      }
      function ocrLeft() { return pages.filter(function (p) { return p.ocr === 'waiting' || p.ocr === 'working'; }).length; }
      function drawStatus() {
        var s = el.querySelector('[data-status]');
        if (!s) return;
        var left = ocrLeft(), busy = shots.some(function (x) { return x.busy; });
        s.textContent = Hub.plural(pages.length, 'page') + (busy ? ' · finishing photos…' : '') + (left ? ' · reading the text (' + left + ' to go)' : pages.length && !ocrBroken ? ' · text ready' : '');
      }
      function ocrBadge(p) {
        var label = { waiting: 'Text: waiting', working: 'Reading text…', done: 'Text ready', failed: 'No text found', skipped: 'No text' }[p.ocr] || '';
        return '<span class="sc-ocr sc-ocr--' + p.ocr + '" title="' + esc(label) + '">' + (p.ocr === 'done' ? I.check : p.ocr === 'working' ? '…' : '') + '</span>';
      }

      /* ----- review ----- */
      function drawReview() {
        drawStatus();
        var grid = el.querySelector('[data-grid]');
        if (!pages.length) {
          grid.innerHTML = '<p class="sc-empty">' + (shots.some(function (s) { return s.busy; }) ? 'Getting the pages ready…' : 'No pages yet. Tap “Add more” to take some.') + '</p>';
        } else {
          grid.innerHTML = pages.map(function (p, i) {
            return '<div class="sc-page" data-id="' + p.id + '"><img src="' + p.url + '" alt="Page ' + (i + 1) + '" />' +
              '<span class="sc-num">' + (i + 1) + '</span>' + ocrBadge(p) +
              '<div class="sc-tools">' +
                '<button type="button" data-pact="left" aria-label="Move earlier"' + (i ? '' : ' disabled') + '>' + I.left + '</button>' +
                '<button type="button" data-pact="right" aria-label="Move later"' + (i < pages.length - 1 ? '' : ' disabled') + '>' + I.right + '</button>' +
                '<button type="button" data-pact="rotate" aria-label="Turn">' + I.refresh + '</button>' +
                (p.shot.parts ? '' : '<button type="button" data-pact="crop" aria-label="Fix the edges">' + I.edit + '</button>') +
                '<button type="button" data-pact="remove" aria-label="Remove">' + I.trash + '</button>' +
              '</div></div>';
          }).join('');
        }
        el.querySelector('[data-act="save"]').disabled = !pages.length;
      }
      function rotate(p) {
        turnBlob(p.blob, 1).then(function (t) {
          if (p.gone) return;
          // Kept with the shot, so it stays turned if the filter changes.
          var i = p.part || 0;
          p.shot.turns[i] = ((p.shot.turns[i] || 0) + 1) % 4;
          p.shot.checked[i] = true;
          URL.revokeObjectURL(p.url);
          p.blob = t.blob; p.w = t.w; p.h = t.h; p.url = URL.createObjectURL(t.blob);
          p.lines = null; p.gone = true; // any reading in progress is for the old picture
          var fresh = Object.assign({}, p, { id: ++seq, gone: false });
          pages[pages.indexOf(p)] = fresh;
          queueOcr(fresh);
          drawReview();
          drawCounter();
        });
      }

      /* ----- fixing the edges ----- */
      function openCrop(shot) {
        cropping = { shot: shot, quad: shot.quad.map(function (p) { return p.slice(); }), mode: shot.spread ? 'spread' : 'single' };
        view('crop');
        var img = el.querySelector('.sc-crop img');
        var url = URL.createObjectURL(shot.blob);
        img.onload = function () { URL.revokeObjectURL(url); fitCrop(); };
        img.src = url;
        drawCropModes();
      }
      function fitCrop() {
        if (!cropping) return;
        var stage = el.querySelector('.sc-crop-stage'), box = el.querySelector('.sc-crop-box'), svg = box.querySelector('svg');
        var r = stage.getBoundingClientRect(), s = Math.min((r.width - 32) / cropping.shot.w, (r.height - 32) / cropping.shot.h);
        box.style.width = Math.round(cropping.shot.w * s) + 'px';
        box.style.height = Math.round(cropping.shot.h * s) + 'px';
        svg.setAttribute('viewBox', '0 0 ' + cropping.shot.w + ' ' + cropping.shot.h);
        drawCrop();
      }
      function drawCrop() {
        var box = el.querySelector('.sc-crop-box'), svg = box.querySelector('svg');
        var per = cropping.shot.w / (box.getBoundingClientRect().width || 1);
        svg.querySelector('polygon').setAttribute('points', cropping.quad.map(function (p) { return p.join(','); }).join(' '));
        Array.prototype.forEach.call(svg.querySelectorAll('circle, line'), function (c) { c.remove(); });
        if (cropping.mode === 'spread') {
          var q = cropping.quad, mid = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
          var t = mid(q[0], q[1]), b = mid(q[3], q[2]);
          svg.insertAdjacentHTML('beforeend', '<line x1="' + t[0] + '" y1="' + t[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke-width="' + 2 * per + '" />');
        }
        cropping.quad.forEach(function (p, i) {
          svg.insertAdjacentHTML('beforeend', '<circle data-corner="' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + 16 * per + '" stroke-width="' + 3 * per + '" />');
        });
      }
      function drawCropModes() {
        Array.prototype.forEach.call(el.querySelectorAll('[data-cmode]'), function (b) { b.classList.toggle('on', b.getAttribute('data-cmode') === cropping.mode); });
      }
      var dragging = null;
      el.querySelector('.sc-crop-box svg').addEventListener('pointerdown', function (e) {
        if (!cropping) return;
        var svg = this, r = svg.getBoundingClientRect(), per = cropping.shot.w / r.width;
        var x = (e.clientX - r.left) * per, y = (e.clientY - r.top) * per;
        // The nearest corner, if the finger is anywhere close to one.
        var best = -1, bestD = 60 * per;
        cropping.quad.forEach(function (p, i) { var d = dist(p, [x, y]); if (d < bestD) { bestD = d; best = i; } });
        if (best < 0) return;
        dragging = best;
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      el.querySelector('.sc-crop-box svg').addEventListener('pointermove', function (e) {
        if (dragging == null) return;
        var r = this.getBoundingClientRect(), per = cropping.shot.w / r.width;
        cropping.quad[dragging] = [
          Math.max(0, Math.min(cropping.shot.w, (e.clientX - r.left) * per)),
          Math.max(0, Math.min(cropping.shot.h, (e.clientY - r.top) * per))
        ];
        drawCrop();
      });
      ['pointerup', 'pointercancel'].forEach(function (ev) {
        el.querySelector('.sc-crop-box svg').addEventListener(ev, function () { dragging = null; });
      });
      window.addEventListener('resize', function () { if (cropping) fitCrop(); });

      /* ----- saving ----- */
      function saving(text, frac, canSkip) {
        el.querySelector('.sc-saving').hidden = false;
        el.querySelector('[data-saving]').textContent = text;
        el.querySelector('.sc-meter i').style.width = Math.round((frac || 0) * 100) + '%';
        el.querySelector('[data-act="skip-ocr"]').hidden = !canSkip;
      }
      var skipOcr = false;
      function save() {
        if (!pages.length) return;
        skipOcr = false;
        saving('Finishing the photos…', 0);
        work.then(function () {
          // Wait for the text, unless they'd rather not.
          return new Promise(function (resolve) {
            var total = pages.length;
            (function check() {
              var left = ocrLeft();
              if (!left || skipOcr || ocrBroken) return resolve();
              saving('Making the text searchable: ' + (total - left) + ' of ' + total + ' pages', (total - left) / total, true);
              setTimeout(check, 400);
            })();
          });
        }).then(function () {
          var list = pages.slice();
          return buildPdf(list, opts.title, function (n, total) { saving('Putting the PDF together: page ' + (n + 1) + ' of ' + total, n / total); }).then(function (pdf) {
            saving('Almost done…', 1);
            return Promise.all([
              shrink(list[0].blob, 560, 'image/webp'),
              readCopies(list)
            ]).then(function (r) {
              finish({ pdf: pdf, pages: list.length, thumb: r[0], read: r[1], text: list.map(function (p) { return p.text; }).join('\n\n') });
            });
          });
        }).catch(function (e) {
          el.querySelector('.sc-saving').hidden = true;
          Hub.toast(e.message || 'Couldn’t make the PDF.', true);
        });
      }

      // Copies for reading the details (the first pages). A long receipt
      // shrunk whole would be too small to read, so it goes as its top
      // (the store, the date) and its bottom (the total).
      function readCopies(list) {
        var jobs = [];
        list.slice(0, 3).forEach(function (p) {
          if (p.h > p.w * 2.2) {
            var piece = Math.min(1, p.w * 1.5 / p.h);
            jobs.push([p, 0, piece], [p, 1 - piece, 1]);
          } else jobs.push([p, 0, 1]);
        });
        return Promise.all(jobs.slice(0, 4).map(function (j) {
          return loadImage(j[0].blob).then(function (img) {
            var h = img.naturalHeight, y = Math.round(h * j[1]);
            return toBlob(crop(img, 0, y, img.naturalWidth, Math.round(h * j[2]) - y, 1568), 'image/jpeg', 0.8);
          });
        }));
      }

      function finish(result) {
        if (finished) return;
        finished = true;
        stopCamera();
        document.removeEventListener('visibilitychange', onVisible);
        pages.forEach(function (p) { URL.revokeObjectURL(p.url); });
        if (tessP) tessP.then(function (w) { w.terminate(); }).catch(function () {});
        tessP = null;
        document.removeEventListener('keydown', onKey);
        document.documentElement.classList.remove('sc-open');
        el.remove();
        resolveOpen(result);
      }
      function close() {
        var n = pages.length + (receipt.length ? 1 : 0);
        if (n && !window.confirm('Leave without saving ' + (n === 1 ? 'this page' : 'these ' + n + ' pages') + '?')) return;
        finish(null);
      }
      function onKey(e) {
        if (e.key === 'Escape') { if (cropping) { cropping = null; view('review'); } else close(); }
        else if ((e.key === ' ' || e.key === 'Enter') && stream && !el.querySelector('[data-view="camera"]').hidden && e.target === document.body) { e.preventDefault(); shoot(); }
      }
      document.addEventListener('keydown', onKey);

      /* ----- buttons ----- */
      el.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act], [data-mode], [data-cmode], [data-pact]');
        if (!b || b.disabled) return;
        var act = b.getAttribute('data-act');
        if (b.hasAttribute('data-mode')) {
          if (mode === 'long' && b.getAttribute('data-mode') !== 'long') finishReceipt();
          mode = b.getAttribute('data-mode');
          if (live) { live.target = live.maybe = null; live.changed = true; }
          drawModes();
          return;
        }
        if (b.hasAttribute('data-cmode')) { cropping.mode = b.getAttribute('data-cmode'); drawCropModes(); drawCrop(); return; }
        if (b.hasAttribute('data-pact')) {
          var tile = b.closest('.sc-page'), p = pages.filter(function (x) { return String(x.id) === tile.getAttribute('data-id'); })[0];
          if (!p) return;
          var i = pages.indexOf(p), a = b.getAttribute('data-pact');
          if (a === 'left' && i > 0) { pages.splice(i, 1); pages.splice(i - 1, 0, p); drawReview(); }
          else if (a === 'right' && i < pages.length - 1) { pages.splice(i, 1); pages.splice(i + 1, 0, p); drawReview(); }
          else if (a === 'rotate') rotate(p);
          else if (a === 'crop') openCrop(p.shot);
          else if (a === 'remove') {
            p.gone = true; URL.revokeObjectURL(p.url);
            pages.splice(i, 1);
            if (!pages.some(function (x) { return x.shot === p.shot; })) shots = shots.filter(function (s) { return s !== p.shot; });
            drawReview(); drawCounter();
          }
          return;
        }
        if (act === 'close') close();
        else if (act === 'shoot') shoot();
        else if (act === 'snap') el.querySelector('[data-in="snap"]').click();
        else if (act === 'pick') el.querySelector('[data-in="pick"]').click();
        else if (act === 'review') view('review');
        else if (act === 'camera') view('camera');
        else if (act === 'save') save();
        else if (act === 'skip-ocr') skipOcr = true;
        else if (act === 'handsfree') {
          handsFree = !handsFree;
          try { localStorage.setItem('sc-handsfree', handsFree ? '1' : '0'); } catch (err) { /* private mode */ }
          if (live) { live.changed = true; live.steadySince = 0; live.sig = null; }
          drawModes();
        }
        else if (act === 'receipt-undo') { receipt.pop(); drawTip(); drawCounter(); }
        else if (act === 'receipt-done') finishReceipt();
        else if (act === 'filter') {
          filter = FILTERS[filter][1];
          drawModes();
          // Pages already taken switch too.
          shots.forEach(function (s) { if (s.filter !== filter) { s.filter = filter; process(s); } });
        }
        else if (act === 'crop-cancel') { cropping = null; view('review'); }
        else if (act === 'crop-full') { cropping.quad = fullQuad(cropping.shot.w, cropping.shot.h); drawCrop(); }
        else if (act === 'crop-apply') {
          var shot = cropping.shot;
          shot.quad = cropping.quad;
          shot.mode = cropping.mode;
          shot.found = true;
          shot.turns = []; shot.checked = []; // new edges: work out which way up again
          cropping = null;
          view('review');
          process(shot);
        }
      });
      Array.prototype.forEach.call(el.querySelectorAll('input[type=file]'), function (input) {
        input.addEventListener('change', function () {
          var files = Array.prototype.slice.call(this.files || []), pick = this.getAttribute('data-in') === 'pick';
          this.value = '';
          if (!files.length) return;
          // In Receipt mode, a camera-app photo is the next part, and
          // photos picked together are the parts of one receipt.
          if (mode === 'long') {
            files.forEach(function (f) { receipt.push({ blob: f, hint: null }); });
            if (pick) finishReceipt(); else { drawTip(); drawCounter(); }
          } else files.forEach(function (f) { addShot(f); });
          if (pick) view('review');
        });
      });

      drawModes();
      drawCounter();
      // The cover photo the editor already took is page 1, never split in
      // two (it may be a wide model sticker rather than an open book).
      (opts.start || []).forEach(function (b) { addShot(b, 'single'); });
      view('camera');
      // Start the downloads now, so they're ready by the first shot.
      opencv().catch(function (e) { Hub.toast(e.message, true); });
      tesseract().catch(function () {});
    });
  }

  window.DocScanner = { open: open, _test: { clean: clean, lineTurn: lineTurn, turnCanvas: turnCanvas, stitch: stitch, levels: levels, blackWhite: blackWhite, detect: detect, findPage: findPage, warp: warp, pageScale: pageScale, quadSize: quadSize, opencv: opencv, buildPdf: buildPdf, tesseract: tesseract } };
})();
