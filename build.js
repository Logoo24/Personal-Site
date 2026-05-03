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

const CATEGORY_LABELS = {
  essay: 'Essay',
  class: 'Class notes',
  research: 'Research',
  project: 'Project'
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

  console.log('\nBuilt ' + posts.length + ' post(s).');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

build();
