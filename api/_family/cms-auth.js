// The site manager (Sveltia CMS at /family/manage) signs in to GitHub
// through a pop-up: it opens /api/auth, and the pop-up hands a GitHub token
// back to it with postMessage ("authorization:github:success:{...}"), the
// Decap-style handshake. Two ways to get there:
//   - api/auth.js, for a hub admin signed in with Google: a stored token
//     (GITHUB_CMS_TOKEN), no GitHub page at all.
//   - api/callback.js, everyone else: GitHub's own OAuth sign-in.

// The page's own origin, so the token only ever goes to this site.
export function siteOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// ok: true with a token, or false with an error payload.
export function sendAuthResult(res, origin, ok, payload) {
  const message = ok
    ? `authorization:github:success:${JSON.stringify({ token: payload, provider: 'github' })}`
    : `authorization:github:error:${JSON.stringify(payload)}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html><head><title>Signing in…</title></head>
<body style="font-family:system-ui;padding:2rem;text-align:center;">
<p id="status">${ok ? 'Signed in. You can close this window.' : 'Sign-in didn’t work. Close this window and try again.'}</p>
<script>
(function () {
  var origin = ${JSON.stringify(origin)};
  var message = ${JSON.stringify(message)};
  function send() {
    if (!window.opener) {
      document.getElementById('status').textContent = 'No opener window found. Try signing in again.';
      return;
    }
    try { window.opener.postMessage(message, origin); } catch (e) {}
  }
  // Answer the CMS's handshake (only from this site), and also send right
  // away and a few more times in case it's already listening.
  window.addEventListener('message', function (e) {
    if (e.origin === origin && typeof e.data === 'string' && e.data.indexOf('authorizing:') === 0) send();
  });
  send();
  setTimeout(send, 300);
  setTimeout(send, 800);
  setTimeout(send, 1500);
  setTimeout(function () { window.close(); }, 2500);
})();
</script>
</body></html>`);
}
