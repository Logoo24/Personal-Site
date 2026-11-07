/* ============================================================
   recipe-text.js - the formatting recipes allow: **bold**, *italic*,
   bulleted and numbered lists, and colored text written as
   [some words]{red}. Shared by the family hub (window.RecipeText) and
   the public recipe page (api/_family/share-page.js), so a recipe looks
   the same in both. The colors are classes styled in css/styles.css.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecipeText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Order is the order of the editor's color menu.
  var COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'highlight'];
  var COLOR_RE = new RegExp('^\\[([^\\[\\]\\n]+)\\]\\{(' + COLORS.join('|') + ')\\}');

  // A marked extension for [words]{color}. The words can carry their own
  // bold or italic.
  var colorExtension = {
    name: 'textColor',
    level: 'inline',
    start: function (src) {
      var i = src.search(/\[[^\[\]\n]+\]\{/);
      return i < 0 ? undefined : i;
    },
    tokenizer: function (src) {
      var m = COLOR_RE.exec(src);
      if (m) return { type: 'textColor', raw: m[0], color: m[2], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer: function (token) {
      return '<span class="tx-' + token.color + '">' + this.parser.parseInline(token.tokens) + '</span>';
    }
  };

  // Notes keep every line on its own line, bulleted or not. Markdown would
  // join a plain line onto the bullet above it, so it gets its own
  // paragraph. The notes box used to put "- " in front of every line, so
  // a numbered line typed there came out as "- 1. ..." (a numbered list
  // inside a bullet, pushed far to the right): drop that bullet.
  function notesSource(text) {
    var item = /^\s*([-*+]|\d+[.)])\s/, out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.replace(/^(\s*)[-*+•]\s+(\d+[.)]\s)/, '$1$2');
      var prev = out[out.length - 1];
      if (prev != null && item.test(prev) && line.trim() && !item.test(line) && !/^\s/.test(line)) out.push('');
      out.push(line);
    });
    return out.join('\n');
  }

  // A step is one paragraph: bold, italic and color only. Angle brackets
  // are escaped first so a step can't carry raw HTML.
  function stepSource(text) {
    return String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // marked renderer overrides that keep recipe text from carrying a script:
  // raw HTML shows as text, and links go only to web pages, email or this
  // site (marked itself lets "javascript:" links through).
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var unesc = function (s) {
    return String(s || '').replace(/&(amp|lt|gt|quot|#39);/g, function (a, e) { return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]; });
  };
  var safeRenderer = {
    html: function (html) { return esc(typeof html === 'object' ? html.text : html); },
    link: function (href, title, text) {
      var url = unesc(href).trim();
      // Browsers skip spaces and control characters inside a scheme.
      var probe = url.replace(/[\u0000- ]/g, '').toLowerCase();
      if (/^[a-z][a-z0-9+.\-]*:/.test(probe) && !/^(https?|mailto):/.test(probe)) return text;
      return '<a href="' + esc(url) + '"' + (title ? ' title="' + esc(unesc(title)) + '"' : '') + ' rel="noopener noreferrer">' + text + '</a>';
    }
  };

  // The words without their formatting marks (search, schema.org data,
  // shopping lists).
  function plain(text) {
    return String(text || '')
      .replace(/\[([^\[\]\n]+)\]\{(?:[a-z]+)\}/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, '$2');
  }

  return { COLORS: COLORS, colorExtension: colorExtension, safeRenderer: safeRenderer, notesSource: notesSource, stepSource: stepSource, plain: plain };
});
