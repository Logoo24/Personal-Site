/* ============================================================
   Family hub - crop a photo to a fixed shape (window.PhotoCrop).
   A full-screen frame over the photo: drag it to move it, drag a corner
   to make it bigger or smaller (it keeps its shape), then Save.

   PhotoCrop.open({ src, ratio, crop, maxWidth, title })
     src:      a Blob/File, or a same-origin image URL
     ratio:    width / height of the frame (default 3 / 2)
     crop:     where the frame was last time, { x, y, w, h } as fractions
               of the photo (optional; else the biggest frame, centred)
     maxWidth: the cropped photo's widest (default 1600px)
   resolves to { blob, crop } or null (cancelled).
   Needs hub.js.
   ============================================================ */
(function () {
  'use strict';
  // How far above a dragging finger the corner aims, in px. The corner can
  // only move along the frame's diagonal, which takes about half of this
  // (it ends up ~55px up and out from the finger, clear of the thumb).
  var LIFT = 96;

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = typeof src === 'string' ? src : URL.createObjectURL(src);
      img.onload = function () { resolve({ img: img, url: url, own: url !== src }); };
      img.onerror = function () { if (url !== src) URL.revokeObjectURL(url); reject(new Error('That photo couldn’t be opened.')); };
      img.src = url;
    });
  }
  function encode(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b && b.type === 'image/webp') return resolve(b);
        canvas.toBlob(function (j) { j ? resolve(j) : reject(new Error('Couldn’t save that photo.')); }, 'image/jpeg', 0.86);
      }, 'image/webp', 0.85);
    });
  }

  function open(opts) {
    opts = opts || {};
    var R = opts.ratio || 3 / 2, maxW = opts.maxWidth || 1600;
    return loadImage(opts.src).then(function (loaded) {
      return new Promise(function (resolveOpen) {
        var img = loaded.img, W = img.naturalWidth, H = img.naturalHeight;
        // The frame, in the photo's own pixels.
        var f = start();
        var el = document.createElement('div');
        el.className = 'pc';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', opts.title || 'Crop the photo');
        el.innerHTML =
          '<div class="pc-head"><strong>' + Hub.esc(opts.title || 'Crop the photo') + '</strong>' +
            '<span>Drag the frame to move it, or a corner to zoom.</span></div>' +
          '<div class="pc-stage"><div class="pc-box">' +
            '<img alt="" draggable="false" />' +
            // The dimming outside the frame is clipped to the photo; the
            // frame itself isn't, so its corner handles can stick out.
            '<div class="pc-clip"><div class="pc-shade"></div></div>' +
            '<div class="pc-frame" tabindex="0" aria-label="Crop frame. Arrow keys move it; plus and minus zoom.">' +
              '<i class="pc-h" data-h="0"></i><i class="pc-h" data-h="1"></i><i class="pc-h" data-h="2"></i><i class="pc-h" data-h="3"></i>' +
            '</div></div></div>' +
          '<div class="pc-foot"><button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>' +
            '<button type="button" class="btn btn-ghost pc-reset" data-act="reset">Reset</button>' +
            '<button type="button" class="btn btn-primary" data-act="save">Save</button></div>';
        document.body.appendChild(el);
        document.documentElement.classList.add('pc-open');
        var box = el.querySelector('.pc-box'), frame = el.querySelector('.pc-frame'), shade = el.querySelector('.pc-shade');
        box.querySelector('img').src = loaded.url;

        // Where the frame was last time, if it still fits; else the
        // biggest frame of this shape, in the middle.
        function start() {
          var c = opts.crop;
          if (c && c.w > 0 && c.h > 0 && c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.001 && c.y + c.h <= 1.001) {
            var w = c.w * W;
            return clamp({ x: c.x * W, y: c.y * H, w: w, h: w / R });
          }
          return fullest();
        }
        function fullest() {
          var w = Math.min(W, H * R), h = w / R;
          return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
        }
        function minWidth() { return Math.min(W, H * R) * 0.2; }
        function clamp(r) {
          var w = Math.max(minWidth(), Math.min(r.w, W, H * R)), h = w / R;
          return { x: Math.max(0, Math.min(W - w, r.x)), y: Math.max(0, Math.min(H - h, r.y)), w: w, h: h };
        }

        function fit() {
          var stage = el.querySelector('.pc-stage').getBoundingClientRect();
          // (Room round the photo for the corner wedges, which sit outside the frame.)
          var s = Math.min((stage.width - 64) / W, (stage.height - 64) / H);
          box.style.width = Math.max(1, Math.round(W * s)) + 'px';
          box.style.height = Math.max(1, Math.round(H * s)) + 'px';
          draw();
        }
        function draw() {
          [frame, shade].forEach(function (n) {
            n.style.left = (f.x / W * 100) + '%';
            n.style.top = (f.y / H * 100) + '%';
            n.style.width = (f.w / W * 100) + '%';
            n.style.height = (f.h / H * 100) + '%';
          });
        }

        /* ----- dragging -----
           With a finger, the corner being dragged aims LIFT px above it, so
           the finger never hides it (it jumps up as soon as it's touched,
           and a tap that doesn't drag puts it back). A mouse or pen drags
           it right where the pointer is. */
        var drag = null;
        function photoPoint(e, lift) {
          var r = box.getBoundingClientRect();
          return [(e.clientX - r.left) * W / r.width, (e.clientY - (lift || 0) - r.top) * H / r.height];
        }
        function resizeTo(p) {
          // The frame keeps its shape, so the corner can only travel along
          // the diagonal from the fixed corner: it goes to the point on that
          // line nearest the pointer. No smaller than a fifth of the photo,
          // and only as big as there's photo for on that side.
          var n = Math.hypot(R, 1);
          var t = (p[0] - drag.ax) * drag.sx * R / n + (p[1] - drag.ay) * drag.sy / n;
          var room = Math.min(drag.sx > 0 ? W - drag.ax : drag.ax, (drag.sy > 0 ? H - drag.ay : drag.ay) * R);
          var w = t * R / n;
          w = Math.max(Math.min(minWidth(), room), Math.min(w, room));
          var h = w / R;
          f = { x: drag.sx > 0 ? drag.ax : drag.ax - w, y: drag.sy > 0 ? drag.ay : drag.ay - h, w: w, h: h };
        }
        el.querySelector('.pc-stage').addEventListener('pointerdown', function (e) {
          if (e.button) return;
          var h = e.target.closest('.pc-h');
          if (h) {
            // A corner: the opposite corner stays put.
            var i = +h.getAttribute('data-h'), sx = i === 1 || i === 2 ? 1 : -1, sy = i >= 2 ? 1 : -1;
            drag = { kind: 'size', sx: sx, sy: sy, ax: sx > 0 ? f.x : f.x + f.w, ay: sy > 0 ? f.y : f.y + f.h,
              lift: e.pointerType === 'touch' ? LIFT : 0, was: { x: f.x, y: f.y, w: f.w, h: f.h }, at: [e.clientX, e.clientY], moved: false };
            if (drag.lift) { resizeTo(photoPoint(e, drag.lift)); draw(); }
          } else {
            drag = { kind: 'move', p: photoPoint(e), f: { x: f.x, y: f.y, w: f.w, h: f.h } };
          }
          this.setPointerCapture(e.pointerId);
          e.preventDefault();
        });
        el.querySelector('.pc-stage').addEventListener('pointermove', function (e) {
          if (!drag) return;
          if (drag.kind === 'move') {
            var p = photoPoint(e);
            f = clamp({ x: drag.f.x + p[0] - drag.p[0], y: drag.f.y + p[1] - drag.p[1], w: drag.f.w });
          } else {
            if (Math.hypot(e.clientX - drag.at[0], e.clientY - drag.at[1]) > 4) drag.moved = true;
            resizeTo(photoPoint(e, drag.lift));
          }
          draw();
        });
        ['pointerup', 'pointercancel'].forEach(function (ev) {
          el.querySelector('.pc-stage').addEventListener(ev, function () {
            if (drag && drag.kind === 'size' && drag.lift && !drag.moved) { f = drag.was; draw(); }
            drag = null;
          });
        });

        // Arrow keys move the frame; + and - zoom around its middle.
        frame.addEventListener('keydown', function (e) {
          var step = Math.min(W, H) * (e.shiftKey ? 0.05 : 0.01), d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (d) { f = clamp({ x: f.x + d[0] * step, y: f.y + d[1] * step, w: f.w }); draw(); e.preventDefault(); return; }
          var z = e.key === '+' || e.key === '=' ? 0.95 : e.key === '-' || e.key === '_' ? 1.05 : 0;
          if (z) {
            var cx = f.x + f.w / 2, cy = f.y + f.h / 2, w = Math.min(W, H * R, Math.max(minWidth(), f.w * z));
            f = clamp({ x: cx - w / 2, y: cy - w / R / 2, w: w });
            draw(); e.preventDefault();
          }
        });

        /* ----- finishing ----- */
        function done(result) {
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', fit);
          document.documentElement.classList.remove('pc-open');
          el.remove();
          if (loaded.own) URL.revokeObjectURL(loaded.url);
          resolveOpen(result);
        }
        function save() {
          var btn = el.querySelector('[data-act="save"]');
          btn.disabled = true;
          var ow = Math.max(1, Math.round(Math.min(f.w, maxW))), oh = Math.max(1, Math.round(ow / R));
          var c = document.createElement('canvas');
          c.width = ow; c.height = oh;
          var ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, ow, oh);
          encode(c).then(function (blob) {
            done({ blob: blob, crop: { x: f.x / W, y: f.y / H, w: f.w / W, h: f.h / H } });
          }).catch(function (e) { btn.disabled = false; Hub.toast(e.message, true); });
        }
        function onKey(e) {
          if (e.key === 'Escape') done(null);
          else if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); save(); }
        }
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', fit);
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          var a = b.getAttribute('data-act');
          if (a === 'cancel') done(null);
          else if (a === 'reset') { f = fullest(); draw(); }
          else if (a === 'save') save();
        });
        // Laid out now (and again on the next frame, once fonts and the
        // safe-area padding have settled).
        fit();
        requestAnimationFrame(fit);
      });
    });
  }

  window.PhotoCrop = { open: open };
})();
