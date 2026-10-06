/* ============================================================
   build.js - reads markdown posts from _posts/ and generates
   posts/[slug].html and one page per class in classes/[slug].html,
   turns recipes shared from the family hub (_recipes/*.md) into
   recipes/[slug].html, and injects post lists into blog.html,
   index.html and recipes.html and the Blog dropdown menu into every
   page's nav.
   Vercel runs this on every push via `npm run build`.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const RecipeScale = require('./js/recipe-scale.js');

const ROOT = __dirname;
const POSTS_SRC = path.join(ROOT, '_posts');
const POSTS_OUT = path.join(ROOT, 'posts');
const TEMPLATE = path.join(ROOT, '_src', 'post-template.html');
const CLASS_TEMPLATE = path.join(ROOT, '_src', 'class-template.html');
const CLASSES_OUT = path.join(ROOT, 'classes');
// The class list (edited from /admin/ -> Classes). Each entry is
// { code: "MKT 353", name: "Web Business Creation", archived: false }.
const CLASSES_FILE = path.join(ROOT, '_data', 'classes.json');
// Recipes shared publicly from the family hub (/family/cookbook). The hub
// commits them here; they aren't edited by hand or by the CMS.
const RECIPES_SRC = path.join(ROOT, '_recipes');
const RECIPES_OUT = path.join(ROOT, 'recipes');

// Top-level pages that carry the site nav (and so the Blog dropdown).
const ROOT_PAGES = ['index.html', 'about.html', 'blog.html', 'recipes.html', 'projects.html', 'resume.html'];

// Absolute URL of the production site. Used to build absolute URLs for
// Open Graph / Twitter share-card image meta tags (social crawlers don't
// run JS, so these have to be baked into the HTML at build time).
const SITE_URL = 'https://www.loganbrandall.com';

// Social-share card (1200x630). Must be a PNG/JPG - most crawlers ignore SVG.
const OG_IMAGE = '/images/og-card.jpg';

const CATEGORY_LABELS = {
  personal: 'Personal Blog',
  academic: 'Academic Blog',
  recipe: 'Family Recipes',
  // Legacy values kept as fallbacks so older posts still render a sensible
  // label if they haven't been migrated. New posts should use personal/academic.
  essay: 'Personal Blog',
  class: 'Academic Blog',
  research: 'Academic Blog',
  project: 'Personal Blog'
};
// Categories whose posts belong to a class (and so live on a class page,
// not the main blog).
const CLASS_CATEGORIES = new Set(['academic', 'class', 'research']);
// Class used for an academic post that doesn't say which class it's for.
const FALLBACK_CLASS = 'Other classes';

// Images in posts. Markdown has no way to say where an image sits, so the
// image's *title* carries it: ![alt](src "left"), "right" or "center"
// (the default), optionally followed by a caption - "right: My caption".
// A title without a position word is just a caption on a centered image.
// Left/right images float with the text wrapping around them.
marked.use({
  renderer: {
    image(href, title, text) {
      // marked hands these over already HTML-escaped; undo that so the
      // escapeHtml() calls below don't escape them twice (&#39; showing
      // up literally in a caption).
      const raw = s => String(s || '').replace(/&(amp|lt|gt|quot|#39);/g,
        (all, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
      href = raw(href); title = raw(title); text = raw(text);
      const m = /^\s*(left|right|center|centre)\b\s*[:|\-–—]?\s*([\s\S]*)$/i.exec(title || '');
      const pos = m ? m[1].toLowerCase().replace('centre', 'center') : 'center';
      const caption = (m ? m[2] : (title || '')).trim();
      return '<figure class="post-img post-img--' + pos + '">' +
        '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text || '') + '" loading="lazy" decoding="async" />' +
        (caption ? '<figcaption>' + escapeHtml(caption) + '</figcaption>' : '') +
        '</figure>';
    }
  }
});

// marked wraps an image in the paragraph it was typed in, but a <figure>
// can't live inside a <p>. Lift each figure out in front of its paragraph
// (so a floated image still sits beside the text that followed it).
function renderMarkdown(md) {
  let html = marked.parse(md || '');
  const figure = '<figure class="post-img[\\s\\S]*?</figure>';
  const inPara = new RegExp('<p>((?:(?!</p>)[\\s\\S])*?)(' + figure + ')\\s*', 'g');
  let prev;
  do {
    prev = html;
    html = html.replace(inPara, (all, before, fig) => (before.trim() ? '<p>' + before.trim() + '</p>\n' : '') + fig + '\n<p>');
  } while (html !== prev);
  return html.replace(/<p>\s*<\/p>\n?/g, '');
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadClasses() {
  if (!fs.existsSync(CLASSES_FILE)) return [];
  const data = JSON.parse(fs.readFileSync(CLASSES_FILE, 'utf8'));
  return (Array.isArray(data.classes) ? data.classes : [])
    .filter(c => c && String(c.code || '').trim())
    .map(c => ({
      code: String(c.code).trim(),
      name: String(c.name || '').trim(),
      archived: !!c.archived,
      slug: slugify(c.code)
    }));
}

function asDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    // YYYY-MM-DD or full ISO - parse as UTC noon to avoid TZ shifts
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 12));
    return new Date(v);
  }
  return new Date();
}
function fmtLong(v) {
  return asDate(v).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function fmtShort(v) {
  return asDate(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
}

function injectBetween(file, startMarker, endMarker, content, indent) {
  if (!fs.existsSync(file)) {
    console.warn('skip (file not found):', file);
    return;
  }
  let html = fs.readFileSync(file, 'utf8');
  const sIdx = html.indexOf(startMarker);
  const eIdx = html.indexOf(endMarker);
  if (sIdx === -1 || eIdx === -1) {
    console.warn('skip (markers not found):', file);
    return;
  }
  const before = html.slice(0, sIdx + startMarker.length);
  const after = html.slice(eIdx);
  fs.writeFileSync(file, before + '\n' + content + '\n' + (indent == null ? '        ' : indent) + after);
  console.log('injected into:', path.basename(file));
}

function build() {
  if (!fs.existsSync(POSTS_SRC)) {
    console.log('No _posts/ directory; nothing to build.');
    return;
  }
  for (const dir of [POSTS_OUT, CLASSES_OUT, RECIPES_OUT]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  for (const t of [TEMPLATE, CLASS_TEMPLATE]) {
    if (!fs.existsSync(t)) {
      console.error('Missing template: ' + path.relative(ROOT, t));
      process.exit(1);
    }
  }
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const files = fs.readdirSync(POSTS_SRC).filter(f => f.endsWith('.md'));
  const posts = [];
  const classes = loadClasses();

  // Finds the class a post belongs to by code (or slug, so "mkt353" and
  // "MKT 353" match). A class that isn't in _data/classes.json yet still
  // gets a page, so a post never disappears because the list is behind.
  function classFor(code) {
    const slug = slugify(code);
    let c = classes.find(x => x.slug === slug);
    if (!c) {
      console.warn('class not in _data/classes.json, adding it for this build:', code);
      c = { code: String(code).trim(), name: '', archived: false, slug };
      classes.push(c);
    }
    return c;
  }

  for (const f of files) {
    const raw = fs.readFileSync(path.join(POSTS_SRC, f), 'utf8');
    const parsed = matter(raw);
    const data = parsed.data || {};
    if (data.draft) {
      console.log('skip draft:', f);
      continue;
    }
    const slug = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const cat = (data.category || 'essay').toLowerCase();
    let cls = null;
    if (CLASS_CATEGORIES.has(cat)) {
      if (!data.course) console.warn('academic post has no class, filing under "' + FALLBACK_CLASS + '":', f);
      cls = classFor(data.course || FALLBACK_CLASS);
    }
    posts.push({
      slug,
      title: data.title || 'Untitled',
      date: data.date,
      dateFormatted: data.date ? fmtLong(data.date) : '',
      shortDate: data.date ? fmtShort(data.date) : '',
      category: cat,
      categoryLabel: cls ? cls.code : (CATEGORY_LABELS[cat] || cat),
      summary: data.summary || '',
      readMinutes: data.readMinutes || 4,
      backHref: cls ? '../classes/' + cls.slug + '.html' : '../blog.html',
      backLabel: cls ? 'All ' + cls.code + ' posts' : 'All posts',
      urlPath: 'posts/' + slug,
      body: renderMarkdown(parsed.content),
      cls
    });
  }

  const recipes = loadRecipes();

  for (const post of posts.concat(recipes)) {
    // Substitute {{key}} placeholders in template. Everything but the
    // rendered markdown body is escaped so quotes can't break attributes.
    let out = tpl;
    for (const [k, v] of Object.entries(post)) {
      if (k === 'cls' || k === 'recipe') continue;
      out = out.split('{{' + k + '}}').join(k === 'body' ? String(v) : escapeHtml(v));
    }
    fs.writeFileSync(path.join(ROOT, post.urlPath + '.html'), out);
    console.log('built:', post.urlPath + '.html');
  }
  removeStale(RECIPES_OUT, new Set(recipes.map(r => r.slug + '.html')));

  // Newest first
  posts.sort((a, b) => asDate(b.date).getTime() - asDate(a.date).getTime());
  const personal = posts.filter(p => !p.cls);
  for (const c of classes) c.posts = posts.filter(p => p.cls === c);
  const activeClasses = classes.filter(c => !c.archived);

  // Main blog = personal posts only; class posts live on their class pages.
  const blogList = personal.length
    ? personal.map(p => postCard(p, '')).join('\n\n')
    : '        <div class="post-empty reveal">\n' +
      '          <p>No personal posts yet &mdash; they&#39;re on the way.</p>\n' +
      (classes.length
        ? '          <p>In the meantime, my class notes are up: ' +
          (activeClasses.length ? activeClasses : classes).map(c =>
            '<a href="classes/' + c.slug + '.html">' + escapeHtml(c.code) + '</a>').join(', ') + '.</p>\n'
        : '') +
      '        </div>';
  injectBetween(path.join(ROOT, 'blog.html'), '<!-- POSTS_START -->', '<!-- POSTS_END -->', blogList);

  // Homepage "Recent posts": newest 3 personal posts. Until there are any,
  // point at the class blogs (current ones first) instead of leaving the
  // section empty.
  const fallbackClasses = activeClasses.length ? activeClasses : classes;
  const recent = personal.length
    ? personal.slice(0, 3).map(p =>
        '        <a href="posts/' + p.slug + '.html" class="feature-row">\n' +
        '          <span class="meta">' + p.shortDate + ' · ' + p.categoryLabel + '</span>\n' +
        '          <h3>' + escapeHtml(p.title) + '</h3>\n' +
        '          <span class="arrow">↗</span>\n' +
        '        </a>').join('\n\n')
    : fallbackClasses.length
      ? fallbackClasses.slice(0, 3).map(c =>
          '        <a href="classes/' + c.slug + '.html" class="feature-row">\n' +
          '          <span class="meta">Class blog · ' + c.posts.length + ' post' + (c.posts.length === 1 ? '' : 's') + '</span>\n' +
          '          <h3>' + escapeHtml(classTitle(c)) + '</h3>\n' +
          '          <span class="arrow">↗</span>\n' +
          '        </a>').join('\n\n')
      : '        <p>New posts are on the way.</p>';
  injectBetween(path.join(ROOT, 'index.html'), '<!-- RECENT_POSTS_START -->', '<!-- RECENT_POSTS_END -->', recent);

  recipes.sort((a, b) => asDate(b.date).getTime() - asDate(a.date).getTime());
  const recipeList = recipes.length
    ? recipes.map(recipeTile).join('\n\n')
    : '        <div class="post-empty reveal"><p>No family recipes shared yet &mdash; check back soon.</p></div>';
  injectBetween(path.join(ROOT, 'recipes.html'), '<!-- RECIPES_START -->', '<!-- RECIPES_END -->', recipeList);

  buildClassPages(classes);

  // Homepage stat counters. "My projects" counts the project cards on
  // projects.html so the two pages can't drift apart.
  const projectsHtml = fs.readFileSync(path.join(ROOT, 'projects.html'), 'utf8');
  setStat(path.join(ROOT, 'index.html'), {
    projects_shipped: (projectsHtml.match(/<article class="proj[ "]/g) || []).length,
    blog_posts: posts.length + recipes.length,
    classes_documented: posts.filter(p => p.cls).length
  });

  injectBlogMenuEverywhere(classes, recipes.length);
  injectOgImageEverywhere();
  generateSitemap(posts, classes, recipes);

  console.log('\nBuilt ' + posts.length + ' post(s), ' + recipes.length + ' recipe(s) and ' + classes.length + ' class page(s).');
}

function classTitle(c) {
  return c.name ? c.code + ': ' + c.name : c.code;
}

// One entry in a post list (blog.html and the class pages). `prefix` is the
// path back to the site root from the page the list sits on.
function postCard(p, prefix) {
  return '        <a href="' + prefix + 'posts/' + p.slug + '.html" class="post-card reveal">\n' +
    '          <div class="post-meta"><span>' + p.dateFormatted + '</span><span>' + p.readMinutes + ' min read</span></div>\n' +
    '          <h3>' + escapeHtml(p.title) + '</h3>\n' +
    '          <p>' + escapeHtml(p.summary) + '</p>\n' +
    '        </a>';
}

// Writes classes/<slug>.html for every class (archived ones too, so old
// links keep working) and removes pages for classes that no longer exist.
function buildClassPages(classes) {
  const tpl = fs.readFileSync(CLASS_TEMPLATE, 'utf8');
  const keep = new Set();
  for (const c of classes) {
    const n = c.posts.length;
    const values = {
      slug: c.slug,
      code: c.code,
      title: classTitle(c),
      heading: c.name || c.code,
      description: (c.archived ? 'Notes from ' : 'Weekly notes from ') + classTitle(c) + ' by Logan Randall.',
      lede: (c.archived ? 'Notes and reflections from my ' : 'Weekly notes and reflections from my ') + c.code + ' class.',
      status: c.archived ? 'Past class' : 'Current class',
      count: n + ' post' + (n === 1 ? '' : 's')
    };
    let out = tpl;
    for (const [k, v] of Object.entries(values)) out = out.split('{{' + k + '}}').join(escapeHtml(v));
    const list = n
      ? c.posts.map(p => postCard(p, '../')).join('\n\n')
      : '        <div class="post-empty reveal"><p>No posts for this class yet.</p></div>';
    out = out.split('{{posts}}').join(list);
    fs.writeFileSync(path.join(CLASSES_OUT, c.slug + '.html'), out);
    keep.add(c.slug + '.html');
    console.log('built class page:', c.slug + '.html');
  }
  removeStale(CLASSES_OUT, keep);
}

// Deletes generated pages in dir that are no longer in keep (a Set of file names).
function removeStale(dir, keep) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.html') && !keep.has(f)) {
      fs.unlinkSync(path.join(dir, f));
      console.log('removed old page:', path.basename(dir) + '/' + f);
    }
  }
}

// Fills the Blog dropdown in every page's nav, between
// <!-- BLOG_MENU_START --> and <!-- BLOG_MENU_END -->: the main blog, the
// current classes, then finished ("Past") classes.
function injectBlogMenuEverywhere(classes, recipeCount) {
  const menu = prefix => {
    const link = c => '          <a href="' + prefix + 'classes/' + c.slug + '.html">' + escapeHtml(c.code) +
      (c.name ? '<small>' + escapeHtml(c.name) + '</small>' : '') + '</a>';
    const active = classes.filter(c => !c.archived);
    const past = classes.filter(c => c.archived);
    return ['          <a href="' + prefix + 'blog.html" class="nav-dd-main">Personal blog<small>Life, work &amp; everything else</small></a>']
      .concat(recipeCount ? ['          <a href="' + prefix + 'recipes.html">Family recipes<small>From the Randall kitchen</small></a>'] : [])
      .concat(active.length ? ['          <span class="nav-dd-label">Classes</span>'].concat(active.map(link)) : [])
      .concat(past.length ? ['          <span class="nav-dd-label">Past classes</span>'].concat(past.map(link)) : [])
      .join('\n');
  };
  // 404.html can be served at any depth, so it uses root-absolute links.
  const targets = ROOT_PAGES.map(f => [f, '']).concat([['404.html', '/']]);
  for (const dir of ['posts', 'classes', 'recipes']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    fs.readdirSync(abs).filter(f => f.endsWith('.html')).forEach(f => targets.push([dir + '/' + f, '../']));
  }
  for (const [rel, prefix] of targets) {
    injectBetween(path.join(ROOT, rel), '<!-- BLOG_MENU_START -->', '<!-- BLOG_MENU_END -->', menu(prefix), '          ');
  }
}

// Generates sitemap.xml at the project root. Lists all static pages plus
// every published blog post, using the clean URLs Vercel serves (cleanUrls
// in vercel.json redirects *.html). Lastmod for posts comes from frontmatter
// date (when the post was published); for static pages, today's date.
// Rewrites the value of each <div ... data-stat="key" data-count="N">N</div>
// in the given file.
function setStat(file, values) {
  let html = fs.readFileSync(file, 'utf8');
  for (const [key, val] of Object.entries(values)) {
    const re = new RegExp('(data-stat="' + key + '" data-count=")[^"]*(">)[^<]*');
    if (!re.test(html)) { console.warn('stat not found in ' + path.basename(file) + ':', key); continue; }
    html = html.replace(re, '$1' + val + '$2' + val);
  }
  fs.writeFileSync(file, html);
  console.log('stats:', JSON.stringify(values));
}

function generateSitemap(posts, classes, recipes) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { url: SITE_URL + '/',              lastmod: today, priority: '1.0' },
    { url: SITE_URL + '/about',    lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/blog',     lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/recipes',  lastmod: today, priority: '0.6' },
    { url: SITE_URL + '/projects', lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/resume',   lastmod: today, priority: '0.6' }
  ];
  for (const c of classes) {
    entries.push({ url: SITE_URL + '/classes/' + c.slug, lastmod: today, priority: c.archived ? '0.5' : '0.7' });
  }
  for (const p of posts.concat(recipes)) {
    entries.push({
      url: SITE_URL + '/' + p.urlPath,
      lastmod: p.date ? asDate(p.date).toISOString().slice(0, 10) : today,
      priority: '0.7'
    });
  }
  const body = entries.map(e =>
    '  <url>\n' +
    '    <loc>' + e.url + '</loc>\n' +
    '    <lastmod>' + e.lastmod + '</lastmod>\n' +
    '    <priority>' + e.priority + '</priority>\n' +
    '  </url>'
  ).join('\n');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body + '\n' +
    '</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml);
  console.log('sitemap.xml written with ' + entries.length + ' urls');
}

// Writes <meta og:image> / <meta twitter:image> tags into every HTML <head>
// that has the marker pair <!-- OG_IMAGE_START --> ... <!-- OG_IMAGE_END -->.
// Crawlers can't run JS, so these have to be baked in at build time.
function injectOgImageEverywhere() {
  const absUrl = SITE_URL + OG_IMAGE;

  const ogBlock =
    '  <meta property="og:image" content="' + absUrl + '" />\n' +
    '  <meta property="og:image:width" content="1200" />\n' +
    '  <meta property="og:image:height" content="630" />\n' +
    '  <meta property="og:image:alt" content="Logan Randall" />\n' +
    '  <meta name="twitter:card" content="summary_large_image" />\n' +
    '  <meta name="twitter:image" content="' + absUrl + '" />';

  const targets = ROOT_PAGES.map(f => path.join(ROOT, f));
  // Also inject into all generated post and class pages.
  for (const dir of [POSTS_OUT, CLASSES_OUT, RECIPES_OUT]) {
    if (!fs.existsSync(dir)) continue;
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.html'))
      .forEach(f => targets.push(path.join(dir, f)));
  }

  let n = 0;
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    let html = fs.readFileSync(file, 'utf8');
    const sIdx = html.indexOf('<!-- OG_IMAGE_START -->');
    const eIdx = html.indexOf('<!-- OG_IMAGE_END -->');
    if (sIdx === -1 || eIdx === -1) continue;
    const before = html.slice(0, sIdx + '<!-- OG_IMAGE_START -->'.length);
    const after = html.slice(eIdx);
    fs.writeFileSync(file, before + '\n' + ogBlock + '\n  ' + after);
    n++;
  }
  console.log('OG image injected into ' + n + ' file(s): ' + absUrl);
}

// ---------- Family recipes ----------

// Reads _recipes/*.md (written by the family hub's "Share on the website")
// into post-like objects that render through the post template.
function loadRecipes() {
  if (!fs.existsSync(RECIPES_SRC)) return [];
  return fs.readdirSync(RECIPES_SRC).filter(f => f.endsWith('.md')).map(f => {
    const parsed = matter(fs.readFileSync(path.join(RECIPES_SRC, f), 'utf8'));
    const data = parsed.data || {};
    const r = data.recipe || {};
    const slug = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const title = data.title || 'Untitled recipe';
    return {
      slug,
      title,
      date: data.date,
      dateFormatted: data.date ? fmtLong(data.date) : '',
      shortDate: data.date ? fmtShort(data.date) : '',
      category: 'recipe',
      categoryLabel: CATEGORY_LABELS.recipe,
      summary: data.summary || '',
      readMinutes: data.readMinutes || 3,
      backHref: '../recipes.html',
      backLabel: 'All recipes',
      urlPath: 'recipes/' + slug,
      body: recipeBody(title, data, r, renderMarkdown(parsed.content)),
      recipe: r
    };
  });
}

function minutesLabel(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return (h ? h + ' hr' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
}
function isoDuration(n) {
  return 'PT' + (Math.floor(n / 60) ? Math.floor(n / 60) + 'H' : '') + (n % 60 ? (n % 60) + 'M' : '');
}

function recipeFacts(r) {
  const facts = [];
  if (r.servings) facts.push('<span class="recipe-fact" data-yield="' + escapeHtml(r.yieldUnit || 'servings') + '">' + escapeHtml(RecipeScale.formatNum(r.servings) + ' ' + (r.yieldUnit || 'servings')) + '</span>');
  if (r.prepMinutes) facts.push('<span class="recipe-fact">Prep ' + minutesLabel(r.prepMinutes) + '</span>');
  if (r.cookMinutes) facts.push('<span class="recipe-fact">Cook ' + minutesLabel(r.cookMinutes) + '</span>');
  if (r.prepMinutes && r.cookMinutes) facts.push('<span class="recipe-fact">Total ' + minutesLabel(r.prepMinutes + r.cookMinutes) + '</span>');
  return facts;
}

// The article body for a shared recipe: cover, the story, then a recipe
// card with a servings scaler (wired up by main.js + js/recipe-scale.js).
function recipeBody(title, data, r, storyHtml) {
  const ingredients = (r.ingredients || []).map(i => {
    if (i.section != null) return '            <li class="ing-section">' + escapeHtml(i.section) + '</li>';
    const q = RecipeScale.parseQty(i.qty);
    const amount = [q ? RecipeScale.formatQty(q) : (i.qty || ''), i.unit || ''].filter(Boolean).join(' ');
    return '            <li>' +
      (amount ? '<span class="ing-amt"' + (q ? ' data-qty="' + escapeHtml(i.qty) + '" data-unit="' + escapeHtml(i.unit || '') + '"' : '') + '>' + escapeHtml(amount) + '</span> ' : '') +
      escapeHtml(i.item || '') + (i.note ? '<span class="ing-note">, ' + escapeHtml(i.note) + '</span>' : '') + '</li>';
  }).join('\n');
  const steps = (r.steps || []).map(s => '            <li>' + escapeHtml(s).replace(/\n/g, '<br>') + '</li>').join('\n');
  const facts = recipeFacts(r);
  // The scaler only appears once main.js has loaded (it's hidden until then).
  const scaler = r.servings
    ? '        <div class="recipe-scale" data-servings="' + r.servings + '" hidden>\n' +
      '          <span class="recipe-scale-label">Scale</span>\n' +
      [0.5, 1, 2, 3].map(f => '          <button type="button" class="recipe-scale-btn' + (f === 1 ? ' on' : '') + '" data-factor="' + f + '">' + (f === 0.5 ? '½' : f) + '×</button>').join('\n') + '\n' +
      '        </div>'
    : '';

  // schema.org Recipe data, so search engines can show it as a recipe.
  const abs = u => (/^https?:/.test(u) ? u : SITE_URL + u);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: title,
    description: data.summary || undefined,
    image: r.cover ? [abs(r.cover)] : undefined,
    datePublished: data.date ? asDate(data.date).toISOString().slice(0, 10) : undefined,
    author: { '@type': 'Person', name: r.source || 'The Randall family' },
    prepTime: r.prepMinutes ? isoDuration(r.prepMinutes) : undefined,
    cookTime: r.cookMinutes ? isoDuration(r.cookMinutes) : undefined,
    totalTime: r.prepMinutes || r.cookMinutes ? isoDuration((r.prepMinutes || 0) + (r.cookMinutes || 0)) : undefined,
    recipeYield: r.servings ? r.servings + ' ' + (r.yieldUnit || 'servings') : undefined,
    recipeCategory: (r.tags || [])[0],
    keywords: (r.tags || []).join(', ') || undefined,
    recipeIngredient: (r.ingredients || []).filter(i => i.section == null).map(i => [i.qty, i.unit, i.item].filter(Boolean).join(' ') + (i.note ? ', ' + i.note : '')),
    recipeInstructions: (r.steps || []).map(text => ({ '@type': 'HowToStep', text }))
  };

  return [
    r.cover ? '<figure class="recipe-cover"><img src="' + escapeHtml(r.cover) + '" alt="' + escapeHtml(title) + '" /></figure>' : '',
    facts.length || storyHtml.trim()
      ? '<div class="recipe-intro">' + (facts.length ? '<div class="recipe-facts">' + facts.join('') + '</div>' : '') +
        (storyHtml.trim() ? '<a href="#recipe" class="recipe-jump">Jump to recipe ↓</a>' : '') + '</div>'
      : '',
    r.source ? '<p class="recipe-source">From ' + escapeHtml(r.source) + '</p>' : '',
    storyHtml,
    '<section class="recipe-card" id="recipe">',
    '        <div class="recipe-card-head">',
    '          <h2>' + escapeHtml(title) + '</h2>',
    '          <button type="button" class="recipe-print" data-print-recipe>Print recipe</button>',
    '        </div>',
    facts.length ? '        <div class="recipe-facts">' + facts.join('') + '</div>' : '',
    scaler,
    '        <div class="recipe-cols">',
    '          <div>',
    '            <h3>Ingredients</h3>',
    '            <ul class="recipe-ingredients">',
    ingredients,
    '            </ul>',
    '          </div>',
    '          <div>',
    '            <h3>Steps</h3>',
    '            <ol class="recipe-steps">',
    steps,
    '            </ol>',
    '          </div>',
    '        </div>',
    r.notes ? '        <div class="recipe-notes"><h3>Notes &amp; tips</h3>' + renderMarkdown(r.notes) + '</div>' : '',
    '      </section>',
    '      <script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>',
    '      <script src="../js/recipe-scale.js" defer></script>'
  ].filter(Boolean).join('\n');
}

// One card on recipes.html.
function recipeTile(p) {
  const r = p.recipe;
  const meta = [];
  if (r.prepMinutes || r.cookMinutes) meta.push(minutesLabel((r.prepMinutes || 0) + (r.cookMinutes || 0)));
  if (r.servings) meta.push(RecipeScale.formatNum(r.servings) + ' ' + (r.yieldUnit || 'servings'));
  return '        <a href="recipes/' + p.slug + '.html" class="recipe-tile reveal">\n' +
    '          <div class="recipe-tile-img">' + (r.cover
      ? '<img src="' + escapeHtml(r.cover) + '" alt="" loading="lazy" decoding="async" />'
      : '<span>' + escapeHtml(p.title.trim().charAt(0).toUpperCase()) + '</span>') + '</div>\n' +
    '          <div class="recipe-tile-body">\n' +
    ((r.tags || []).length ? '            <span class="card-tag">' + escapeHtml(r.tags[0]) + '</span>\n' : '') +
    '            <h3>' + escapeHtml(p.title) + '</h3>\n' +
    (p.summary ? '            <p>' + escapeHtml(p.summary) + '</p>\n' : '') +
    (meta.length ? '            <div class="card-meta">' + meta.map(m => '<span>' + escapeHtml(m) + '</span>').join('') + '</div>\n' : '') +
    '          </div>\n' +
    '        </a>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

build();
