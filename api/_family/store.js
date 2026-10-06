// Storage for the family hub: a private Vercel Blob store in production,
// a gitignored .family-data/ folder when running locally without a Blob
// token (so the hub can be tried out on the local preview server).

import { put, get, del, BlobPreconditionFailedError } from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';

const useBlob = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || process.env.VERCEL);
const LOCAL_ROOT = path.join(process.cwd(), '.family-data');

function localPath(p) {
  const full = path.join(LOCAL_ROOT, p);
  if (!full.startsWith(LOCAL_ROOT)) throw new Error('bad path');
  return full;
}

async function streamToBuffer(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

// Returns { data, etag } or null when the file doesn't exist.
export async function readJSON(p) {
  if (!useBlob) {
    const f = localPath(p);
    if (!fs.existsSync(f)) return null;
    const text = fs.readFileSync(f, 'utf8');
    return { data: JSON.parse(text), etag: String(fs.statSync(f).mtimeMs) };
  }
  const r = await get(p, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return { data: JSON.parse((await streamToBuffer(r.stream)).toString('utf8')), etag: r.blob.etag };
}

// ifMatch: only write if the file still has this etag (throws a
// PreconditionFailed error otherwise). Pass null to create-or-overwrite.
export async function writeJSON(p, data, ifMatch) {
  const body = JSON.stringify(data, null, 2);
  if (!useBlob) {
    const f = localPath(p);
    if (ifMatch && fs.existsSync(f) && String(fs.statSync(f).mtimeMs) !== ifMatch) {
      const e = new Error('precondition failed'); e.precondition = true; throw e;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    return;
  }
  try {
    await put(p, body, {
      access: 'private', contentType: 'application/json', addRandomSuffix: false,
      allowOverwrite: true, cacheControlMaxAge: 60, ...(ifMatch ? { ifMatch } : {})
    });
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) e.precondition = true;
    throw e;
  }
}

export async function putFile(p, bytes, contentType) {
  if (!useBlob) {
    const f = localPath(p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes);
    return;
  }
  // Media names are random and never rewritten, so they can cache for a year.
  await put(p, bytes, { access: 'private', contentType, addRandomSuffix: false, cacheControlMaxAge: 31536000 });
}

// Returns { body: ReadableStream | Buffer, contentType, etag } or null.
export async function getFile(p) {
  if (!useBlob) {
    const f = localPath(p);
    if (!fs.existsSync(f)) return null;
    const ext = path.extname(f).slice(1);
    return { body: fs.readFileSync(f), contentType: ({ webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' })[ext] || 'application/octet-stream', etag: null };
  }
  const r = await get(p, { access: 'private' });
  if (!r || r.statusCode !== 200) return null;
  return { body: r.stream, contentType: r.blob.contentType, etag: r.blob.etag };
}

export async function getFileBuffer(p) {
  const f = await getFile(p);
  if (!f) return null;
  return Buffer.isBuffer(f.body) ? f.body : await streamToBuffer(f.body);
}

export async function remove(p) {
  if (!useBlob) {
    const f = localPath(p);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return;
  }
  await del(p);
}
