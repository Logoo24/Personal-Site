/* ============================================================
   Documents - the page scanner (window.DocScanner).
   Photograph a manual page by page: the camera runs inside the page (or
   the phone's camera app, as a fallback); each shot is cropped to the page
   and straightened (OpenCV), an open book is split into its two pages, the
   text is recognized on the device (Tesseract), and it all becomes one PDF
   with an invisible text layer, so it can be searched and copied (pdf-lib).

   DocScanner.open({ title, start: [Blob] }) resolves to
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
  var PAGE_MAX = 2000;   // longest side of a finished page, in pixels
  var SHOT_MAX = 3200;   // longest side a shot is worked on at
  var PDF_WIDTH = 612;   // points: pages are 8.5 inches wide, as tall as the page is

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
  // Corners in order: top-left, top-right, bottom-right, bottom-left.
  function orderQuad(pts) {
    var bySum = pts.slice().sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); });
    var byDiff = pts.slice().sort(function (a, b) { return (a[1] - a[0]) - (b[1] - b[0]); });
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }
  function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }
  function quadArea(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) { var p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return Math.abs(a) / 2;
  }

  /* ---------- finding the page in a photo (OpenCV) ---------- */
  function quadFrom(cv, bin, minArea) {
    var contours = new cv.MatVector(), hier = new cv.Mat(), best = null, bestArea = 0;
    cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (var i = 0; i < contours.size(); i++) {
      var cnt = contours.get(i), area = cv.contourArea(cnt);
      if (area > minArea && area > bestArea) {
        var hull = new cv.Mat(), approx = new cv.Mat(), pts = null;
        cv.convexHull(cnt, hull);
        var peri = cv.arcLength(hull, true);
        for (var eps = 0.02; eps <= 0.1 && !pts; eps += 0.02) {
          cv.approxPolyDP(hull, approx, eps * peri, true);
          if (approx.rows === 4) {
            var d = approx.data32S;
            pts = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
          }
        }
        if (!pts) { // no clean four corners: fall back to its bounding box
          var r = cv.boundingRect(hull);
          pts = fullQuad(r.width, r.height).map(function (p) { return [p[0] + r.x, p[1] + r.y]; });
        }
        best = orderQuad(pts); bestArea = area;
        hull.delete(); approx.delete();
      }
      cnt.delete();
    }
    contours.delete(); hier.delete();
    return best;
  }
  // The page's four corners in the source's own pixels, or null.
  function detect(cv, source, w, h, workAt) {
    var s = Math.min(1, (workAt || 640) / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    var src = cv.imread(c), gray = new cv.Mat(), edges = new cv.Mat(), otsu = new cv.Mat(), k = cv.Mat.ones(5, 5, cv.CV_8U);
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      var minArea = c.width * c.height * 0.15;
      cv.Canny(gray, edges, 40, 120);
      cv.dilate(edges, edges, k);
      var q = quadFrom(cv, edges, minArea);
      if (!q) {
        cv.threshold(gray, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        q = quadFrom(cv, otsu, minArea);
      }
      return q ? q.map(function (p) { return [p[0] / s, p[1] / s]; }) : null;
    } finally {
      src.delete(); gray.delete(); edges.delete(); otsu.delete(); k.delete();
    }
  }
  // The quad flattened into a rectangle.
  function warp(cv, canvas, q) {
    var w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    var s = Math.min(1, SHOT_MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
    var src = cv.imread(canvas), dst = new cv.Mat();
    var from = cv.matFromArray(4, 1, cv.CV_32FC2, [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]]);
    var to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    var M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      var out = document.createElement('canvas');
      cv.imshow(out, dst);
      return out;
    } finally {
      src.delete(); dst.delete(); from.delete(); to.delete(); M.delete();
    }
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
        doc.setTitle(title || 'Scanned manual');
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
      var mode = 'auto', filter = 'color';
      var stream = null, liveTimer = null, liveQuad = null, cropping = null, finished = false;
      var work = Promise.resolve(), ocrQueue = [], ocrBusy = false, ocrBroken = false;

      var el = document.createElement('div');
      el.className = 'sc';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Scan pages');
      var modes = '<div class="sc-seg" data-modes>' + [['auto', 'Auto'], ['single', '1 page'], ['spread', 'Open book']].map(function (m) {
        return '<button type="button" data-mode="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>';
      el.innerHTML =
        '<section class="sc-cam" data-view="camera">' +
          '<div class="sc-bar"><button type="button" class="sc-icon" data-act="close" aria-label="Close">' + I.x + '</button>' + modes +
            '<button type="button" class="sc-pill" data-act="filter"></button></div>' +
          '<div class="sc-stage">' +
            '<video playsinline muted autoplay></video><canvas class="sc-outline"></canvas><div class="sc-flash"></div>' +
            '<div class="sc-nocam" hidden><p></p><div class="sc-nocam-btns">' +
              '<button type="button" class="btn btn-primary" data-act="snap">' + I.camera + 'Take a photo</button>' +
              '<button type="button" class="btn btn-ghost" data-act="pick">' + I.image + 'Choose photos</button></div></div>' +
            '<p class="sc-tip">Fill the screen with the page. For an open book, fit both pages and choose Open book or Auto.</p>' +
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
        Array.prototype.forEach.call(el.querySelectorAll('[data-view]'), function (v) { v.hidden = v.getAttribute('data-view') !== name; });
        if (name === 'camera') startCamera(); else stopCamera();
        if (name === 'review') drawReview();
      }
      function drawModes() {
        Array.prototype.forEach.call(el.querySelectorAll('[data-mode]'), function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
        Array.prototype.forEach.call(el.querySelectorAll('[data-act="filter"]'), function (b) {
          b.textContent = filter === 'color' ? 'Color' : 'Black & white';
          b.title = 'Switch to ' + (filter === 'color' ? 'black & white (crisper text, smaller file)' : 'color');
        });
      }
      function drawCounter() {
        $('.sc-last b').textContent = pages.length;
        var last = pages[pages.length - 1];
        $('.sc-last-img').style.backgroundImage = last ? 'url("' + last.url + '")' : '';
        $('.sc-done').disabled = !shots.length;
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
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })
          .then(function (s) {
            if (finished || el.querySelector('[data-view="camera"]').hidden) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            stream = s;
            video.srcObject = s;
            video.play().catch(function () {});
            $('.sc-nocam').hidden = true;
            $('.sc-shutter').disabled = false;
            $('.sc-tip').hidden = false;
            startOutline();
          })
          .catch(function (e) {
            noCamera(e && e.name === 'NotAllowedError'
              ? 'The camera is turned off for this site. Allow it in the browser’s settings, or take each page with the camera app.'
              : 'The camera isn’t available. Take each page with the camera app instead.');
          });
      }
      function stopCamera() {
        clearInterval(liveTimer); liveTimer = null; liveQuad = null;
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
        video.srcObject = null;
        var ctx = outline.getContext('2d'); ctx.clearRect(0, 0, outline.width, outline.height);
      }
      // A live outline of the page it sees, a few times a second.
      function startOutline() {
        clearInterval(liveTimer);
        opencv().then(function (cv) {
          if (!stream) return;
          liveTimer = setInterval(function () {
            var vw = video.videoWidth, vh = video.videoHeight;
            if (!vw || !stream) return;
            try { liveQuad = detect(cv, video, vw, vh, 360); } catch (e) { liveQuad = null; }
            drawOutline(vw, vh);
          }, 350);
        }).catch(function () {});
      }
      function drawOutline(vw, vh) {
        var r = video.getBoundingClientRect();
        outline.width = Math.round(r.width * devicePixelRatio); outline.height = Math.round(r.height * devicePixelRatio);
        var ctx = outline.getContext('2d');
        ctx.clearRect(0, 0, outline.width, outline.height);
        if (!liveQuad) return;
        // The video is drawn "cover", so map its pixels the same way.
        var s = Math.max(outline.width / vw, outline.height / vh), ox = (outline.width - vw * s) / 2, oy = (outline.height - vh * s) / 2;
        ctx.beginPath();
        liveQuad.forEach(function (p, i) { var x = ox + p[0] * s, y = oy + p[1] * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.closePath();
        ctx.lineWidth = 3 * devicePixelRatio;
        ctx.strokeStyle = '#34D399';
        ctx.fillStyle = 'rgba(52, 211, 153, 0.15)';
        ctx.fill(); ctx.stroke();
      }
      function shoot() {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw) return;
        var c = document.createElement('canvas');
        c.width = vw; c.height = vh;
        c.getContext('2d').drawImage(video, 0, 0);
        var f = $('.sc-flash');
        f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
        if (navigator.vibrate) navigator.vibrate(15);
        toBlob(c, 'image/jpeg', 0.92).then(addShot);
      }

      /* ----- shots and pages ----- */
      function addShot(blob, forceMode) {
        var shot = { id: ++seq, blob: blob, mode: forceMode || mode, filter: filter, quad: null, w: 0, h: 0, busy: true };
        shots.push(shot);
        drawCounter();
        process(shot);
      }
      // Turns a shot into its page(s), one shot at a time (the phone's memory).
      function process(shot) {
        shot.busy = true;
        work = work.then(function () {
          return Promise.all([opencv(), loadImage(shot.blob)]).then(function (r) {
            var cv = r[0], img = r[1];
            // Corners are kept in this working copy's pixels (the crop editor uses them too).
            var canvas = crop(img, 0, 0, img.naturalWidth, img.naturalHeight, SHOT_MAX);
            shot.w = canvas.width; shot.h = canvas.height;
            if (!shot.quad) {
              var q = null;
              try { q = detect(cv, canvas, canvas.width, canvas.height, 800); } catch (e) { q = null; }
              shot.found = !!(q && quadArea(q) > canvas.width * canvas.height * 0.15);
              shot.quad = shot.found ? q : fullQuad(canvas.width, canvas.height);
            }
            var flat = warp(cv, canvas, shot.quad);
            // Auto splits a wide page in two (an open book), but not a whole
            // photo where no page was found: that's just a sideways phone.
            var spread = shot.mode === 'spread' || (shot.mode === 'auto' && shot.found && flat.width > flat.height * 1.2);
            var parts = spread
              ? [crop(flat, 0, 0, Math.floor(flat.width / 2), flat.height, PAGE_MAX), crop(flat, Math.floor(flat.width / 2), 0, flat.width - Math.floor(flat.width / 2), flat.height, PAGE_MAX)]
              : [crop(flat, 0, 0, flat.width, flat.height, PAGE_MAX)];
            shot.spread = spread;
            return Promise.all(parts.map(function (p) {
              if (shot.filter === 'bw') blackWhite(cv, p); else levels(p);
              return toBlob(p, 'image/jpeg', shot.filter === 'bw' ? 0.7 : 0.8).then(function (b) { return { blob: b, w: p.width, h: p.height }; });
            }));
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
              return { id: ++seq, shot: shot, blob: m.blob, w: m.w, h: m.h, url: URL.createObjectURL(m.blob), lines: null, text: '', ocr: 'waiting' };
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
        tesseract().then(function (w) { return w.recognize(p.blob); }).then(function (r) {
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
                '<button type="button" data-pact="crop" aria-label="Fix the edges">' + I.edit + '</button>' +
                '<button type="button" data-pact="remove" aria-label="Remove">' + I.trash + '</button>' +
              '</div></div>';
          }).join('');
        }
        el.querySelector('[data-act="save"]').disabled = !pages.length;
      }
      function rotate(p) {
        loadImage(p.blob).then(function (img) {
          var c = document.createElement('canvas');
          c.width = img.naturalHeight; c.height = img.naturalWidth;
          var ctx = c.getContext('2d');
          ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2);
          ctx.drawImage(img, 0, 0);
          return toBlob(c, 'image/jpeg', 0.85).then(function (b) {
            URL.revokeObjectURL(p.url);
            p.blob = b; p.w = c.width; p.h = c.height; p.url = URL.createObjectURL(b);
            p.lines = null; p.gone = true; // any reading in progress is for the old picture
            var fresh = Object.assign({}, p, { id: ++seq, gone: false });
            pages[pages.indexOf(p)] = fresh;
            queueOcr(fresh);
            drawReview();
          });
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
              Promise.all(list.slice(0, 3).map(function (p) { return shrink(p.blob, 1568); }))
            ]).then(function (r) {
              finish({ pdf: pdf, pages: list.length, thumb: r[0], read: r[1], text: list.map(function (p) { return p.text; }).join('\n\n') });
            });
          });
        }).catch(function (e) {
          el.querySelector('.sc-saving').hidden = true;
          Hub.toast(e.message || 'Couldn’t make the PDF.', true);
        });
      }

      function finish(result) {
        if (finished) return;
        finished = true;
        stopCamera();
        pages.forEach(function (p) { URL.revokeObjectURL(p.url); });
        if (tessP) tessP.then(function (w) { w.terminate(); }).catch(function () {});
        tessP = null;
        document.removeEventListener('keydown', onKey);
        document.documentElement.classList.remove('sc-open');
        el.remove();
        resolveOpen(result);
      }
      function close() {
        if (pages.length && !window.confirm('Leave without saving these ' + Hub.plural(pages.length, 'page') + '?')) return;
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
        if (b.hasAttribute('data-mode')) { mode = b.getAttribute('data-mode'); drawModes(); return; }
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
        else if (act === 'filter') {
          filter = filter === 'color' ? 'bw' : 'color';
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
          cropping = null;
          view('review');
          process(shot);
        }
      });
      Array.prototype.forEach.call(el.querySelectorAll('input[type=file]'), function (input) {
        input.addEventListener('change', function () {
          Array.prototype.forEach.call(this.files || [], function (f) { addShot(f); });
          this.value = '';
          if (this.getAttribute('data-in') === 'pick') view('review');
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

  window.DocScanner = { open: open, _test: { detect: detect, warp: warp, opencv: opencv, buildPdf: buildPdf, tesseract: tesseract } };
})();
