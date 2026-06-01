/* ============================================================
   build.js - reads markdown posts from _posts/ and generates
   posts/[slug].html, plus injects post lists into blog.html
   and index.html.
   Cloudflare Pages runs this on every push via `npm run build`.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const ROOT = __dirname;
const POSTS_SRC = path.join(ROOT, '_posts');
const POSTS_OUT = path.join(ROOT, 'posts');
const TEMPLATE = path.join(ROOT, '_src', 'post-template.html');

// Absolute URL of the production site. Used to build absolute URLs for
// Open Graph / Twitter share-card image meta tags (social crawlers don't
// run JS, so these have to be baked into the HTML at build time).
const SITE_URL = 'https://www.loganbrandall.com';

const CATEGORY_LABELS = {
  personal: 'Personal Blog',
  academic: 'Academic Blog',
  // Legacy values kept as fallbacks so older posts still render a sensible
  // label if they haven't been migrated. New posts should use personal/academic.
  essay: 'Personal Blog',
  class: 'Academic Blog',
  research: 'Academic Blog',
  project: 'Personal Blog'
};

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

function injectBetween(file, startMarker, endMarker, content) {
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
  fs.writeFileSync(file, before + '\n' + content + '\n        ' + after);
  console.log('injected into:', path.basename(file));
}

function build() {
  if (!fs.existsSync(POSTS_SRC)) {
    console.log('No _posts/ directory; nothing to build.');
    return;
  }
  if (!fs.existsSync(POSTS_OUT)) fs.mkdirSync(POSTS_OUT, { recursive: true });
  if (!fs.existsSync(TEMPLATE)) {
    console.error('Missing template: _src/post-template.html');
    process.exit(1);
  }
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const files = fs.readdirSync(POSTS_SRC).filter(f => f.endsWith('.md'));
  const posts = [];

  for (const f of files) {
    const raw = fs.readFileSync(path.join(POSTS_SRC, f), 'utf8');
    const parsed = matter(raw);
    const data = parsed.data || {};
    if (data.draft) {
      console.log('skip draft:', f);
      continue;
    }
    const slug = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const bodyHtml = marked.parse(parsed.content || '');
    const cat = (data.category || 'essay').toLowerCase();
    const post = {
      slug,
      title: data.title || 'Untitled',
      date: data.date,
      dateFormatted: data.date ? fmtLong(data.date) : '',
      shortDate: data.date ? fmtShort(data.date) : '',
      category: cat,
      categoryLabel: CATEGORY_LABELS[cat] || cat,
      summary: data.summary || '',
      readMinutes: data.readMinutes || 4,
      body: bodyHtml
    };
    posts.push(post);

    // Substitute {{key}} placeholders in template
    let out = tpl;
    for (const [k, v] of Object.entries(post)) {
      out = out.split('{{' + k + '}}').join(String(v));
    }
    fs.writeFileSync(path.join(POSTS_OUT, slug + '.html'), out);
    console.log('built:', slug + '.html');
  }

  // Newest first
  posts.sort((a, b) => asDate(b.date).getTime() - asDate(a.date).getTime());

  // Inject full post list into blog.html
  const blogList = posts.map(p =>
    '        <a href="posts/' + p.slug + '.html" class="post-card reveal" data-category="' + p.category + '">\n' +
    '          <div class="post-meta"><span>' + p.dateFormatted + '</span><span>' + p.categoryLabel + '</span><span>' + p.readMinutes + ' min read</span></div>\n' +
    '          <h3>' + escapeHtml(p.title) + '</h3>\n' +
    '          <p>' + escapeHtml(p.summary) + '</p>\n' +
    '        </a>'
  ).join('\n\n');
  injectBetween(path.join(ROOT, 'blog.html'), '<!-- POSTS_START -->', '<!-- POSTS_END -->', blogList);

  // Inject top-3 onto homepage
  const recent = posts.slice(0, 3).map(p =>
    '        <a href="posts/' + p.slug + '.html" class="feature-row">\n' +
    '          <span class="meta">' + p.shortDate + ' · ' + p.categoryLabel + '</span>\n' +
    '          <h3>' + escapeHtml(p.title) + '</h3>\n' +
    '          <span class="arrow">↗</span>\n' +
    '        </a>'
  ).join('\n\n');
  injectBetween(path.join(ROOT, 'index.html'), '<!-- RECENT_POSTS_START -->', '<!-- RECENT_POSTS_END -->', recent);

  // Update auto-computed fields in data/stats.json. Manual fields
  // (projects_shipped, online_since) are preserved; the two count fields are
  // overwritten on every build so the homepage stats stay accurate.
  const statsFile = path.join(ROOT, 'data', 'stats.json');
  let stats = {};
  if (fs.existsSync(statsFile)) {
    try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); }
    catch (e) { console.warn('stats.json unreadable, recreating:', e.message); stats = {}; }
  }
  stats.blog_posts = posts.length;
  // "Classes documented" on the homepage counts academic-category posts.
  // 'class' is preserved as a legacy fallback for any un-migrated posts.
  stats.classes_documented = posts.filter(p => p.category === 'academic' || p.category === 'class').length;
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2) + '\n');
  console.log('updated stats.json: ' + stats.blog_posts + ' posts, ' + stats.classes_documented + ' academic');

  injectOgImageEverywhere();
  generateSitemap(posts);

  console.log('\nBuilt ' + posts.length + ' post(s).');
}

// Generates sitemap.xml at the project root. Lists all static pages plus
// every published blog post. Lastmod for posts comes from frontmatter date
// (when the post was published); for static pages, today's date.
function generateSitemap(posts) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { url: SITE_URL + '/',              lastmod: today, priority: '1.0' },
    { url: SITE_URL + '/about.html',    lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/blog.html',     lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/projects.html', lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/resume.html',   lastmod: today, priority: '0.6' }
  ];
  for (const p of posts) {
    entries.push({
      url: SITE_URL + '/posts/' + p.slug + '.html',
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

// Reads data/images.json for the hero cutout and writes <meta og:image> /
// <meta twitter:image> tags into every HTML <head> that has the marker pair
// <!-- OG_IMAGE_START --> ... <!-- OG_IMAGE_END -->. Crawlers can't run JS,
// so these have to be baked in at build time. The URL is absolute (SITE_URL
// + image path) and URL-encoded so paths with spaces work.
function injectOgImageEverywhere() {
  const imagesFile = path.join(ROOT, 'data', 'images.json');
  if (!fs.existsSync(imagesFile)) {
    console.warn('skip OG image inject: data/images.json not found');
    return;
  }
  let images = {};
  try { images = JSON.parse(fs.readFileSync(imagesFile, 'utf8')); }
  catch (e) { console.warn('skip OG image inject: images.json unreadable:', e.message); return; }

  const rawPath = images.og_image || images.hero_cutout;
  if (!rawPath) {
    console.warn('skip OG image inject: no hero_cutout or og_image in images.json');
    return;
  }
  // Encode path segments (preserves /) so filenames with spaces work in OG URL.
  const encodedPath = rawPath.split('/').map(encodeURIComponent).join('/');
  // Strip duplicate leading slash if SITE_URL already ends with one (it doesn't, but be defensive).
  const absUrl = SITE_URL.replace(/\/$/, '') + (encodedPath.startsWith('/') ? '' : '/') + encodedPath;

  const ogBlock =
    '  <meta property="og:image" content="' + absUrl + '" />\n' +
    '  <meta property="og:image:alt" content="Logan Randall" />\n' +
    '  <meta name="twitter:card" content="summary_large_image" />\n' +
    '  <meta name="twitter:image" content="' + absUrl + '" />';

  const targets = [
    'index.html', 'about.html', 'blog.html', 'projects.html', 'resume.html'
  ].map(f => path.join(ROOT, f));
  // Also inject into all generated post pages.
  if (fs.existsSync(POSTS_OUT)) {
    fs.readdirSync(POSTS_OUT)
      .filter(f => f.endsWith('.html'))
      .forEach(f => targets.push(path.join(POSTS_OUT, f)));
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

build();
