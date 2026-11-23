// Where Documents keeps its files: Google Drive, in a "Randall Family
// Documents" folder in the Drive of the admin who connected it, with a
// folder per collection. Photos and PDFs sit there under readable names
// ("2025 Christmas card from Grandma Jean.jpg") with the details in each
// file's description, and a JSON copy of every item's catalog entry is kept
// in "Hub data", so the Drive folder on its own is a full copy of the
// archive, website or not.
//
// Connecting is a one-time Google consent by an admin, scope drive.file:
// the hub only ever sees files it created itself. The refresh token is kept
// in Blob at documents/drive.json, sealed with a key derived from
// FAMILY_SESSION_SECRET (change that secret and Drive needs reconnecting).
// A service account can't do this: new ones get no Drive storage and can't
// own files in a personal Drive.
//
// Uploads come through our function in 4 MiB pieces (a Vercel function
// takes at most 4.5 MB per request) and go on to a Drive resumable upload.
// Downloads pass through with Range support, so the page can fetch a big
// PDF in pieces, under the same 4.5 MB limit on responses.
//
// Run locally without Drive connected, files go to .family-data/documents/files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, remove } from '../store.js';
import { cookieValue, safeEqual } from '../session.js';
import { randomId } from '../recipes.js';

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const CONFIG = 'documents/drive.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Randall Family Documents';
export const FOLDERS = { cards: 'Cards & gifts', manuals: 'Manuals', receipts: 'Receipts', other: 'Other documents', hub: 'Hub data' };
export const CHUNK = 4 * 1024 * 1024; // a multiple of 256 KiB, as Drive asks
const MAX_FILE = 100 * 1024 * 1024;
const STATE_COOKIE = 'docs_drive_state';
const LOCAL_DIR = path.join(process.cwd(), '.family-data', 'documents', 'files');
const localAllowed = () => !process.env.VERCEL;

// Shown in the browser (images and PDFs); anything else is a download.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'image/heic': 'heic', 'text/plain': 'txt' };

/* ---------- keys: signing and sealing ---------- */

const keys = new Map();
function key(label) {
  const secret = process.env.FAMILY_SESSION_SECRET;
  if (!secret) throw fail(503, 'The hub isn’t set up yet (FAMILY_SESSION_SECRET is missing).');
  const id = label + '|' + secret;
  if (!keys.has(id)) keys.set(id, Buffer.from(crypto.hkdfSync('sha256', secret, 'randall-family-hub', label, 32)));
  return keys.get(id);
}
function sign(text) {
  return crypto.createHmac('sha256', key('documents-sign')).update(text).digest('base64url').slice(0, 32);
}
function signedOk(text, sig) {
  const want = sign(text);
  return typeof sig === 'string' && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key('documents-drive-token'), iv);
  c.setAAD(Buffer.from(CONFIG));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}
function unseal(s) {
  try {
    const [iv, tag, body] = String(s).split('.').map(p => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key('documents-drive-token'), iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(CONFIG));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

/* ---------- file references ----------
   A file is { id, store: 'drive' | 'local' }. Upload results carry a
   signature, so a save can only attach files that really came from our own
   uploads; view links carry another, so the file route needs no catalog
   read to know a file is ours. */

const ID_RE = /^[\w.-]{6,120}$/;
export function verifyRef(f) {
  return !!(f && ID_RE.test(String(f.id)) && (f.store === 'drive' || f.store === 'local') && signedOk('file|' + f.store + '|' + f.id, f.sig));
}
export function fileUrl(f) {
  return '/api/family?r=docs-file&s=' + f.store + '&f=' + encodeURIComponent(f.id) + '&k=' + sign('view|' + f.store + '|' + f.id);
}
function fileRef(store, id, up) {
  return { id, store, type: up.t, size: up.n, name: up.nm, sig: sign('file|' + store + '|' + id) };
}

export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
}
export function cleanType(t) {
  t = String(t || '').toLowerCase().split(';')[0].trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) && t.length <= 100 ? t : 'application/octet-stream';
}
export function extOf(name, type) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : EXT[type] || '';
}

