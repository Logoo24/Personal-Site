/* ============================================================
   The public recipe book (/recipes, api/_family/share-page.js):
   search (every word typed must appear in a recipe's title, description,
   tags or ingredients) and a chip per tag.
   ============================================================ */
(function () {
  'use strict';
  var grid = document.querySelector('[data-book-grid]');
  if (!grid) return;
  var search = document.querySelector('[data-book-search]'), tags = document.querySelector('[data-book-tags]');
  var empty = document.querySelector('[data-book-empty]'), tag = '';
  var cards = Array.prototype.slice.call(grid.children);
  function draw() {
    var words = (search.value || '').toLowerCase().split(/\s+/).filter(Boolean), shown = 0;
    cards.forEach(function (c) {
      var hay = c.getAttribute('data-search') || '';
      var ok = (!tag || (c.getAttribute('data-tags') || '').split('|').indexOf(tag) > -1) &&
        words.every(function (w) { return hay.indexOf(w) > -1; });
      c.hidden = !ok;
      if (ok) shown++;
    });
    empty.hidden = shown > 0;
  }
  search.addEventListener('input', draw);
  if (tags) tags.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tag]');
    if (!b) return;
    tag = b.getAttribute('data-tag');
    Array.prototype.forEach.call(tags.children, function (c) { c.classList.toggle('on', c === b); });
    draw();
  });
})();
