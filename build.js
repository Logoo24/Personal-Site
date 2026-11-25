/* ============================================================
   build.js - reads markdown posts from _posts/ and generates
   posts/[slug].html and one page per class in classes/[slug].html,
   and injects post lists into blog.html and index.html and the Blog
   dropdown menu into every page's nav. (Recipes the family makes public
   aren't built here: api/recipe.js serves them live at /recipes/<slug>.)
   Vercel runs this on every push via `npm run build`.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const ROOT = __dirname;
const POSTS_SRC = path.join(ROOT, '_posts');
const POSTS_OUT = path.join(ROOT, 'posts');
const TEMPLATE = path.join(ROOT, '_src', 'post-template.html');
const CLASS_TEMPLATE = path.join(ROOT, '_src', 'class-template.html');
const CLASSES_OUT = path.join(ROOT, 'classes');
// The class list (edited from /admin/ -> Classes). Each entry is
// { code: "MKT 353", name: "Web Business Creation", archived: false }.
const CLASSES_FILE = path.join(ROOT, '_data', 'classes.json');
// The CMS config; its "Post to" choices are written from the class list.
const CMS_CONFIG = path.join(ROOT, 'family', 'manage', 'config.yml');

// Top-level pages that carry the site nav (and so the Blog dropdown).
const ROOT_PAGES = ['index.html', 'about.html', 'blog.html', 'projects.html', 'resume.html', 'privacy.html'];

// Absolute URL of the production site. Used to build absolute URLs for
// Open Graph / Twitter share-card image meta tags (social crawlers don't
// run JS, so these have to be baked into the HTML at build time).
const SITE_URL = 'https://www.loganbrandall.com';

// Social-share card (1200x630). Must be a PNG/JPG - most crawlers ignore SVG.
const OG_IMAGE = '/images/og-card.jpg';

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
  for (const dir of [POSTS_OUT, CLASSES_OUT]) {
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
  let posts = [];
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
    // Where the post goes. The CMS writes one "Post to" choice,
    //   postTo: { type: personal }  or  postTo: { type: <class slug>, section: <id> },
    // where section (only for classes whose page has sections) picks the
    // spot on the class page. Older posts say category (+ course) instead.
    const to = data.postTo && typeof data.postTo === 'object' && data.postTo.type ? data.postTo : null;
    let cat;
    let cls = null;
    if (to) {
      cat = String(to.type) === 'personal' ? 'personal' : 'academic';
      if (cat === 'academic') cls = classFor(String(to.type));
    } else {
      cat = (data.category || 'essay').toLowerCase();
      if (CLASS_CATEGORIES.has(cat)) {
        if (!data.course) console.warn('academic post has no class, filing under "' + FALLBACK_CLASS + '":', f);
        cls = classFor(data.course || FALLBACK_CLASS);
      }
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
      // inProgress: true builds the page at its link but leaves it out of
      // the post lists, the homepage counts and the sitemap (a placeholder
      // page that something links to by hand, like HUM 202's portfolio hub).
      inProgress: !!data.inProgress,
      section: cls && to && to.section ? String(to.section) : '',
      cls
    });
  }

  for (const post of posts) {
    // Substitute {{key}} placeholders in template. Everything but the
    // rendered markdown body is escaped so quotes can't break attributes.
    let out = tpl;
    for (const [k, v] of Object.entries(post)) {
      if (k === 'cls' || k === 'inProgress' || k === 'section') continue;
      out = out.split('{{' + k + '}}').join(k === 'body' ? String(v) : escapeHtml(v));
    }
    fs.writeFileSync(path.join(ROOT, post.urlPath + '.html'), out);
    console.log('built:', post.urlPath + '.html');
  }

  // Newest first. Everything below lists and counts finished posts only;
  // in-progress pages are built above but stay out of lists and stats.
  posts.sort((a, b) => asDate(b.date).getTime() - asDate(a.date).getTime());
  const built = posts;
  posts = posts.filter(p => !p.inProgress);
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

  buildClassPages(classes, built);
  writeCmsPostTo(classes);

  // Homepage stat counters. "My projects" counts the project cards on
  // projects.html so the two pages can't drift apart.
  const projectsHtml = fs.readFileSync(path.join(ROOT, 'projects.html'), 'utf8');
  setStat(path.join(ROOT, 'index.html'), {
    projects_shipped: (projectsHtml.match(/<article class="proj[ "]/g) || []).length,
    blog_posts: posts.length,
    classes_documented: posts.filter(p => p.cls).length
  });

  injectBlogMenuEverywhere(classes);
  injectOgImageEverywhere();
  generateSitemap(posts, classes);

  console.log('\nBuilt ' + posts.length + ' post(s) and ' + classes.length + ' class page(s).');
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

// A class's own page layout, _src/class-<slug>.html, or null.
function ownLayoutPath(c) {
  const p = path.join(ROOT, '_src', 'class-' + c.slug + '.html');
  return fs.existsSync(p) ? p : null;
}

// The {{#unplaced …}}…{{/unplaced}} blocks in a class layout (see
// buildClassPages). Each can name its section and give it a label for the
// CMS, and one can be the default:
//   {{#unplaced section="essays" label="Part 3 · Essays" default}}
const UNPLACED_RE = /[ \t]*\{\{#unplaced\b([^}]*)\}\}[ \t]*\r?\n([\s\S]*?)[ \t]*\{\{\/unplaced\}\}[ \t]*(\r?\n)?/g;
function unplacedBlocks(layout) {
  return [...layout.matchAll(UNPLACED_RE)].map(m => {
    const attr = name => (new RegExp('\\b' + name + '="([^"]*)"').exec(m[1]) || [])[1] || '';
    return { section: attr('section'), label: attr('label'), isDefault: /\bdefault\b/.test(m[1].replace(/"[^"]*"/g, '')) };
  });
}

// The CMS's "Post to" choices: family/manage/config.yml's postTo types,
// between the POST_TO_TYPES markers. The personal blog, then every class
// (current ones first). A class whose layout has sections (the section=
// on its {{#unplaced}} blocks) gets a Section choice, so the CMS asks for
// one only when that class is picked. Vercel builds before it deploys, so
// a class added from the CMS shows up there once the next deploy is live.
function writeCmsPostTo(classes) {
  const q = JSON.stringify; // a JSON string is a valid YAML string
  const pad = '          ';
  const lines = [pad + '- { name: "personal", label: "Personal blog" }'];
  for (const c of classes.filter(x => !x.archived).concat(classes.filter(x => x.archived))) {
    const label = c.code + (c.name ? ' · ' + c.name : '') + (c.archived ? ' (past class)' : '');
    const own = ownLayoutPath(c);
    const sections = own ? unplacedBlocks(fs.readFileSync(own, 'utf8')).filter(b => b.section) : [];
    if (!sections.length) {
      lines.push(pad + '- { name: ' + q(c.slug) + ', label: ' + q(label) + ' }');
      continue;
    }
    const def = (sections.find(b => b.isDefault) || sections[sections.length - 1]).section;
    lines.push(
      pad + '- name: ' + q(c.slug),
      pad + '  label: ' + q(label),
      pad + '  fields:',
      pad + '    - label: "Section on the class page"',
      pad + '      name: "section"',
      pad + '      widget: "select"',
      pad + '      default: ' + q(def),
      pad + '      hint: ' + q('Where its card goes on the ' + c.code + ' page. A post that already has a card of its own there stays where that card is.'),
      pad + '      options:');
    for (const b of sections) lines.push(pad + '        - { label: ' + q(b.label || b.section) + ', value: ' + q(b.section) + ' }');
  }
  injectBetween(CMS_CONFIG, '# POST_TO_TYPES_START', '# POST_TO_TYPES_END', lines.join('\n'), pad);
}

// Writes classes/<slug>.html for every class (archived ones too, so old
// links keep working) and removes pages for classes that no longer exist.
// `built` is every post page written this build, in-progress ones included.
function buildClassPages(classes, built) {
  const bySlug = new Map(built.map(p => [p.slug, p]));
  // A class layout can show any post's details with {{post:<slug>:<field>}}:
  // href, title, summary, readMinutes, or image / imageAlt (the post's
  // first picture). The HUM 202 hub's cards use these, so they follow the
  // posts instead of repeating them.
  const postField = (classSlug, slug, field) => {
    const p = bySlug.get(slug);
    if (!p) {
      console.warn('class-' + classSlug + '.html refers to a post that does not exist:', slug);
      return '';
    }
    if (field === 'href') return '../posts/' + p.slug + '.html';
    if (field === 'image' || field === 'imageAlt') {
      // Already escaped: taken straight from the rendered <img> tag.
      const m = /<img src="([^"]*)" alt="([^"]*)"/.exec(p.body);
      if (!m) console.warn('post has no image for class-' + classSlug + '.html:', slug);
      return m ? m[field === 'image' ? 1 : 2] : '';
    }
    if (['title', 'summary', 'readMinutes'].includes(field)) return escapeHtml(p[field]);
    console.warn('unknown post field in class-' + classSlug + '.html:', field);
    return '';
  };
  const tpl = fs.readFileSync(CLASS_TEMPLATE, 'utf8');
  const keep = new Set();
  for (const c of classes) {
    // A class can have a layout of its own, _src/class-<slug>.html, used
    // in place of class-template.html (HUM 202's portfolio hub). It takes
    // the same {{placeholders}}.
    const own = ownLayoutPath(c);
    const layout = own ? fs.readFileSync(own, 'utf8') : tpl;
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
    // {{#unplaced …}}…{{/unplaced}} blocks in a layout are filled with the
    // class's finished posts that no {{post:<slug>:…}} names, oldest first,
    // each repeating the block with {{post:*:<field>}} standing for that
    // post. That's how a new post lands on a hand-laid-out page (HUM 202)
    // without anyone adding a card. A post goes to the block whose section
    // matches the post's postTo.section (picked in the CMS), else to the
    // block marked default (else the last one). A post with no picture
    // loses the block's {{post:*:image}} <img>.
    const named = new Set([...layout.matchAll(/\{\{post:([a-z0-9-]+):/g)].map(m => m[1]));
    const unplaced = layout === tpl ? [] : c.posts.filter(p => !named.has(p.slug)).reverse();
    const blocks = unplacedBlocks(layout);
    const fallback = blocks.findIndex(b => b.isDefault) === -1 ? blocks.length - 1 : blocks.findIndex(b => b.isDefault);
    const home = unplaced.map(p => {
      const i = p.section ? blocks.findIndex(b => b.section === p.section) : -1;
      if (p.section && i === -1 && blocks.length) console.warn('no section "' + p.section + '" on ' + c.slug + '.html, using the default for:', p.slug);
      return i === -1 ? fallback : i;
    });
    let k = 0;
    let out = layout.replace(UNPLACED_RE, (all, attrs, block) => {
      const here = k++;
      return unplaced.filter((p, j) => home[j] === here).map(p => {
        let b = block;
        if (!/<img src="/.test(p.body)) b = b.replace(/[ \t]*<img\b[^>]*\{\{post:\*:image\}\}[^>]*>[ \t]*\r?\n?/g, '');
        return b.split('{{post:*:').join('{{post:' + p.slug + ':');
      }).join('');
    });
    if (unplaced.length) {
      if (blocks.length) {
        console.log('auto-placed on ' + c.slug + '.html: ' +
          unplaced.map((p, j) => p.slug + ' (' + (blocks[home[j]].section || 'block ' + (home[j] + 1)) + ')').join(', '));
      } else {
        console.warn('class-' + c.slug + '.html has no card (and no {{#unplaced}} block) for: ' + unplaced.map(p => p.slug).join(', '));
      }
    }
    out = out.replace(/\{\{post:([a-z0-9-]+):(\w+)\}\}/g, (all, slug, field) => postField(c.slug, slug, field));
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
function injectBlogMenuEverywhere(classes) {
  const menu = prefix => {
    const link = c => '          <a href="' + prefix + 'classes/' + c.slug + '.html">' + escapeHtml(c.code) +
      (c.name ? '<small>' + escapeHtml(c.name) + '</small>' : '') + '</a>';
    const active = classes.filter(c => !c.archived);
    const past = classes.filter(c => c.archived);
    return ['          <a href="' + prefix + 'blog.html" class="nav-dd-main">Personal blog<small>Life, work &amp; everything else</small></a>']
      .concat(active.length ? ['          <span class="nav-dd-label">Classes</span>'].concat(active.map(link)) : [])
      .concat(past.length ? ['          <span class="nav-dd-label">Past classes</span>'].concat(past.map(link)) : [])
      .join('\n');
  };
  // 404.html can be served at any depth, so it uses root-absolute links.
  const targets = ROOT_PAGES.map(f => [f, '']).concat([['404.html', '/']]);
  for (const dir of ['posts', 'classes']) {
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

function generateSitemap(posts, classes) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { url: SITE_URL + '/',              lastmod: today, priority: '1.0' },
    { url: SITE_URL + '/about',    lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/blog',     lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/projects', lastmod: today, priority: '0.8' },
    { url: SITE_URL + '/resume',   lastmod: today, priority: '0.6' },
    { url: SITE_URL + '/privacy',  lastmod: today, priority: '0.3' }
  ];
  for (const c of classes) {
    entries.push({ url: SITE_URL + '/classes/' + c.slug, lastmod: today, priority: c.archived ? '0.5' : '0.7' });
  }
  for (const p of posts) {
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
  for (const dir of [POSTS_OUT, CLASSES_OUT]) {
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

build();
