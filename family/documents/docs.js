/* ============================================================
   Documents - shared page code (window.Docs), used by
   family/documents/index.html, item.html and edit.html.
   Needs hub.js first.
   ============================================================ */
(function () {
  'use strict';
  var esc = Hub.esc, I = Hub.icons;

  /* ---------- collections ---------- */
  var COLLECTIONS = [
    { id: 'cards', label: 'Cards & gifts', one: 'Card or gift', add: 'Add a card or gift', icon: 'gift', catLabel: 'Occasion',
      cats: ['Birthday', 'Christmas', 'Holiday', 'Wedding', 'Anniversary', 'Baby', 'Graduation', 'Thank you', 'Sympathy', 'Just because'] },
    { id: 'manuals', label: 'Manuals', one: 'Manual', add: 'Add a manual', icon: 'book', catLabel: 'Kind',
      cats: ['Kitchen', 'Laundry', 'Heating & cooling', 'Electronics', 'Tools & yard', 'Furniture', 'Vehicle', 'Other'] },
    { id: 'receipts', label: 'Receipts', one: 'Receipt', add: 'Add a receipt', icon: 'receipt', catLabel: 'Category',
      cats: ['Home', 'Appliances', 'Electronics', 'Furniture', 'Vehicle', 'Medical', 'Clothing', 'Gifts', 'Other'] },
    { id: 'other', label: 'Other documents', one: 'Document', add: 'Add a document', icon: 'file', catLabel: 'Category',
      cats: ['Home', 'Vehicle', 'Medical', 'School', 'Legal', 'Keepsakes', 'Other'] }
  ];
  function coll(id) { return COLLECTIONS.filter(function (c) { return c.id === id; })[0] || COLLECTIONS[3]; }

  /* ---------- formatting ---------- */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Dates are "2025", "2025-12" or "2025-12-25".
  function dateLabel(d) {
    if (!d) return '';
    var p = String(d).split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return MONTHS[+p[1] - 1] + ' ' + p[0];
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0];
  }
  function money(c) { return c == null ? '' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function parseMoney(s) {
    var n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.]/g, ''));
    return isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  function fileSize(n) { return !n ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function warranty(d) { return d.warrantyUntil ? (d.warrantyUntil >= todayKey() ? 'active' : 'ended') : null; }
  function kind(f) { return /^image\//.test(f.type) ? 'image' : f.type === 'application/pdf' ? 'pdf' : 'file'; }

  // The line under an item's name.
  function subline(d) {
    var parts = [];
    if (d.collection === 'cards') {
      if (d.title && d.from) parts.push('From ' + d.from);
      parts.push(dateLabel(d.date));
    } else if (d.collection === 'manuals') {
      if (d.title) parts.push([d.brand, d.model].filter(Boolean).join(' '));
      if (!d.title || !(d.brand || d.model)) parts.push(d.category);
    } else if (d.collection === 'receipts') {
      if (d.title) parts.push(d.store);
      parts.push(money(d.total), dateLabel(d.date));
    } else {
      if (d.title && d.from) parts.push('From ' + d.from);
      parts.push(d.category, dateLabel(d.date));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function badges(d) {
    var b = [];
    if (d.needsReview) b.push('<span class="dc-badge dc-badge--review">' + I.sparkle + 'Check details</span>');
    if (d.collection === 'cards' && !d.thanked) b.push('<span class="dc-badge dc-badge--thank">To thank</span>');
    if (d.collection === 'cards' && d.thanked) b.push('<span class="dc-badge dc-badge--done">' + I.check + 'Thanked</span>');
    if (d.gift) b.push('<span class="dc-badge" title="' + esc(d.gift) + '">' + I.gift + esc(d.gift.length > 28 ? d.gift.slice(0, 26) + '…' : d.gift) + '</span>');
    var w = warranty(d);
    if (w === 'active') b.push('<span class="dc-badge dc-badge--done">Under warranty</span>');
    return b.join('');
  }

  function placeholder(d) {
    var c = coll(d.collection);
    return '<div class="dc-placeholder">' + I[d.pdf ? 'file' : c.icon] + (d.pdf ? '<span>PDF</span>' : '') + '</div>';
  }

  function tile(d) {
    return '<a class="dc-tile dc--' + esc(d.collection) + '" href="/family/documents/item?id=' + encodeURIComponent(d.id) + '">' +
      '<div class="dc-thumb' + (d.thumbPage ? ' is-page' : '') + '">' + (d.thumbUrl ? '<img src="' + esc(d.thumbUrl) + '" alt="" loading="lazy" />' : placeholder(d)) +
        (d.files > 1 ? '<span class="dc-count">' + I.image + d.files + '</span>' : '') + '</div>' +
      '<div class="dc-tile-body"><h3>' + esc(d.name) + '</h3>' +
        (subline(d) ? '<p>' + esc(subline(d)) + '</p>' : '') +
        '<div class="dc-badges">' + badges(d) + '</div></div></a>';
  }

  /* ---------- Google Drive status note ---------- */
  function driveNote(drive, where) {
    if (!drive || drive.connected) return '';
    if (drive.local) {
      return where === 'list' ? '<p class="dc-note dc-note--quiet">' + I.folder + '<span>Local preview: files are saved in <code>.family-data</code> on this computer, not in Google Drive.</span></p>' : '';
    }
    var btn = drive.canConnect ? '<button class="btn btn-primary btn-sm" type="button" data-drive-connect>' + I.folder + (drive.broken ? 'Reconnect Google Drive' : 'Connect Google Drive') + '</button>' : '';
    var text = drive.broken
      ? (drive.canConnect ? '<strong>Google Drive needs reconnecting.</strong> Until then, photos and files can’t be opened or added. Use the same Google account as before (' + esc(drive.email || 'the one it was set up with') + ').'
        : '<strong>Google Drive needs reconnecting.</strong> Ask Logan to reconnect it. Until then, photos and files can’t be opened or added.')
      : drive.canConnect ? '<strong>Connect Google Drive to start adding photos and files.</strong> Everything goes into a “Randall Family Documents” folder in your Drive, so it’s yours to keep.'
      : drive.setUp ? '<strong>Photos and files can be added once Logan connects Google Drive.</strong> You can already record gifts.'
      : '<strong>Google Drive isn’t set up yet</strong> (GOOGLE_CLIENT_SECRET is missing), so photos and files can’t be added. You can already record gifts.';
    return '<div class="dc-note' + (drive.broken ? ' dc-note--warn' : '') + '"><span class="dc-note-icon">' + I.folder + '</span><p>' + text + '</p>' + btn + '</div>';
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-drive-connect]')) location.href = '/api/family?r=docs-drive-connect';
  });
  // Coming back from Google's consent screen (?drive=...).
  function driveReturnMessage() {
    var q = new URLSearchParams(location.search), code = q.get('drive');
    if (!code) return;
    var msg = {
      connected: ['Google Drive is connected. New photos and files are saved there.', false],
      denied: ['Google Drive wasn’t connected: the permission was declined.', true],
      scope: ['Google Drive wasn’t connected. Tick the box that lets the hub see and save its files, then try again.', true],
      expired: ['That took too long. Try connecting Google Drive again.', true],
      failed: ['Google didn’t finish connecting Drive. Try again.', true]
    }[code];
    if (msg) Hub.toast(msg[0], msg[1]);
    q.delete('drive');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  }

  /* ---------- photos: shrink in the browser ---------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This browser can’t open that photo.')); };
      img.src = url;
    });
  }
  function canvasBlob(c, type, quality) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) {
        // Older Safari can't make WebP and hands back a PNG instead.
        if (b && b.type === type) return resolve(b);
        c.toBlob(function (j) { j ? resolve(j) : reject(new Error('Couldn’t shrink that photo.')); }, 'image/jpeg', quality);
      }, type, quality);
    });
  }
  function scaled(source, w, h, max, type, quality) {
    var s = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return canvasBlob(c, type, quality);
  }
  // A photo becomes: the copy kept (a JPEG up to 2400px, sharp enough to
  // read a card's handwriting), a smaller one for the reader, and a thumbnail.
  function preparePhoto(file) {
    return loadImage(file).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      return Promise.all([
        scaled(img, w, h, 2400, 'image/jpeg', 0.88),
        scaled(img, w, h, 1568, 'image/jpeg', 0.82),
        scaled(img, w, h, 560, 'image/webp', 0.8)
      ]).then(function (b) {
        // Always the redrawn copy, even of a small JPEG: redrawing drops the
        // photo's hidden details, like where it was taken.
        var s = Math.min(1, 2400 / Math.max(w, h));
        return { full: b[0], read: [b[1]], thumb: b[2], w: Math.round(w * s), h: Math.round(h * s) };
      });
    });
  }

  /* ---------- PDFs: the first pages drawn as pictures (pdf.js, loaded when needed) ---------- */
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var pdfP = null;
  function pdfjs() {
    if (!pdfP) pdfP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = function () { pdfP = null; reject(new Error('Couldn’t load the PDF reader.')); };
      document.head.appendChild(s);
    });
    return pdfP;
  }
  function renderPage(pdf, n, max) {
    return pdf.getPage(n).then(function (page) {
      var v = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: max / Math.max(v.width, v.height) });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      // intent "print" draws in one go; the default waits on animation
      // frames, which stop while the tab is in the background (a phone
      // switching apps mid-upload).
      return page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise.then(function () { return c; });
    });
  }
  function preparePdf(file) {
    return pdfjs().then(function (lib) {
      return file.arrayBuffer().then(function (buf) { return lib.getDocument({ data: buf }).promise; });
    }).then(function (pdf) {
      var pages = [], count = Math.min(pdf.numPages, 3), chain = Promise.resolve();
      for (var i = 1; i <= count; i++) (function (n) {
        chain = chain.then(function () { return renderPage(pdf, n, 1568).then(function (c) { pages.push(c); }); });
      })(i);
      return chain.then(function () {
        return Promise.all([
          Promise.all(pages.map(function (c) { return canvasBlob(c, 'image/jpeg', 0.8); })),
          scaled(pages[0], pages[0].width, pages[0].height, 560, 'image/webp', 0.8)
        ]);
      }).then(function (r) { return { read: r[0], thumb: r[1], pages: pdf.numPages }; });
    });
  }

  // Any picked file -> { kind, full, read: [images for the reader], thumb, w, h, pages }.
  // Files that can't be drawn (Word documents, HEIC on Windows) are kept as
  // they are, with no thumbnail and nothing to read.
  // A damaged PDF can leave pdf.js working forever, so give up after a while
  // and keep the file as it is.
  function timeLimit(p, ms) {
    return Promise.race([p, new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('Took too long.')); }, ms); })]);
  }
  function prepare(file) {
    var asIs = { kind: 'file', full: file, read: [], thumb: null };
    if (/^image\//.test(file.type) && file.type !== 'image/svg+xml') {
      return timeLimit(preparePhoto(file), 30000).then(function (p) { p.kind = 'image'; return p; }, function () { return asIs; });
    }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      return timeLimit(preparePdf(file), 20000).then(function (p) { p.kind = 'pdf'; p.full = file; return p; }, function () { asIs.kind = 'pdf'; return asIs; });
    }
    return Promise.resolve(asIs);
  }
  // The name a picked file is saved under (photos become .jpg).
  function savedName(file, p) {
    var base = String(file.name || 'file').replace(/\.[a-z0-9]{1,8}$/i, '') || 'photo';
    return p.kind === 'image' && p.full !== file ? base + '.jpg' : file.name || 'file';
  }

  /* ---------- uploads: in 4 MiB pieces through the hub ---------- */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function piece(token, offset, blob, askStatus) {
    var headers = { 'x-family-hub': '1', 'x-upload-token': token };
    if (askStatus) headers['x-upload-status'] = '1';
    else { headers['x-upload-offset'] = String(offset); headers['content-type'] = 'application/octet-stream'; }
    return fetch('/api/family?r=docs-upload-chunk', { method: 'POST', headers: headers, body: askStatus ? null : blob, credentials: 'same-origin' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'The upload failed (' + res.status + ').'); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  // Resolves to the stored file's reference (what a save attaches).
  function upload(blob, name, onProgress) {
    return Hub.api('docs-upload-start', { body: { name: name, type: blob.type || 'application/octet-stream', size: blob.size } }).then(function (s) {
      var step = s.chunk || 4194304, fails = 0, reached = 0;
      function send(offset) {
        if (onProgress) onProgress(offset / blob.size);
        return piece(s.token, offset, blob.slice(offset, Math.min(blob.size, offset + step))).then(next, retry);
      }
      function next(r) {
        if (r.done) { if (onProgress) onProgress(1); return r.file; }
        if (r.next > reached) { reached = r.next; fails = 0; }
        return send(r.next);
      }
      // A piece that failed: wait, ask where the upload got to, carry on.
      function retry(e) {
        if (++fails > 3 || (e.status && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
        return wait(fails * 1500).then(function () { return piece(s.token, 0, null, true); }).then(next, retry);
      }
      return send(0);
    });
  }

  /* ---------- reading a photo with Claude ---------- */
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { reject(fr.error || new Error('Couldn’t read that file.')); };
      fr.readAsDataURL(blob);
    });
  }
  function read(blobs, collection) {
    blobs = (blobs || []).slice(0, 6);
    return Promise.all(blobs.map(toBase64)).then(function (data) {
      var total = 0, images = [];
      data.forEach(function (d, i) {
        if (total + d.length > 4000000) return; // a request has to stay under 4.5 MB
        total += d.length;
        images.push({ type: blobs[i].type, data: d });
      });
      if (!images.length) throw new Error('Nothing to read.');
      return Hub.api('docs-read', { body: { images: images, collection: collection || undefined } });
    }).then(function (r) { return r.suggestion; });
  }

  /* ---------- opening a stored file ----------
     Small files open straight from the hub. Bigger ones (a long PDF) are
     fetched in pieces, because a hub response can't be over 4.5 MB. */
  var DIRECT = 4000000;
  function href(f, download) { return f.url + '&n=' + encodeURIComponent(f.name || 'file') + (download ? '&dl=1' : ''); }
  function clickLink(url, name) {
    var a = document.createElement('a');
    a.href = url; a.download = name || ''; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function fetchWhole(f) {
    var parts = [], n = Math.ceil(f.size / DIRECT), i = 0;
    function next() {
      if (i >= n) return Promise.resolve(new Blob(parts, { type: f.type }));
      var start = i * DIRECT, end = Math.min(f.size, start + DIRECT) - 1;
      return fetch(f.url, { headers: { Range: 'bytes=' + start + '-' + end }, credentials: 'same-origin' }).then(function (r) {
        if (r.status !== 206) throw new Error('Couldn’t get the file (' + r.status + ').');
        return r.blob();
      }).then(function (b) { parts.push(b); i++; return next(); });
    }
    return next();
  }
  function openFile(f, download) {
    if (!f.size || f.size <= DIRECT) {
      if (download) clickLink(href(f, true), f.name);
      else window.open(href(f), '_blank', 'noopener');
      return;
    }
    // Open the tab now, while the tap still counts, and fill it when the file's here.
    var w = download ? null : window.open('', '_blank');
    if (w) { try { w.document.title = f.name; w.document.body.innerHTML = '<p style="font:16px system-ui,sans-serif;padding:2rem;color:#666">Opening ' + esc(f.name) + '…</p>'; } catch (e) {} }
    Hub.toast('Getting ' + (f.name || 'the file') + ' (' + fileSize(f.size) + ')…');
    fetchWhole(f).then(function (blob) {
      var url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else clickLink(url, f.name);
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (e) { if (w) w.close(); Hub.toast(e.message, true); });
  }

  window.Docs = {
    COLLECTIONS: COLLECTIONS, coll: coll,
    dateLabel: dateLabel, money: money, parseMoney: parseMoney, fileSize: fileSize, todayKey: todayKey, warranty: warranty, kind: kind,
    subline: subline, tile: tile, driveNote: driveNote, driveReturnMessage: driveReturnMessage,
    prepare: prepare, savedName: savedName, upload: upload, read: read, href: href, openFile: openFile
  };
})();
