// Vercel serverless function: handles GitHub's OAuth callback.
// Exchanges the temporary code for an access token, then posts the token
// back to the /admin/ window via window.opener.postMessage.

export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing ?code parameter');
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
  const message = ok
    ? `authorization:github:success:${JSON.stringify({ token: payload.access_token, provider: 'github' })}`
    : `authorization:github:error:${JSON.stringify(payload)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><title>Authorizing...</title></head>
<body style="font-family:system-ui;padding:2rem;text-align:center;">
<p id="status">Finishing login... you can close this window.</p>
<script>
(function () {
  var sent = false;
  function send() {
    if (!window.opener) {
      document.getElementById('status').textContent = 'No opener window found. Try logging in again.';
      return;
    }
    sent = true;
    try { window.opener.postMessage(${JSON.stringify(message)}, '*'); } catch (e) {}
  }
  // Listen for Decap's handshake first
  window.addEventListener('message', function (e) {
    if (e.data === 'authorizing:github' || (typeof e.data === 'string' && e.data.indexOf('authorizing:') === 0)) {
      send();
    }
  });
  // Send immediately too, in case Decap is already listening
  send();
  // Re-send a few times in case of timing issues
  setTimeout(send, 300);
  setTimeout(send, 800);
  setTimeout(send, 1500);
  // Close window after giving plenty of time
  setTimeout(function () { window.close(); }, 2500);
})();
</script>
</body></html>`);
}
