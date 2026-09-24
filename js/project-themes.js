/* ===========================================
   Projects page - per-project card themes
   Keyed by `theme` in data/projects.json. A theme can provide:
     title(h3, item)  fill the card's <h3> (e.g. with a logo) instead of text
     behind           HTML for decoration rendered behind the card
   Styles live in css/projects.css under .proj--<theme>. Items whose theme
   isn't registered here render as a plain site card.

   To give a new project its own look: add an entry below, add its styles,
   and add the theme to the "Theme" select in admin/config.yml.
   =========================================== */

(function () {
  'use strict';

  // Kernels that hop out of the bucket on hover: drift, height, spin, delay.
  var kernels = [
    ['-28px', '-46px', '-200deg', '0s'],
    ['22px', '-58px', '160deg', '.12s'],
    ['-4px', '-70px', '260deg', '.24s']
  ].map(function (k) {
    return '<span class="cam-kernel" style="--x:' + k[0] + ';--y:' + k[1] + ';--r:' + k[2] + ';--d:' + k[3] + '"></span>';
  }).join('');

  window.PROJECT_THEMES = {
    chooseamovie: {
      title: function (h3, item) {
        // Logo is served from chooseamovie.app itself; if it can't load,
        // fall back to the text wordmark in the same brand colors.
        var img = document.createElement('img');
        img.className = 'cam-logo';
        img.src = 'https://www.chooseamovie.app/brand/logo-lockup.svg';
        img.alt = item.title || 'ChooseAMovie';
        img.width = 215;
        img.height = 46;
        img.addEventListener('error', function () {
          var mark = document.createElement('span');
          mark.className = 'cam-wordmark';
          mark.innerHTML = 'Choose<b>A</b>Movie';
          img.replaceWith(mark);
        });
        h3.appendChild(img);
      },
      behind:
        '<div class="cam-bucket">' + kernels +
          '<svg viewBox="0 0 100 120">' +
            '<g fill="#FFCC33"><circle cx="24" cy="30" r="13"/><circle cx="42" cy="22" r="15"/><circle cx="62" cy="24" r="14"/><circle cx="78" cy="34" r="11"/><circle cx="16" cy="38" r="9"/><circle cx="52" cy="36" r="10"/><circle cx="33" cy="38" r="10"/></g>' +
            '<g fill="#FFE08A"><circle cx="37" cy="15" r="6"/><circle cx="60" cy="17" r="5"/><circle cx="22" cy="25" r="4"/></g>' +
            '<path d="M10 42H90L80 120H20Z" fill="#F5F5F8"/>' +
            '<g fill="#E50914"><path d="M10 42H23.3L30 120H20Z"/><path d="M36.7 42H50V120H40Z"/><path d="M63.3 42H76.7L70 120H60Z"/></g>' +
            '<rect x="7" y="38" width="86" height="8" rx="3" fill="#B70710"/>' +
          '</svg>' +
        '</div>'
    }
  };
})();
