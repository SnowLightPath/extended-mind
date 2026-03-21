const CODE_TTL = 600;
const TOKEN_TTL = 31536000; // 1 year

const PLATFORM_MAP = {
  'chatgpt-extended-mind': 'chatgpt',
  'claude-extended-mind': 'claude-chat',
};

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function oauthError(error, description, status = 400) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function authorizePage(clientName, clientId, redirectUri, state, errorMsg) {
  return html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extended Mind — Authorize</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 1.3em; }
  p { color: #666; line-height: 1.5; }
  .error { color: #c00; font-size: 0.9em; margin-bottom: 12px; }
  label { display: block; font-size: 0.9em; margin-bottom: 4px; color: #555; }
  input[type=password] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; box-sizing: border-box; }
  button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; margin-top: 16px; }
  button:hover { background: #1d4ed8; }
</style>
</head>
<body>
<h1>Extended Mind</h1>
<p><strong>${clientName}</strong> があなたのコンテキストへのアクセスを要求しています。</p>
<p>アクセス権限: コンテキストの読み取り・書き込み</p>
${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="state" value="${state || ''}">
<label for="token">PCP Token</label>
<input type="password" id="token" name="token" required placeholder="Enter your PCP token">
<button type="submit">Authorize</button>
</form>
</body>
</html>`);
}

export async function handleAuthorizeGet(url, env) {
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const state = url.searchParams.get('state');

  if (responseType !== 'code') {
    return html('<p>Error: response_type must be "code"</p>', 400);
  }

  let client;
  try {
    const clientRaw = await env.PCP.get(`oauth:client:${clientId}`);
    if (!clientRaw) {
      return html('<p>Error: Invalid request</p>', 400);
    }
    client = JSON.parse(clientRaw);
  } catch {
    return html('<p>Error: Invalid request</p>', 400);
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return html('<p>Error: Invalid request</p>', 400);
  }

  return authorizePage(client.name, clientId, redirectUri, state);
}

export async function handleAuthorizePost(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return html('<p>Error: Invalid request</p>', 400);
  }
  const token = form.get('token');
  const clientId = form.get('client_id');
  const redirectUri = form.get('redirect_uri');
  const state = form.get('state');

  let client;
  try {
    const clientRaw = await env.PCP.get(`oauth:client:${clientId}`);
    if (!clientRaw) {
      return html('<p>Error: Invalid request</p>', 400);
    }
    client = JSON.parse(clientRaw);
  } catch {
    return html('<p>Error: Invalid request</p>', 400);
  }

  if (token !== env.PCP_TOKEN) {
    return authorizePage(client.name, clientId, redirectUri, state, 'Invalid token — please try again');
  }

  const code = randomHex(32);
  await env.PCP.put(
    `oauth:code:${code}`,
    JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, created_at: Date.now() }),
    { expirationTtl: CODE_TTL },
  );

  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  if (state) location.searchParams.set('state', state);

  return Response.redirect(location.toString(), 302);
}

export async function handleToken(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let params;

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      params = Object.fromEntries(form.entries());
    } else if (contentType.includes('application/json')) {
      params = await request.json();
    } else {
      return oauthError('invalid_request', 'Unsupported content type');
    }
  } catch {
    return oauthError('invalid_request', 'Malformed request body');
  }

  const { grant_type, code, client_id, client_secret, redirect_uri } = params;

  if (grant_type !== 'authorization_code') {
    return oauthError('unsupported_grant_type', 'Only authorization_code is supported');
  }

  let client;
  try {
    const clientRaw = await env.PCP.get(`oauth:client:${client_id}`);
    if (!clientRaw) {
      return oauthError('invalid_client', 'Authentication failed', 401);
    }
    client = JSON.parse(clientRaw);
  } catch {
    return oauthError('invalid_client', 'Authentication failed', 401);
  }

  if (client.client_secret !== client_secret) {
    return oauthError('invalid_client', 'Authentication failed', 401);
  }

  const codeRaw = await env.PCP.get(`oauth:code:${code}`);
  if (!codeRaw) {
    return oauthError('invalid_grant', 'Authorization code expired or invalid');
  }

  await env.PCP.delete(`oauth:code:${code}`);

  let codeData;
  try {
    codeData = JSON.parse(codeRaw);
  } catch {
    return oauthError('invalid_grant', 'Authorization code expired or invalid');
  }

  if (codeData.client_id !== client_id || codeData.redirect_uri !== redirect_uri) {
    return oauthError('invalid_grant', 'Code does not match client or redirect_uri');
  }

  const accessToken = `pcp_oauth_${randomHex(32)}`;
  await env.PCP.put(
    `oauth:token:${accessToken}`,
    JSON.stringify({ client_id, platform: PLATFORM_MAP[client_id] || client.name, created_at: Date.now() }),
    { expirationTtl: TOKEN_TTL },
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
