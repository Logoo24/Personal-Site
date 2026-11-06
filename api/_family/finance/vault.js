// Finance data at rest: every file under finance/ in the Blob store is
// AES-256-GCM-encrypted with FINANCE_ENCRYPTION_KEY (32 random bytes,
// base64, set only in Vercel / .env.local). The file's path is bound in as
// additional authenticated data, so one file can't be swapped for another.
// The envelope is plain JSON, so store.js's reads, writes and ETag checks
// work on it unchanged.
//
// Lose the key and the data can't be read back: the Plaid connections would
// have to be linked again, which uses up new slots on Plaid's Trial plan.
// Keep a copy of the key in a password manager.

import crypto from 'node:crypto';
import { readJSON, writeJSON, remove } from '../store.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

let cached = null; // { src, bytes, kid }
function key() {
  const src = process.env.FINANCE_ENCRYPTION_KEY || '';
  if (cached && cached.src === src) return cached;
  if (!src) throw fail(503, 'Finance isn’t set up yet (FINANCE_ENCRYPTION_KEY is missing).');
  const bytes = Buffer.from(src, 'base64');
  if (bytes.length !== 32) throw fail(503, 'FINANCE_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.');
  // A short fingerprint of the key, so a file saved under another key says so
  // plainly instead of failing as "corrupt".
  cached = { src, bytes, kid: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8) };
  return cached;
}

export function vaultReady() {
  try { key(); return true; } catch (e) { return false; }
}

function checkPath(p) {
  if (!/^finance\/[a-z0-9/_.-]+\.json$/.test(p)) throw new Error('bad finance path: ' + p);
}

export function encrypt(p, data) {
  checkPath(p);
  const k = key();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.bytes, iv);
  c.setAAD(Buffer.from(p, 'utf8'));
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return { v: 1, kid: k.kid, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') };
}

export function decrypt(p, env) {
  checkPath(p);
  const k = key();
  if (!env || env.v !== 1 || !env.iv || !env.tag || typeof env.data !== 'string') throw fail(500, 'A finance file isn’t in the expected format.');
  if (env.kid !== k.kid) throw fail(500, 'The finance data was saved with a different FINANCE_ENCRYPTION_KEY.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k.bytes, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(p, 'utf8'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'));
  } catch (e) {
    throw fail(500, 'A finance file couldn’t be decrypted.');
  }
}

// { data, etag } or null. opts.etag = false skips the extra head() call
// (see store.js) for read-only use.
export async function readSecure(p, opts) {
  checkPath(p);
  const file = await readJSON(p, opts);
  return file ? { data: decrypt(p, file.data), etag: file.etag } : null;
}

export async function writeSecure(p, data, ifMatch) {
  await writeJSON(p, encrypt(p, data), ifMatch || null);
}

export async function removeSecure(p) {
  checkPath(p);
  await remove(p);
}

// Read-modify-write with an ETag check, retried if someone else saved in
// between (the cookbook's updateIndex pattern). fn gets a fresh copy of the
// current data (or empty() when there's no file yet) and returns the new
// data, or nothing to keep its in-place changes. Nothing is written when the
// data didn't change, which saves a Blob operation.
export async function updateSecure(p, fn, empty) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readSecure(p);
    const data = cur ? cur.data : empty();
    const before = JSON.stringify(data);
    const next = (await fn(data)) ?? data;
    if (cur && JSON.stringify(next) === before) return next;
    // Nothing there and nothing to add: don't create an empty file.
    if (!cur && JSON.stringify(next) === JSON.stringify(empty())) return next;
    try {
      await writeSecure(p, next, cur ? cur.etag : null);
      return next;
    } catch (e) {
      if (!e.precondition) throw e;
    }
  }
  throw fail(503, 'Finance is busy saving something else. Try again.');
}
