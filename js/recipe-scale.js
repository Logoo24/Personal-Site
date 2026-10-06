/* ============================================================
   recipe-scale.js - ingredient quantities: parse, scale, format.
   Shared by the family hub (window.RecipeScale), the public recipe
   pages (main.js scaler) and build.js (require).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecipeScale = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VULGAR = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅙': 1 / 6 };
  var NUM = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+\\s*[¼½¾⅓⅔⅛⅜⅝⅞⅕⅙]|[¼½¾⅓⅔⅛⅜⅝⅞⅕⅙]|\\d+)';
  var QTY_RE = new RegExp('^\\s*(' + NUM + ')(?:\\s*(?:-|–|—|to)\\s*(' + NUM + '))?');

  function num(s) {
    s = String(s).trim();
    var m;
    if ((m = /^(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅙])$/.exec(s))) return +m[1] + VULGAR[m[2]];
    if (VULGAR[s] != null) return VULGAR[s];
    if ((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s))) return +m[1] + m[2] / m[3];
    if ((m = /^(\d+)\/(\d+)$/.exec(s))) return m[2] == 0 ? NaN : m[1] / m[2];
    return parseFloat(s);
  }

  // "1 1/2" -> { min: 1.5, max: 1.5 }, "2-3" -> { min: 2, max: 3 }, "a pinch" -> null
  function parseQty(str) {
    if (str == null) return null;
    var s = String(str).trim();
    var m = QTY_RE.exec(s);
    if (!m || m[0].trim().length !== s.length) return null;
    var a = num(m[1]), b = m[2] ? num(m[2]) : a;
    return isFinite(a) && isFinite(b) ? { min: a, max: b } : null;
  }

  var FRACS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];

  // 1.5 -> "1½", 0.333 -> "⅓", 2.04 -> "2". Rounds to kitchen-friendly
  // fractions; tiny amounts fall back to decimals.
  function formatNum(n) {
    if (!isFinite(n)) return '';
    if (n > 0 && n < 0.1) return String(Math.round(n * 100) / 100);
    if (n >= 20) return String(Math.round(n));
    var whole = Math.floor(n), frac = n - whole, best = FRACS[0];
    FRACS.forEach(function (f) { if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f; });
    if (best[0] === 1) { whole += 1; best = FRACS[0]; }
    if (!whole && !best[1]) return '0';
    return (whole ? String(whole) : '') + best[1];
  }

  function formatQty(q) {
    if (!q) return '';
    return q.min === q.max ? formatNum(q.min) : formatNum(q.min) + '–' + formatNum(q.max);
  }

  // Scales a quantity string. Strings that aren't numbers ("a pinch")
  // come back unchanged.
  function scaleQty(str, factor) {
    var q = parseQty(str);
    if (!q) return str || '';
    if (factor === 1) return formatQty(q);
    return formatQty({ min: q.min * factor, max: q.max * factor });
  }

  // Singular/plural unit pairs, so "1 cup" doubles to "2 cups".
  var UNIT_PAIRS = [
    ['cup', 'cups'], ['tablespoon', 'tablespoons'], ['teaspoon', 'teaspoons'], ['pound', 'pounds'],
    ['ounce', 'ounces'], ['can', 'cans'], ['clove', 'cloves'], ['slice', 'slices'], ['stick', 'sticks'],
    ['package', 'packages'], ['pinch', 'pinches'], ['dash', 'dashes'], ['quart', 'quarts'], ['pint', 'pints'],
    ['gallon', 'gallons'], ['jar', 'jars'], ['bunch', 'bunches'], ['head', 'heads'], ['sprig', 'sprigs'],
    ['bag', 'bags'], ['box', 'boxes'], ['bottle', 'bottles'], ['envelope', 'envelopes'], ['handful', 'handfuls'],
    ['piece', 'pieces'], ['scoop', 'scoops'], ['drop', 'drops'], ['stalk', 'stalks'], ['fillet', 'fillets'],
    ['liter', 'liters'], ['milliliter', 'milliliters'], ['gram', 'grams'], ['kilogram', 'kilograms'], ['container', 'containers']
  ];
  var ABBREV = ['c', 'c.', 'tbsp', 'tbsp.', 'tbs', 'tbs.', 'tsp', 'tsp.', 'oz', 'oz.', 'lb', 'lb.', 'lbs', 'lbs.', 'g', 'kg', 'ml', 'l', 'qt', 'qt.', 'pt', 'pt.', 'pkg', 'pkg.', 'fl oz', 'T', 't'];
  var SINGULAR = {}, PLURAL = {};
  UNIT_PAIRS.forEach(function (p) { PLURAL[p[0]] = p[1]; SINGULAR[p[1]] = p[0]; });

  function unitFor(unit, amount) {
    if (!unit) return '';
    var lower = unit.toLowerCase();
    if (amount == null) return unit;
    var plural = amount > 1;
    if (plural && PLURAL[lower]) return PLURAL[lower];
    if (!plural && SINGULAR[lower]) return SINGULAR[lower];
    return unit;
  }

  var UNIT_WORDS = Object.keys(PLURAL).concat(Object.keys(SINGULAR)).concat(ABBREV)
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (u) { return u.replace(/[.]/g, '\\.'); });
  var UNIT_RE = new RegExp('^(' + UNIT_WORDS.join('|') + ')(?=\\s|$)', 'i');

  // "1 1/2 cups flour, sifted" -> { qty: "1 1/2", unit: "cups", item: "flour", note: "sifted" }
  // A line ending in ":" ("For the glaze:") becomes { section: "For the glaze" }.
  function parseIngredientLine(line) {
    var s = String(line || '').replace(/^\s*(?:[-*•▢□☐]|\d+[.)](?=\s))\s*/, '').trim();
    if (!s) return null;
    if (/:$/.test(s)) return { section: s.replace(/:$/, '').trim() };
    var qty = '', unit = '', note = '';
    var m = QTY_RE.exec(s);
    if (m) { qty = m[0].trim(); s = s.slice(m[0].length).trim(); }
    var u = UNIT_RE.exec(s);
    if (u && (qty || /^(pinch|dash|handful)/i.test(u[1]))) { unit = u[1]; s = s.slice(u[0].length).trim(); }
    s = s.replace(/^of\s+/i, '');
    var comma = s.indexOf(',');
    if (comma > 0) { note = s.slice(comma + 1).trim(); s = s.slice(0, comma).trim(); }
    return { qty: qty, unit: unit, item: s, note: note };
  }

  // The base amount a quantity string represents (for data attributes).
  function baseAmount(str) {
    var q = parseQty(str);
    return q ? q : null;
  }

  return {
    parseQty: parseQty, formatQty: formatQty, formatNum: formatNum, scaleQty: scaleQty,
    unitFor: unitFor, parseIngredientLine: parseIngredientLine, baseAmount: baseAmount
  };
});
