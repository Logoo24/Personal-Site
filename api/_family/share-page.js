// The public side of the cookbook (api/recipe.js draws these):
//   /recipes          the Randall Family Recipe Book: every public recipe
//   /recipes/<slug>   one recipe, in the same view as the family hub's
//                     (scaling, tap-to-check, keep screen on, notes, the
//                     story, "Ask about this recipe"), minus anything that
//                     edits, and plus a Share button.
// Standalone pages, not part of the blog: no site nav, not in the sitemap,
// and marked noindex. The Open Graph tags give a recipe link a proper
// preview (title, description, photo) when it's sent in a text or group chat.
//
// Styled by the site's tokens (css/styles.css) plus the hub's recipe styles
// (family/assets/hub.css, open to everyone); made interactive by
// js/recipe-public.js and js/recipe-book.js.

import crypto from 'node:crypto';
import { Marked } from 'marked';
import RecipeScale from '../../js/recipe-scale.js';
import RecipeText from '../../js/recipe-text.js';

// Every page's first-paint theme line (see CLAUDE.md), the page's only inline script.
const THEME_SCRIPT = "try{document.documentElement.setAttribute('data-theme',localStorage.getItem('lb-theme')||'light')}catch(e){}";
// The pages' Content-Security-Policy (api/recipe.js sends it): the site's own
// scripts and that one line, nothing else. Public pages anyone can open, so
// even markup that slipped past the markdown renderer couldn't run. (The
// recipe data and schema.org blocks are JSON, which is never run.)
export const SHARE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${crypto.createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// JSON inside a <script> block: nothing in it can close the tag.
const jsonScript = v => JSON.stringify(v).replace(/</g, '\\u003c');

// The hub's icons (family/assets/hub.js), drawn the same way.
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  share: svg('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4M12 2v13"/>'),
  print: svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  chef: svg('<path d="M6 13.9A4 4 0 0 1 7.6 6.2a5 5 0 0 1 8.8 0A4 4 0 0 1 18 13.9V20H6z"/><path d="M6 17h12"/>'),
  sparkle: svg('<path d="M10 3c.7 4.1 2.9 6.3 7 7-4.1.7-6.3 2.9-7 7-.7-4.1-2.9-6.3-7-7 4.1-.7 6.3-2.9 7-7z"/><path d="M18.5 15c.3 1.7 1.3 2.7 3 3-1.7.3-2.7 1.3-3 3-.3-1.7-1.3-2.7-3-3 1.7-.3 2.7-1.3 3-3z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')
};

