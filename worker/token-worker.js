// Cloudflare Worker for Eisenhower Matrix+: keeps the Google Drive connection alive.
//
// Google gives a browser-only app an access token for one hour only. A refresh token
// (which lasts) needs the app's client secret, and that must not be in a public web page.
// This worker only adds the secret and forwards two requests to Google's token endpoint:
//   POST /token    {code}           -> {access_token, expires_in, refresh_token}
//   POST /refresh  {refresh_token}  -> {access_token, expires_in}
// It stores nothing and never sees the matrix itself (that goes directly from the browser to Google Drive).
//
// Settings in Cloudflare (Worker -> Settings -> Variables and Secrets):
//   GOOGLE_CLIENT_ID      (text)   the OAuth client id
//   GOOGLE_CLIENT_SECRET  (secret) the OAuth client secret

const ALLOWED_ORIGINS = ['https://master-d1990.github.io', 'http://localhost:8712'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || !allowed) return json({ error: 'forbidden' }, 403);
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'not_configured' }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }

    const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    const path = new URL(request.url).pathname;
    if (path === '/token' && typeof body.code === 'string' && body.code.length < 2048) {
      params.set('grant_type', 'authorization_code');
      params.set('code', body.code);
      params.set('redirect_uri', 'postmessage');   // the code comes from the Google popup (GIS code client)
    } else if (path === '/refresh' && typeof body.refresh_token === 'string' && body.refresh_token.length < 2048) {
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', body.refresh_token);
    } else {
      return json({ error: 'bad_request' }, 400);
    }

    let res, data;
    try {
      res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      data = await res.json();
    } catch {
      return json({ error: 'google_unreachable' }, 502);
    }
    // pass on only what the page needs
    return json({
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      error: data.error,
    }, res.status);
  },
};
