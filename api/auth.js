// Vercel serverless function: the site manager's (Sveltia CMS) "Sign in with
// GitHub" pop-up opens this URL.
//
// A hub admin already signed in with Google (FAMILY_ADMIN_EMAILS) skips
// GitHub entirely: the pop-up hands back GITHUB_CMS_TOKEN, a fine-grained
// token limited to this repo's contents. Anyone else goes through GitHub's
// OAuth page, which comes back to /api/callback with a code.

import { COOKIE, cookieValue, readToken, sessionSecret, isAdmin } from './_family/session.js';
import { siteOrigin, sendAuthResult } from './_family/cms-auth.js';

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
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/callback`,
    scope: 'repo,user',
    state: Math.random().toString(36).slice(2)
  });
  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
  res.end();
}
