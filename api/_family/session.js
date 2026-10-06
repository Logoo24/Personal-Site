// Family hub sessions: a signed cookie, no database.
//
// The cookie holds base64url(JSON payload) + "." + base64url(HMAC-SHA256),
// signed with FAMILY_SESSION_SECRET. Uses only Web Crypto so the same code
// runs in the Edge middleware (middleware.js) and the Node function
// (api/family.js). Files under api/_family/ aren't deployed as functions.

export const COOKIE = 'fh_session';
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

// Compares two strings without bailing out at the first difference.
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Who can manage the site (the blog CMS at /family/manage): Google sign-ins
// whose email is in FAMILY_ADMIN_EMAILS (comma-separated). The list lives in
// the environment, not the code, because the repo is public. Password
// sign-ins have no verified email, so they never count.
export function isAdmin(user) {
  const allowed = String(process.env.FAMILY_ADMIN_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return !!(user && user.via === 'google' && user.email && allowed.includes(String(user.email).toLowerCase()));
}

export function sessionSecret() {
  return process.env.FAMILY_SESSION_SECRET || '';
}

// user = { name, email?, via: 'google' | 'password' }
export async function createToken(user, secret) {
  const body = b64url(enc.encode(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + MAX_AGE })));
  return body + '.' + await sign(secret, body);
}

export async function readToken(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, await sign(secret, body))) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(body)));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch (e) {
    return null;
  }
}

export function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function readSession(request) {
  return readToken(cookieValue(request.headers.get('cookie'), COOKIE), sessionSecret());
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearedCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
