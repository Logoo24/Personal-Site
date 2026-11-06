// Local testing only: prints a family-hub session for any email, so pages
// that need a Google sign-in (Finance, the site manager) can be tried on
// the local preview server without Google. It signs with the
// FAMILY_SESSION_SECRET in .env.local, so the result works nowhere else.
//
//   node scripts/dev-session.mjs logan@example.com Logan
//
// Paste the printed line into the browser console on http://localhost:8123.
// Sign out of the hub first: a page can't replace the real (HttpOnly)
// session cookie.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

if (process.env.VERCEL) { console.error('This is for local testing only.'); process.exit(1); }
const [email, ...nameParts] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/dev-session.mjs <email> [name]');
  process.exit(1);
}
const secret = process.env.FAMILY_SESSION_SECRET;
if (!secret) { console.error('FAMILY_SESSION_SECRET is missing from .env.local.'); process.exit(1); }

const { createToken, COOKIE } = await import(pathToFileURL(path.join(ROOT, 'api/_family/session.js')).href);
const name = nameParts.join(' ') || email.split('@')[0];
const token = await createToken({ name, email: email.toLowerCase(), via: 'google' }, secret);
console.log(`document.cookie = "${COOKIE}=${encodeURIComponent(token)}; path=/; max-age=86400"; location.reload();`);
