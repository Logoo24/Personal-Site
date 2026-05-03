// Vercel serverless function: starts the GitHub OAuth flow for Decap CMS.
// When the user clicks "Login with GitHub" in /admin/, Decap opens this URL.
// We redirect to GitHub's authorization page; GitHub then redirects back to
// /api/callback with a code we can exchange for a token.

export default function handler(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Missing GITHUB_CLIENT_ID environment variable');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${host}/api/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo,user',
    state: Math.random().toString(36).slice(2)
  });
  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
  res.end();
}