/* ---------- the connection (documents/drive.json) ---------- */

let cfgCache = null; // { at, data }; read at most every 10 minutes per instance
async function config(fresh) {
  if (!fresh && cfgCache && Date.now() - cfgCache.at < 10 * 60 * 1000) return cfgCache.data;
  const f = await readJSON(CONFIG, { etag: false });
  cfgCache = { at: Date.now(), data: f ? f.data : null };
  return cfgCache.data;
}
async function saveConfig(data) {
  await writeJSON(CONFIG, data);
  cfgCache = { at: Date.now(), data };
}

const googleReady = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// What the page needs to know. "local" means uploads go to this computer's
// .family-data folder (the local preview, before Drive is connected).
export async function driveStatus(user, isAdmin) {
  const cfg = await config();
  const connected = !!(cfg && cfg.token && !cfg.broken);
  const mine = !!(cfg && user && user.email && cfg.email === user.email);
  return {
    connected,
    broken: !!(cfg && cfg.broken),
    email: cfg ? cfg.email || null : null,
    mine,
    folderUrl: connected && mine && cfg.folders && cfg.folders.root ? 'https://drive.google.com/drive/folders/' + cfg.folders.root : null,
    local: !connected && localAllowed(),
    canConnect: !!isAdmin && googleReady(),
    setUp: googleReady()
  };
}

async function backend() {
  const cfg = await config();
  if (cfg && cfg.token && !cfg.broken) return 'drive';
  if (cfg && cfg.broken) throw fail(503, 'Google Drive needs reconnecting before files can be added. An admin can reconnect it at the bottom of the Documents page.', 'drive_reconnect');
  if (localAllowed()) return 'local';
  throw fail(503, 'Google Drive isn’t connected yet, so files can’t be added. An admin can connect it at the bottom of the Documents page.', 'drive_off');
}

let token = null; // { value, exp }
async function accessToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const cfg = await config();
  if (!cfg || !cfg.token) throw fail(503, 'Google Drive isn’t connected yet.', 'drive_off');
  if (cfg.broken) throw fail(503, 'Google Drive needs reconnecting.', 'drive_reconnect');
  const refresh = unseal(cfg.token);
  if (!refresh) throw fail(503, 'Google Drive needs reconnecting (the hub’s secret changed).', 'drive_reconnect');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', refresh_token: refresh, grant_type: 'refresh_token' })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    console.error('Documents: Drive token refresh failed', r.status, data.error);
    if (data.error === 'invalid_grant') {
      // Revoked, or expired: an OAuth app left in "Testing" loses its tokens after 7 days.
      const cur = await config(true);
      if (cur) await saveConfig({ ...cur, broken: true }).catch(() => {});
      throw fail(503, 'Google Drive needs reconnecting. An admin can reconnect it at the bottom of the Documents page.', 'drive_reconnect');
    }
    throw fail(502, 'The hub couldn’t reach Google Drive. Try again in a minute.');
  }
  token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

async function gapi(url, { method = 'GET', query, json, body, headers = {}, raw = false, retry = true } = {}) {
  const full = url + (query ? (url.includes('?') ? '&' : '?') + new URLSearchParams(query) : '');
  const r = await fetch(full, {
    method,
    headers: { Authorization: 'Bearer ' + await accessToken(), ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body
  });
  if (r.status === 401 && retry) { token = null; return gapi(url, { method, query, json, body, headers, raw, retry: false }); }
  if (raw) return r;
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Documents: Drive API', method, r.status, data.error && data.error.message);
    if (r.status === 404) throw fail(404, 'That file isn’t in Google Drive any more.', 'drive_404');
    throw fail(502, 'Google Drive didn’t accept that. Try again.');
  }
  return data;
}

/* ---------- folders ---------- */

