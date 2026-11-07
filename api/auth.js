// Vercel serverless function: the site manager's (Sveltia CMS) "Sign in with
// GitHub" pop-up opens this URL.
//
// A hub admin already signed in with Google (FAMILY_ADMIN_EMAILS) skips
// GitHub entirely: the pop-up hands back GITHUB_CMS_TOKEN, a fine-grained
// token limited to this repo's contents. Anyone else goes through GitHub's
// OAuth page, which comes back to /api/callback with a code.

import crypto from 'node:crypto';
import { COOKIE, cookieValue, readToken, sessionSecret, isAdmin } from './_family/session.js';
import { siteOrigin, sendAuthResult, STATE_COOKIE } from './_family/cms-auth.js';

export default async function handler(req, res) {
  const origin = siteOrigin(req);

  const token = process.env.GITHUB_CMS_TOKEN;
  if (token) {
    const user = await readToken(cookieValue(req.headers.cookie, COOKIE), sessionSecret());
    if (isAdmin(user)) return sendAuthResult(res, origin, true, token);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Missing GITHUB_CLIENT_ID environment variable');
  }
  // state: random, kept in a short-lived cookie that api/callback.js checks,
  // so a sign-in can't be finished with someone else's GitHub code.
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/callback`,
    // The repo is public, so public_repo is enough (it would need "repo" if
    // the repo were ever made private).
    scope: 'public_repo',
    state
  });
  res.writeHead(302, {
    Location: `https://github.com/login/oauth/authorize?${params}`,
    'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api/callback; Max-Age=600; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`
  });
  res.end();
}