// Story photos use the same placement rules as blog posts (build.js):
// a title of "left"/"right"/"center", with an optional ": caption".
const md = new Marked({
  extensions: [RecipeText.colorExtension],
  renderer: {
    // No raw HTML, no "javascript:" links (js/recipe-text.js).
    html: RecipeText.safeRenderer.html,
    link: RecipeText.safeRenderer.link,
    image(href, title, text) {
      const raw = s => String(s || '').replace(/&(amp|lt|gt|quot|#39);/g,
        (all, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
      href = raw(href); title = raw(title); text = raw(text);
      const m = /^\s*(left|right|center|centre)\b\s*[:|\-–—]?\s*([\s\S]*)$/i.exec(title || '');
      const pos = m ? m[1].toLowerCase().replace('centre', 'center') : 'center';
      const caption = (m ? m[2] : (title || '')).trim();
      return '<figure class="post-img post-img--' + pos + '"><img src="' + esc(href) + '" alt="' + esc(text) + '" loading="lazy" decoding="async" />' +
        (caption ? '<figcaption>' + esc(caption) + '</figcaption>' : '') + '</figure>';
    }
  }
});
// opts.breaks: keep single line breaks (used for notes).
function markdown(text, opts) {
  let html = md.parse(text || '', opts && opts.breaks ? { breaks: true } : undefined);
  // A <figure> can't sit inside a <p>: lift each one out in front of it.
  const inPara = /<p>((?:(?!<\/p>)[\s\S])*?)(<figure class="post-img[\s\S]*?<\/figure>)\s*/g;
  let prev;
  do {
    prev = html;
    html = html.replace(inPara, (all, before, fig) => (before.trim() ? '<p>' + before.trim() + '</p>\n' : '') + fig + '\n<p>');
  } while (html !== prev);
  return html.replace(/<p>\s*<\/p>\n?/g, '');
}
// Notes keep every line on its own line, bulleted or not (as in the hub's
// notesMd; the rules are in js/recipe-text.js).
const notesMarkdown = text => markdown(RecipeText.notesSource(text), { breaks: true });

function minutes(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return (h ? h + ' hr' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
}
const isoDuration = n => 'PT' + (Math.floor(n / 60) ? Math.floor(n / 60) + 'H' : '') + (n % 60 ? (n % 60) + 'M' : '');
const longDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Boise' });
const publicTags = r => (r.tags || []).filter(t => t.trim().toLowerCase() !== 'want to make');
// The hub's placeholder for a recipe with no photo (Hub.placeholderBg).
function placeholderBg(title) {
  let h = 0;
  for (const c of String(title || 'r')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  h %= 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 70% 42%))`;
}

// The ingredient list at a given scale: the same markup and rules as the
// hub's (Hub.ingredientsHTML), so js/recipe-public.js can redraw it the
// same way when the servings change.
export function ingredientsHTML(list, factor) {
  return (list || []).map(ing => {
    if (ing.section != null) return '<li class="rc-ing-section">' + esc(ing.section) + '</li>';
    const q = RecipeScale.parseQty(ing.qty);
    const qty = q ? RecipeScale.scaleQty(ing.qty, factor) : (ing.qty || '');
    const unit = RecipeScale.unitFor(ing.unit, q ? q.max * factor : null);
    const head = [qty, unit].filter(Boolean).join(' ');
    return '<li><span>' + (head ? '<span class="rc-qty">' + esc(head) + '</span> ' : '') + esc(ing.item) +
      (ing.note ? '<span class="rc-note">, ' + esc(ing.note) + '</span>' : '') + '</span></li>';
  }).join('');
}

const HEAD_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231F7A4D'/%3E%3Cpath d='M8 15 16 8l8 7v9h-5.5v-6h-5v6H8z' fill='%23FAFAFA'/%3E%3C/svg%3E";
export const BOOK_TITLE = 'The Randall Family Recipe Book';

function shell({ title, description, url, image, body, scripts = '', familyLink = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script>${THEME_SCRIPT}</script>
  <title>${esc(title)}</title>
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#FAFAFA" />
  ${description ? `<meta name="description" content="${esc(description)}" />` : ''}
  ${url ? `<meta property="og:title" content="${esc(title)}" />
  <meta property="og:site_name" content="${BOOK_TITLE}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${esc(url)}" />
  ${description ? `<meta property="og:description" content="${esc(description)}" />` : ''}
  <meta property="og:image" content="${esc(image)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${esc(image)}" />` : ''}
  <link rel="icon" href="${HEAD_ICON}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="stylesheet" href="/family/assets/hub.css" />
</head>
<body class="hub pub">
  <header class="pub-bar no-print">
    <a class="pub-brand" href="/recipes"><span class="pub-logo">${ICON.chef}</span><span>${BOOK_TITLE}</span></a>
    ${familyLink}
  </header>
  <main class="hub-main pub-main">
${body}
  </main>
  <footer class="pub-foot no-print">From the Randall family kitchen · <a href="/">loganbrandall.com</a></footer>
${scripts}
</body>
</html>`;
}

// familyView: the viewer is signed in to the family hub, so the bar links
// back into the cookbook too.
export function renderSharedRecipe(r, { origin, slug, familyView, askable }) {
  const pageUrl = `${origin}/recipes/${slug}`;
  const photo = name => `/recipes/${slug}/photos/${name}`;
  // Photos in the story and notes point at the private hub; swap in the
  // public addresses.
  const publicText = text => String(text || '').replace(
    /\/api\/family\?r=media&(?:amp;)?f=([a-z0-9]{6,32}\.(?:webp|jpg|png|gif))/g, (all, name) => photo(name));
  const tags = publicTags(r);

  const facts = [];
  if (r.servings) facts.push(`<span class="pill">${ICON.users}<span data-yield>${esc(RecipeScale.formatNum(r.servings) + ' ' + (r.yieldUnit || 'servings'))}</span></span>`);
  if (r.prepMinutes) facts.push(`<span class="pill">${ICON.clock}Prep ${minutes(r.prepMinutes)}</span>`);
  if (r.cookMinutes) facts.push(`<span class="pill">${ICON.clock}Cook ${minutes(r.cookMinutes)}</span>`);
  if (r.prepMinutes && r.cookMinutes) facts.push(`<span class="pill">${ICON.clock}Total ${minutes(r.prepMinutes + r.cookMinutes)}</span>`);
  const scale = r.servings
    ? '<div class="rc-scale"><span class="rc-scale-count"><button type="button" data-scale-step="-1" aria-label="Fewer">−</button>' +
      `<input type="number" min="0.25" step="any" value="${+r.servings.toFixed(2)}" data-scale-input aria-label="Servings" />` +
      `<button type="button" data-scale-step="1" aria-label="More">+</button></span><span class="rc-scale-unit">${esc(r.yieldUnit || 'servings')}</span>` +
      '<div class="chips">' + [0.5, 1, 2, 3].map(f => `<button type="button" class="chip${f === 1 ? ' on' : ''}" data-scale-factor="${f}">${f === 0.5 ? '½' : f}×</button>`).join('') + '</div></div>'
    : '';
  const steps = (r.steps || []).map(s => '<li>' + md.parseInline(RecipeText.stepSource(s), { breaks: true }) + '</li>').join('');
  const story = r.story && r.story.trim() ? markdown(publicText(r.story)) : '';
  const byline = r.createdBy && r.createdAt
    ? `Added by ${esc(r.createdBy)} on ${longDate(r.createdAt)}` +
      (r.updatedAt && r.updatedAt !== r.createdAt && r.updatedBy ? ` · Last edited by ${esc(r.updatedBy)} on ${longDate(r.updatedAt)}` : '')
    : '';

  const ld = JSON.parse(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: r.title,
    description: r.summary || undefined,
    image: r.cover ? [origin + photo(r.cover)] : undefined,
    author: { '@type': 'Person', name: r.source || 'The Randall family' },
    prepTime: r.prepMinutes ? isoDuration(r.prepMinutes) : undefined,
    cookTime: r.cookMinutes ? isoDuration(r.cookMinutes) : undefined,
    totalTime: r.prepMinutes || r.cookMinutes ? isoDuration((r.prepMinutes || 0) + (r.cookMinutes || 0)) : undefined,
    recipeYield: r.servings ? r.servings + ' ' + (r.yieldUnit || 'servings') : undefined,
    recipeCategory: tags[0],
    recipeIngredient: (r.ingredients || []).filter(i => i.section == null).map(i => [i.qty, i.unit, i.item].filter(Boolean).join(' ') + (i.note ? ', ' + i.note : '')),
    recipeInstructions: (r.steps || []).map(text => ({ '@type': 'HowToStep', text: RecipeText.plain(text) }))
  }));
  // What js/recipe-public.js needs to scale, share and ask.
  const data = { slug, title: r.title, url: pageUrl, servings: r.servings || null, yieldUnit: r.yieldUnit || 'servings', ingredients: r.ingredients || [] };

  const body = `    <div class="hub-head pub-head no-print">
      <a class="btn btn-ghost btn-sm" href="/recipes">← All Randall family recipes</a>
      <div class="hub-actions">
        <button class="btn btn-ghost" type="button" data-print>${ICON.print}Print</button>
        <button class="btn btn-primary" type="button" data-share>${ICON.share}Share</button>
      </div>
    </div>
    <article id="recipe">
      <header class="rc-hero">
        ${r.cover ? `<img class="rc-cover" src="${esc(photo(r.cover))}" alt="${esc(r.title)}" />` : ''}
        ${tags.length ? '<div class="rc-tags">' + tags.map(t => '<span class="rc-tag">' + esc(t) + '</span>').join('<span class="rc-tag">·</span>') + '</div>' : ''}
        <h1 class="rc-title">${esc(r.title)}</h1>
        ${r.summary ? `<p class="rc-summary">${esc(r.summary)}</p>` : ''}
        ${r.source ? `<p class="rc-source">From ${esc(r.source)}</p>` : ''}
        ${facts.length ? `<div class="rc-facts">${facts.join('')}</div>` : ''}
      </header>
      <div class="rc-body">
        <section class="rc-ingredients"><div class="rc-ing-head"><h2>Ingredients</h2></div>${scale}
          ${(r.ingredients || []).length ? `<ul class="rc-ing-list" data-ingredients>${ingredientsHTML(r.ingredients, 1)}</ul>` : '<p class="rc-source">No ingredients listed.</p>'}
        </section>
        <section class="rc-steps"><div class="rc-steps-head"><h2>Steps</h2><label class="rc-awake" hidden><input type="checkbox" data-wake /> Keep screen on</label></div>
          ${steps ? `<ol>${steps}</ol>` : '<p class="rc-source">No steps yet.</p>'}
          ${r.notes ? `<div class="rc-notes"><h2>Notes &amp; tips</h2><div class="rc-prose">${notesMarkdown(publicText(r.notes))}</div></div>` : ''}
        </section>
      </div>
      ${story ? `<section class="rc-story"><h2>The story</h2><div class="rc-prose">${story}</div></section>` : ''}
    </article>
    ${byline ? `<p class="rc-byline no-print">${byline}</p>` : ''}
    ${askable ? '' : '<!--'}<section class="rc-ask no-print" id="ask" hidden aria-labelledby="ask-title">
      <div class="rc-ask-head">
        <div>
          <h2 id="ask-title">${ICON.sparkle}Ask about this recipe</h2>
          <p class="rc-ask-sub">Substitutions, timing, making it ahead, what went wrong… Claude answers from this recipe.</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="ask-clear" hidden>New conversation</button>
      </div>
      <div class="rc-ask-thread" id="ask-thread" aria-live="polite"></div>
      <div class="rc-ask-starters" id="ask-starters"></div>
      <form class="rc-ask-form" id="ask-form">
        <textarea class="input" id="ask-input" rows="1" maxlength="500" placeholder="Ask a question" aria-label="Your question about this recipe"></textarea>
        <button class="btn btn-primary" type="submit" id="ask-send">Ask</button>
      </form>
      <p class="rc-ask-note">Answers come from Claude and can be wrong. Double-check anything about allergies or food safety.</p>
    </section>${askable ? '' : '-->'}`;

  return shell({
    title: r.title + ' · Randall family recipe',
    description: r.summary || `A Randall family recipe for ${r.title.toLowerCase()}.`,
    url: pageUrl,
    image: r.cover ? origin + photo(r.cover) : origin + '/images/og-card.jpg',
    body,
    familyLink: familyView ? `<a class="pub-family" href="/family/cookbook/recipe?id=${encodeURIComponent(r.id)}" title="Open this recipe in the family cookbook">Family cookbook</a>` : '',
    scripts: `  <script type="application/json" id="recipe-data">${jsonScript(data)}</script>
  <script type="application/ld+json">${jsonScript(ld)}</script>
  <script src="/js/recipe-scale.js" defer></script>
  <script src="/js/recipe-public.js" defer></script>`
  });
}

// The recipe book: a card per public recipe (list: summaries from the
// cookbook's index), with search and a chip per tag (js/recipe-book.js).
export function renderBook(list, { origin, familyView }) {
  const tags = [...new Set(list.flatMap(publicTags))].sort((a, b) => a.localeCompare(b));
  const card = r => {
    const slug = r.published.slug, meta = [];
    if (r.totalMinutes) meta.push(ICON.clock + minutes(r.totalMinutes));
    if (r.servings) meta.push(ICON.users + esc(RecipeScale.formatNum(r.servings) + ' ' + (r.yieldUnit || 'servings')));
    const search = [r.title, r.summary, publicTags(r).join(' '), r.search].join(' ').toLowerCase();
    return `<a class="cb-card" href="/recipes/${esc(slug)}" data-tags="${esc(publicTags(r).join('|'))}" data-search="${esc(search)}">
        <div class="cb-thumb">${r.cover
          ? `<img src="/recipes/${esc(slug)}/photos/${esc(r.cover)}" alt="" loading="lazy" decoding="async" />`
          : `<div class="cb-placeholder" style="background:${placeholderBg(r.title)}">${esc(r.title.trim().charAt(0).toUpperCase())}</div>`}</div>
        <div class="cb-card-body"><h3>${esc(r.title)}</h3>${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
          ${meta.length ? `<div class="cb-card-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}</div>
      </a>`;
  };
  const body = `    <header class="pub-hero">
      <span class="eyebrow">From our kitchen to yours</span>
      <h1>${BOOK_TITLE}</h1>
      <p>${list.length === 1 ? 'One recipe' : list.length + ' recipes'} the Randall family makes again and again, with the stories behind them.</p>
    </header>
    ${list.length ? `<div class="pub-find no-print">
      <label class="search pub-search">${ICON.search}<input class="input" type="search" placeholder="Search recipes or ingredients" aria-label="Search recipes" data-book-search /></label>
      ${tags.length ? `<div class="chips pub-tags" data-book-tags><button type="button" class="chip on" data-tag="">All</button>${tags.map(t => `<button type="button" class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="cb-grid pub-grid" data-book-grid>
      ${list.map(card).join('\n      ')}
    </div>
    <p class="pub-empty" data-book-empty hidden>No recipes match that.</p>` : '<p class="pub-empty">No recipes here yet. Check back soon.</p>'}`;
  return shell({
    title: BOOK_TITLE,
    description: 'Recipes, stories and photos from the Randall family kitchen.',
    url: `${origin}/recipes`,
    image: `${origin}/images/og-card.jpg`,
    body,
    familyLink: familyView ? '<a class="pub-family" href="/family/cookbook" title="Open the family cookbook">Family cookbook</a>' : '',
    scripts: '  <script src="/js/recipe-book.js" defer></script>'
  });
}

export function renderNotShared() {
  return shell({
    title: 'Recipe not found · ' + BOOK_TITLE,
    body: `    <div class="hub-empty pub-missing">
      <h3>This recipe isn’t shared</h3>
      <p>The link may have changed, or the family keeps this one private.</p>
      <a class="btn btn-primary" href="/recipes">See all Randall family recipes</a>
    </div>`
  });
}
