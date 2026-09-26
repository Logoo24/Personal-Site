// Zero-dependency static server for local preview. Mirrors vercel.json's
// cleanUrls (/about -> about.html) and serves 404.html for missing routes.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8123;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain', '.yml': 'text/yaml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

function resolve(urlPath) {
  const p = path.join(ROOT, decodeURIComponent(urlPath));
  if (!p.startsWith(ROOT)) return null;
  const candidates = [p, p + '.html', path.join(p, 'index.html')];
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

http.createServer((req, res) => {
  const file = resolve(req.url.split('?')[0]);
  const target = file || path.join(ROOT, '404.html');
  res.writeHead(file ? 200 : 404, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, () => console.log(`Serving ${ROOT} at http://localhost:${PORT}`));
