// Zero-dependency static server for local preview. Mirrors vercel.json's
// cleanUrls (/about -> about.html), rewrites and redirects, and serves
// 404.html for missing routes. Also runs the family hub locally:
// middleware.js guards /family/*, and /api/<name> is handled by
// api/<name>.js when it exports a fetch handler (api/family.js, api/recipe.js). Env vars come
// from .env.local (gitignored), e.g. FAMILY_PASSWORD and FAMILY_SESSION_SECRET.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8123;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain', '.yml': 'text/yaml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
process.chdir(ROOT);

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

function resolve(urlPath) {
  const p = path.join(ROOT, decodeURIComponent(urlPath));
  if (!p.startsWith(ROOT)) return null;
  const candidates = [p, p + '.html', path.join(p, 'index.html')];
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

function toRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

// vercel.json "source" pattern ("/recipes/:slug") -> RegExp with one group per :param.
function pattern(source) {
  const names = [];
  const re = new RegExp('^' + source.replace(/:path\*/g, '(.*)').replace(/:(\w+)/g, (m, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { re, names };
}

// Applies the first matching vercel.json rewrite; returns the new URL or null.
function rewriteFor(pathname, search) {
  for (const r of vercel.rewrites || []) {
    const { re, names } = pattern(r.source);
    const m = re.exec(pathname);
    if (!m) continue;
    let dest = r.destination;
    names.forEach((n, i) => { dest = dest.split(':' + n).join(m[i + 1]); });
    return dest + (search ? (dest.includes('?') ? '&' : '?') + search.slice(1) : '');
  }
  return null;
}

function redirectFor(pathname) {
  for (const r of vercel.redirects || []) {
    const re = new RegExp('^' + r.source.replace(/:path\*/g, '.*').replace(/:(\w+)/g, '[^/]+') + '$');
    if (re.test(pathname)) return r.destination;
  }
  return null;
}

http.createServer(async (req, res) => {
  try {
    let pathname = req.url.split('?')[0];
    const to = redirectFor(pathname);
    if (to) { res.writeHead(307, { Location: to }); return res.end(); }
    const rewritten = !resolve(pathname) && rewriteFor(pathname, req.url.slice(pathname.length));
    if (rewritten) { req.url = rewritten; pathname = rewritten.split('?')[0]; }

    const api = /^\/api\/([\w-]+)$/.exec(pathname);
    const handler = api && fs.existsSync(path.join(ROOT, 'api', api[1] + '.js')) && (await load(`api/${api[1]}.js`)).default;
    if (handler && handler.fetch) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return send(res, await handler.fetch(toRequest(req, Buffer.concat(chunks))));
    }
    if (pathname === '/family' || pathname.startsWith('/family/')) {
      const mw = (await load('middleware.js')).default;
      const out = await mw(toRequest(req));
      if (out) return send(res, out);
    }

    const file = resolve(pathname);
    const target = file || path.join(ROOT, '404.html');
    res.writeHead(file ? 200 : 404, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(e && e.stack || e));
  }
}).listen(PORT, () => console.log(`Serving ${ROOT} at http://localhost:${PORT}`));