async function createFolder(name, parent) {
  const f = await gapi(API + '/files', { method: 'POST', query: { fields: 'id' }, json: { name, mimeType: FOLDER_TYPE, ...(parent ? { parents: [parent] } : {}) } });
  return f.id;
}
// Checks each folder is still there (not deleted or trashed) and makes any
// that's missing.
async function repairFolders(folders) {
  folders = { ...(folders || {}) };
  const alive = async id => {
    if (!id) return false;
    try {
      const f = await gapi(API + '/files/' + encodeURIComponent(id), { query: { fields: 'id,trashed' } });
      return !f.trashed;
    } catch (e) {
      if (e.code === 'drive_404') return false;
      throw e;
    }
  };
  if (!(await alive(folders.root))) folders = { root: await createFolder(ROOT_NAME) };
  await Promise.all(Object.entries(FOLDERS).map(async ([k, name]) => {
    if (!(await alive(folders[k]))) folders[k] = await createFolder(name, folders.root);
  }));
  return folders;
}
async function fixFolders() {
  const cfg = await config(true);
  if (!cfg || !cfg.token) throw fail(503, 'Google Drive isn’t connected yet.', 'drive_off');
  const next = { ...cfg, folders: await repairFolders(cfg.folders) };
  await saveConfig(next);
  return next.folders;
}
// Runs fn(folders), and once more with repaired folders if Drive says one
// is gone (someone deleted it in Drive).
async function withFolders(fn) {
  const cfg = await config();
  let folders = cfg && cfg.folders && cfg.folders.hub ? cfg.folders : await fixFolders();
  try {
    return await fn(folders);
  } catch (e) {
    if (e.code !== 'drive_404') throw e;
    folders = await fixFolders();
    return fn(folders);
  }
}

/* ---------- uploads ---------- */

function pack(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return body + '.' + sign('up|' + body);
}
function unpack(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !signedOk('up|' + body, sig)) throw fail(400, 'That upload isn’t valid. Try adding the file again.');
  const up = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!(up.e > Date.now())) throw fail(410, 'That upload took too long. Try adding the file again.');
  if (up.s === 'drive' && !/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(up.u)) throw fail(400, 'That upload isn’t valid.');
  return up;
}
function localPath(id) {
  if (!ID_RE.test(id)) throw fail(400, 'Bad file name');
  return path.join(LOCAL_DIR, id);
}

// { name, type, size } -> { token, chunk }. New files start in "Hub data"
// and move to their collection's folder when the item is saved, so files
// from an item that's never saved stay out of the way.
export async function startUpload(input) {
  const name = cleanName(input && input.name) || 'file';
  const type = cleanType(input && input.type);
  const size = Math.floor(Number(input && input.size));
  if (!(size > 0)) throw fail(400, 'That file is empty.');
  if (size > MAX_FILE) throw fail(413, 'That file is too big (100 MB at most).');
  const expires = Date.now() + 6 * 3600 * 1000;
  if (await backend() === 'local') {
    const id = randomId(20) + (extOf(name, type) ? '.' + extOf(name, type) : '');
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(localPath(id) + '.part', '');
    return { token: pack({ s: 'local', id, n: size, t: type, nm: name, e: expires }), chunk: CHUNK };
  }
  const session = await driveSession(name, type, size);
  return { token: pack({ s: 'drive', u: session, n: size, t: type, nm: name, e: expires }), chunk: CHUNK };
}

// A Drive resumable upload into "Hub data"; returns its session address.
function driveSession(name, type, size) {
  return withFolders(async folders => {
    const r = await gapi(UPLOAD, {
      method: 'POST', raw: true,
      query: { uploadType: 'resumable', fields: 'id' },
      headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(size) },
      json: { name, parents: [folders.hub] }
    });
    if (r.status === 404) throw fail(404, 'A Drive folder is missing.', 'drive_404');
    if (!r.ok || !r.headers.get('location')) {
      console.error('Documents: Drive upload start', r.status);
      throw fail(502, 'Google Drive didn’t start the upload. Try again.');
    }
    return r.headers.get('location');
  });
}

