// The page behind a public recipe link (/recipes/<slug>). It's a standalone
// page, not part of the blog: no site nav, not in the sitemap, and marked
// noindex so search engines leave it alone. The Open Graph tags give it a
// proper preview (title, description, photo) when the link is sent in a
// text or group chat.
//
// Uses the site's recipe-card styles (css/styles.css) and main.js's servings
// scaler and print button.

import { Marked } from 'marked';
import RecipeScale from '../../js/recipe-scale.js';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Story photos use the same placement rules as blog posts (build.js):
// a title of "left"/"right"/"center", with an optional ": caption".
const md = new Marked({
  renderer: {
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
function markdown(text) {
  let html = md.parse(text || '');
  // A <figure> can't sit inside a <p>: lift each one out in front of it.
  const inPara = /<p>((?:(?!<\/p>)[\s\S])*?)(<figure class="post-img[\s\S]*?<\/figure>)\s*/g;
  let prev;
  do {
    prev = html;
    html = html.replace(inPara, (all, before, fig) => (before.trim() ? '<p>' + before.trim() + '</p>\n' : '') + fig + '\n<p>');
  } while (html !== prev);
  return html.replace(/<p>\s*<\/p>\n?/g, '');
}

function minutesLabel(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return (h ? h + ' hr' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
}
const isoDuration = n => 'PT' + (Math.floor(n / 60) ? Math.floor(n / 60) + 'H' : '') + (n % 60 ? (n % 60) + 'M' : '');

const HEAD_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231F7A4D'/%3E%3Cpath d='M8 15 16 8l8 7v9h-5.5v-6h-5v6H8z' fill='%23FAFAFA'/%3E%3C/svg%3E";

function shell({ title, description, url, image, body, status }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script>try{document.documentElement.setAttribute('data-theme',localStorage.getItem('lb-theme')||'light')}catch(e){}</script>
  <title>${esc(title)}</title>
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#FAFAFA" />
  ${description ? `<meta name="description" content="${esc(description)}" />` : ''}
  ${status === 200 ? `<meta property="og:title" content="${esc(title)}" />
  <meta property="og:site_name" content="The Randall Family Kitchen" />
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
</head>
<body>
  <main id="main" class="shared-recipe">
${body}
  </main>
  <footer class="shared-recipe-foot">Shared from the Randall family cookbook</footer>
  <script src="/js/recipe-scale.js" defer></script>
  <script src="/js/main.js" defer></script>
</body>
</html>`;
}

export function renderSharedRecipe(r, { origin, slug }) {
  const pageUrl = `${origin}/recipes/${slug}`;
  const photo = name => `/recipes/${slug}/photos/${name}`;
  // Photos in the story and notes point at the private hub; swap in the
  // public addresses.
  const publicText = text => String(text || '').replace(
    /\/api\/family\?r=media&(?:amp;)?f=([a-z0-9]{6,32}\.(?:webp|jpg|png|gif))/g, (all, name) => photo(name));

  const facts = [];
  if (r.servings) facts.push('<span class="recipe-fact" data-yield="' + esc(r.yieldUnit || 'servings') + '">' + esc(RecipeScale.formatNum(r.servings) + ' ' + (r.yieldUnit || 'servings')) + '</span>');
  if (r.prepMinutes) facts.push('<span class="recipe-fact">Prep ' + minutesLabel(r.prepMinutes) + '</span>');
  if (r.cookMinutes) facts.push('<span class="recipe-fact">Cook ' + minutesLabel(r.cookMinutes) + '</span>');
  if (r.prepMinutes && r.cookMinutes) facts.push('<span class="recipe-fact">Total ' + minutesLabel(r.prepMinutes + r.cookMinutes) + '</span>');

  const ingredients = (r.ingredients || []).map(i => {
    if (i.section != null) return '<li class="ing-section">' + esc(i.section) + '</li>';
    const q = RecipeScale.parseQty(i.qty);
    const amount = [q ? RecipeScale.formatQty(q) : (i.qty || ''), i.unit || ''].filter(Boolean).join(' ');
    return '<li>' + (amount ? '<span class="ing-amt"' + (q ? ' data-qty="' + esc(i.qty) + '" data-unit="' + esc(i.unit || '') + '"' : '') + '>' + esc(amount) + '</span> ' : '') +
      esc(i.item || '') + (i.note ? '<span class="ing-note">, ' + esc(i.note) + '</span>' : '') + '</li>';
  }).join('\n');
  const steps = (r.steps || []).map(s => '<li>' + esc(s).replace(/\n/g, '<br>') + '</li>').join('\n');
  const story = r.story && r.story.trim() ? markdown(publicText(r.story)) : '';
  const scaler = r.servings
    ? '<div class="recipe-scale" data-servings="' + r.servings + '" hidden><span class="recipe-scale-label">Scale</span>' +
      [0.5, 1, 2, 3].map(f => '<button type="button" class="recipe-scale-btn' + (f === 1 ? ' on' : '') + '" data-factor="' + f + '">' + (f === 0.5 ? '½' : f) + '×</button>').join('') + '</div>'
    : '';

  const publicTags = (r.tags || []).filter(t => t.trim().toLowerCase() !== 'want to make');
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
    recipeCategory: publicTags[0],
    recipeIngredient: (r.ingredients || []).filter(i => i.section == null).map(i => [i.qty, i.unit, i.item].filter(Boolean).join(' ') + (i.note ? ', ' + i.note : '')),
    recipeInstructions: (r.steps || []).map(text => ({ '@type': 'HowToStep', text }))
  }));

  const body = `    <article class="article">
      <header class="article-head">
        <span class="article-meta">From the Randall family kitchen</span>
        <h1>${esc(r.title)}</h1>
        ${r.summary ? `<p style="font-size:1.1rem; color: var(--text-soft);">${esc(r.summary)}</p>` : ''}
      </header>
      <div class="article-body">
        ${r.cover ? `<figure class="recipe-cover"><img src="${esc(photo(r.cover))}" alt="${esc(r.title)}" /></figure>` : ''}
        ${facts.length || story ? `<div class="recipe-intro">${facts.length ? `<div class="recipe-facts">${facts.join('')}</div>` : ''}${story ? '<a href="#recipe" class="recipe-jump">Jump to recipe ↓</a>' : ''}</div>` : ''}
        ${r.source ? `<p class="recipe-source">From ${esc(r.source)}</p>` : ''}
        ${story}
        <section class="recipe-card" id="recipe">
          <div class="recipe-card-head">
            <h2>${esc(r.title)}</h2>
            <button type="button" class="recipe-print" data-print-recipe>Print recipe</button>
          </div>
          ${facts.length ? `<div class="recipe-facts">${facts.join('')}</div>` : ''}
          ${scaler}
          <div class="recipe-cols">
            <div>
              <h3>Ingredients</h3>
              <ul class="recipe-ingredients">
${ingredients}
              </ul>
            </div>
            <div>
              <h3>Steps</h3>
              <ol class="recipe-steps">
${steps}
              </ol>
            </div>
          </div>
          ${r.notes ? `<div class="recipe-notes"><h3>Notes &amp; tips</h3>${markdown(publicText(r.notes))}</div>` : ''}
        </section>
      </div>
    </article>
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  return shell({
    title: r.title + ' · Randall family recipe',
    description: r.summary || `A Randall family recipe for ${r.title.toLowerCase()}.`,
    url: pageUrl,
    image: r.cover ? origin + photo(r.cover) : origin + '/images/og-card.jpg',
    body,
    status: 200
  });
}

export function renderNotShared() {
  return shell({
    title: 'Recipe not found',
    status: 404,
    body: `    <article class="article">
      <header class="article-head">
        <span class="article-meta">The Randall family kitchen</span>
        <h1>This recipe isn’t shared</h1>
        <p style="font-size:1.1rem; color: var(--text-soft);">The link may have changed, or the recipe was made private.</p>
      </header>
    </article>`
  });
}
