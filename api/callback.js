// Vercel serverless function: handles GitHub's OAuth callback for the site
// manager (Sveltia CMS). Exchanges the temporary code for an access token,
// then hands it back to the CMS window (see api/_family/cms-auth.js).

import { siteOrigin, sendAuthResult, STATE_COOKIE } from './_family/cms-auth.js';
import { cookieValue, safeEqual } from './_family/session.js';

export default async function handler(req, res) {
  const { code, state } = req.query;
  if (!code) {
    return res.status(400).send('Missing ?code parameter');
  }
  // The state api/auth.js set: this sign-in started on this browser.
  const expected = cookieValue(req.headers.cookie, STATE_COOKIE);
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/api/callback; Max-Age=0; HttpOnly; SameSite=Lax`);
  if (!expected || !state || !safeEqual(String(state), expected)) {
    return sendAuthResult(res, siteOrigin(req), false, { error: 'state_mismatch', error_description: 'The sign-in didn’t start here. Try again.' });
  }
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET environment variable');
  }

  let payload;
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code
      })
    });
    payload = await r.json();
  } catch (e) {
    payload = { error: 'fetch_failed', error_description: String(e) };
  }

  const ok = !!payload.access_token;
  return sendAuthResult(res, siteOrigin(req), ok, ok ? payload.access_token : payload);
}