// Stores a file the server has in hand (a manual it downloaded) in one go:
// server to Google has no 4.5 MB limit. Returns a signed reference, like an
// upload from the page.
export async function storeBytes(bytes, name, type) {
  name = cleanName(name) || 'file';
  type = cleanType(type);
  if (!bytes.length) throw fail(400, 'That file is empty.');
  if (bytes.length > MAX_FILE) throw fail(413, 'That file is too big (100 MB at most).');
  const up = { n: bytes.length, t: type, nm: name };
  if (await backend() === 'local') {
    const id = randomId(20) + (extOf(name, type) ? '.' + extOf(name, type) : '');
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(localPath(id), bytes);
    fs.writeFileSync(localPath(id) + '.type', type);
    return fileRef('local', id, up);
  }
  const session = await driveSession(name, type, bytes.length);
  const r = await fetch(session, { method: 'PUT', redirect: 'manual', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': type }, body: bytes });
  if (r.status !== 200 && r.status !== 201) {
    console.error('Documents: Drive upload', r.status);
    throw fail(502, 'Google Drive didn’t take the file. Try again.');
  }
  return fileRef('drive', (await r.json()).id, up);
}

// The view link for a file (fileUrl), for a reference the page just got.
export function viewUrl(f) {
  return verifyRef(f) ? fileUrl(f) : null;
}

// One piece of an upload. Returns { done: false, next } (the byte to send
// next) or { done: true, file }. statusOnly asks where the upload got to,
// for picking up after a failed piece.
export async function uploadChunk(tok, offsetHeader, bytes, statusOnly) {
  const up = unpack(tok);
  const offset = Number(offsetHeader);
  if (!statusOnly && (!Number.isInteger(offset) || offset < 0 || !bytes.length || offset + bytes.length > up.n || bytes.length > CHUNK)) {
    throw fail(400, 'That piece of the upload doesn’t fit.');
  }
  if (up.s === 'local') return localChunk(up, offset, bytes, statusOnly);
  // Drive answers an unfinished upload with 308, which isn't a redirect
  // here, so it mustn't be followed as one.
  const r = await fetch(up.u, {
    method: 'PUT',
    redirect: 'manual',
    headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Range': statusOnly ? `bytes */${up.n}` : `bytes ${offset}-${offset + bytes.length - 1}/${up.n}` },
    body: statusOnly ? undefined : bytes
  });
  if (r.status === 308) {
    const range = r.headers.get('range');
    return { done: false, next: range ? Number(range.split('-')[1]) + 1 : 0 };
  }
  if (r.status === 200 || r.status === 201) {
    const f = await r.json();
    return { done: true, file: fileRef('drive', f.id, up) };
  }
  console.error('Documents: Drive upload piece', r.status);
  if (r.status === 404 || r.status === 410) throw fail(410, 'The upload expired. Try adding the file again.');
  throw fail(502, 'Google Drive didn’t take that piece of the file.');
}

function localChunk(up, offset, bytes, statusOnly) {
  const full = localPath(up.id), part = full + '.part';
  if (!fs.existsSync(part)) {
    if (fs.existsSync(full)) return { done: true, file: fileRef('local', up.id, up) };
    throw fail(410, 'The upload expired. Try adding the file again.');
  }
  const have = fs.statSync(part).size;
  if (statusOnly || offset !== have) return { done: false, next: have };
  fs.appendFileSync(part, bytes);
  if (have + bytes.length < up.n) return { done: false, next: have + bytes.length };
  fs.renameSync(part, full);
  fs.writeFileSync(full + '.type', up.t);
  return { done: true, file: fileRef('local', up.id, up) };
}

/* ---------- downloads ---------- */

function fileResponse(body, status, type, { length, range }, name, download) {
  type = cleanType(type);
  const inline = !download && INLINE.has(type);
  const headers = {
    'Content-Type': INLINE.has(type) ? type : 'application/octet-stream',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  };
  if (length) headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = range;
  return new Response(body, { status, headers });
}

export async function serveFile(url, request) {
  const store = url.searchParams.get('s'), id = url.searchParams.get('f') || '';
  if ((store !== 'drive' && store !== 'local') || !ID_RE.test(id) || !signedOk('view|' + store + '|' + id, url.searchParams.get('k'))) throw fail(404, 'Not found');
  const name = cleanName(url.searchParams.get('n')) || id;
  const download = url.searchParams.get('dl') === '1';
  const range = request.headers.get('range');

  if (store === 'local') {
    const full = localPath(id);
    if (!fs.existsSync(full)) throw fail(404, 'That file isn’t here any more.');
    const type = fs.existsSync(full + '.type') ? fs.readFileSync(full + '.type', 'utf8') : 'application/octet-stream';
    const buf = fs.readFileSync(full);
    const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) {
      const start = Number(m[1]), end = Math.min(m[2] ? Number(m[2]) : buf.length - 1, buf.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.length}` } });
      return fileResponse(buf.subarray(start, end + 1), 206, type, { length: end - start + 1, range: `bytes ${start}-${end}/${buf.length}` }, name, download);
    }
    return fileResponse(buf, 200, type, { length: buf.length }, name, download);
  }

  const r = await gapi(API + '/files/' + encodeURIComponent(id), { query: { alt: 'media' }, headers: range ? { Range: range } : {}, raw: true });
  if (r.status === 404) throw fail(404, 'That file isn’t in Google Drive any more.');
  if (r.status === 416) return new Response(null, { status: 416 });
  if (!r.ok) {
    console.error('Documents: Drive download', r.status);
    throw fail(502, 'Google Drive didn’t send the file. Try again.');
  }
  return fileResponse(r.body, r.status, r.headers.get('content-type'), { length: r.headers.get('content-length'), range: r.headers.get('content-range') }, name, download);
}

/* ---------- keeping Drive tidy ---------- */

// Moves files to the trash (Drive keeps them there for 30 days).
export async function trashFiles(files) {
  await Promise.all((files || []).filter(Boolean).map(async f => {
    try {
      if (f.store === 'local') {
        for (const p of [localPath(f.id), localPath(f.id) + '.type']) if (fs.existsSync(p)) fs.unlinkSync(p);
        return;
      }
      await gapi(API + '/files/' + encodeURIComponent(f.id), { method: 'PATCH', query: { fields: 'id' }, json: { trashed: true } });
    } catch (e) {
      if (e.code !== 'drive_404') console.error('Documents: couldn’t trash a file:', e.message);
    }
  }));
}

// Files uploaded in the editor and then taken off before saving. Only
// fresh uploads carry a signature the page can send back, so this can't
// reach a saved item's files.
export async function discardUploads(list) {
  const files = (Array.isArray(list) ? list : []).slice(0, 40).flatMap(f => [f, f && f.thumb]).filter(verifyRef);
  await trashFiles(files);
  return { ok: true };
}

const fingerprint = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('base64url').slice(0, 16);

// Puts an item's Drive files in its collection's folder under readable
// names (base + " (2)"... + extension), with the item's details as the
// description. Only files whose place, name or description changed are
// touched; each file records what it was given (f.folder, f.placed). Never
// throws: a failure is logged and tried again on the next save.
export async function placeFiles(files, { folder, base, description }) {
  const drive = (files || []).filter(f => f.store === 'drive');
  if (!drive.length || !FOLDERS[folder]) return;
  try {
    const cfg = await config();
    if (!cfg || !cfg.token || cfg.broken) return;
    await withFolders(async folders => {
      await Promise.all(drive.map(async (f, i) => {
        const ext = extOf(f.name, f.type);
        const name = cleanName(base + (drive.length > 1 ? ` (${i + 1})` : '')).slice(0, 140) + (ext ? '.' + ext : '');
        const want = fingerprint({ name, folder, description, root: folders[folder] });
        if (f.placed === want) return;
        const from = folders[f.folder || 'hub'];
        const query = { fields: 'id' };
        if (from !== folders[folder]) { query.addParents = folders[folder]; if (from) query.removeParents = from; }
        await gapi(API + '/files/' + encodeURIComponent(f.id), { method: 'PATCH', query, json: { name, description } });
        f.folder = folder;
        f.placed = want;
      }));
    });
  } catch (e) {
    console.error('Documents: couldn’t place files in Drive:', e.message);
  }
}

// Writes the item's catalog entry as JSON into "Hub data" (one file per
// item), so Drive alone holds everything. Returns the Drive file's id, or
// the old one when nothing could be written.
export async function backupEntry(entry, backupId) {
  try {
    const cfg = await config();
    if (!cfg || !cfg.token || cfg.broken) return backupId || null;
    const body = JSON.stringify(entry, null, 2);
    if (backupId) {
      try {
        await gapi(UPLOAD + '/' + encodeURIComponent(backupId), { method: 'PATCH', query: { uploadType: 'media', fields: 'id' }, body, headers: { 'Content-Type': 'application/json' } });
        return backupId;
      } catch (e) {
        if (e.code !== 'drive_404') throw e; // deleted in Drive: write a new one
      }
    }
    return await withFolders(async folders => {
      const boundary = 'hub' + randomId(20);
      const meta = { name: entry.id + '.json', parents: [folders.hub], mimeType: 'application/json', description: 'Catalog entry for “' + entry.name + '”, kept by the family hub.' };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const f = await gapi(UPLOAD, { method: 'POST', query: { uploadType: 'multipart', fields: 'id' }, body: multipart, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary } });
      return f.id;
    });
  } catch (e) {
    console.error('Documents: couldn’t back up a catalog entry to Drive:', e.message);
    return backupId || null;
  }
}

/* ---------- connecting and disconnecting ---------- */

function back(code) {
  return new Response(null, { status: 302, headers: { Location: '/family/documents?drive=' + code, 'Cache-Control': 'no-store', 'Set-Cookie': `${STATE_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax` } });
}

// Sends the admin to Google's consent screen.
export function connectStart(request, user) {
  if (!googleReady()) throw fail(503, 'Google Drive isn’t set up yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are needed).');
  const url = new URL(request.url);
  const state = randomId(32);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + '/api/drive-callback',
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Always ask which Google account (nothing pre-picked: the hub sign-in
    // may be a work account, and the files belong to whichever is chosen),
    // and always ask consent, which is what hands back a refresh token.
    prompt: 'select_account consent',
    state
  });
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params,
      'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api; Max-Age=600; HttpOnly; SameSite=Lax${secure}`
    }
  });
}

// Google sends the admin back here (/api/drive-callback, rewritten to
// ?r=docs-drive-callback) with a code to trade for tokens.
export async function connectFinish(request, url, user) {
  if (url.searchParams.get('error')) return back('denied');
  const want = cookieValue(request.headers.get('cookie'), STATE_COOKIE);
  if (!want || !safeEqual(want, url.searchParams.get('state') || '')) return back('expired');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: url.origin + '/api/drive-callback', grant_type: 'authorization_code'
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    console.error('Documents: Drive sign-in failed', r.status, data.error);
    return back('failed');
  }
  // Google's consent screen lets people untick the Drive box.
  if (!String(data.scope || '').split(' ').includes(SCOPE)) return back('scope');
  if (!data.refresh_token) return back('failed');

  token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  const prev = await config(true);
  let email = user.email || null;
  try {
    const about = await gapi(API + '/about', { query: { fields: 'user(emailAddress)' } }).catch(() => null);
    if (about && about.user && about.user.emailAddress) email = String(about.user.emailAddress).toLowerCase();
  } catch (e) { /* keep the hub sign-in's email */ }
  const sameAccount = !!(prev && prev.email && prev.email === email);
  const cfg = {
    email, token: seal(data.refresh_token), connectedAt: new Date().toISOString(), connectedBy: user.name,
    folders: sameAccount ? prev.folders || {} : {}
  };
  await saveConfig(cfg);
  try {
    await saveConfig({ ...cfg, folders: await repairFolders(cfg.folders) });
  } catch (e) {
    console.error('Documents: couldn’t make the Drive folders:', e.message);
  }
  return back('connected');
}

// Forgets the connection. The files stay in Drive, and the Google grant is
// left alone: reconnecting the same account picks the same files back up.
export async function disconnect() {
  await remove(CONFIG).catch(() => {});
  cfgCache = { at: Date.now(), data: null };
  token = null;
}
