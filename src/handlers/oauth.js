import {
  getAuthSession,
  constantTimeEqual,
  randomHex,
  hashToken,
  signAuthSession,
  verifyAuthSession,
} from '../utils/auth.js';

const CODE_TTL = 600;
const CSRF_TTL = 600;
const TOKEN_TTL = 7776000; // 90 days

const PLATFORM_MAP = {
  'chatgpt-extended-mind': 'chatgpt',
  'claude-extended-mind': 'claude-chat',
};

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

function oauthError(error, description, status = 400) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}


async function createAuthSession(env, { client_id, redirect_uri, state, code_challenge, code_challenge_method }) {
  const authSessionId = randomHex(16);
  const csrfToken = randomHex(16);
  const issuedAt = Date.now();
  const authSession = {
    client_id,
    redirect_uri,
    state,
    csrf_token: csrfToken,
    code_challenge: code_challenge || null,
    code_challenge_method: code_challenge ? (code_challenge_method || 'S256') : null,
    issued_at: issuedAt,
  };
  await env.PCP.put(
    `auth:session:${authSessionId}`,
    JSON.stringify(authSession),
    { expirationTtl: CSRF_TTL },
  );
  const authSessionToken = await signAuthSession(env, authSession);
  return { authSessionId, csrfToken, authSessionToken };
}

function authorizePage(clientName, authSessionId, csrfToken, authSessionToken, errorMsg) {
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
<p><strong>${escapeHtml(clientName)}</strong> があなたのコンテキストへのアクセスを要求しています。</p>
<p>アクセス権限: コンテキストの読み取り・書き込み</p>
${errorMsg ? `<div class="error">${escapeHtml(errorMsg)}</div>` : ''}
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<input type="hidden" name="auth_session_id" value="${escapeHtml(authSessionId)}">
<input type="hidden" name="auth_session" value="${escapeHtml(authSessionToken)}">
<label for="token">PCP Token</label>
<input type="password" id="token" name="token" required placeholder="Enter your PCP token" autocomplete="username webauthn">
<button type="submit">Authorize</button>
</form>
<script>
(async () => {
  if (!window.PublicKeyCredential) return;
  const conditional = window.PublicKeyCredential.isConditionalMediationAvailable;
  if (!conditional || !(await conditional())) return;

  const authSessionId = document.querySelector('input[name="auth_session_id"]').value;

  const beginRes = await fetch('/oauth/authorize/webauthn/auth/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_session_id: authSessionId })
  });
  if (!beginRes.ok) return;
  const beginData = await beginRes.json();

  function b64urlToBytes(b64) {
    const str = atob(b64.replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(str, c => c.charCodeAt(0));
  }
  function bytesToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
  }

  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(beginData.challenge),
        rpId: beginData.rpId,
        timeout: beginData.timeout,
        userVerification: beginData.userVerification
      },
      mediation: 'conditional'
    });

    const authentication = {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bytesToB64url(credential.response.clientDataJSON),
        authenticatorData: bytesToB64url(credential.response.authenticatorData),
        signature: bytesToB64url(credential.response.signature),
        userHandle: credential.response.userHandle ? bytesToB64url(credential.response.userHandle) : undefined
      }
    };

    const verifyRes = await fetch('/oauth/authorize/webauthn/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authentication, challenge_id: beginData.challenge_id })
    });
    const verifyData = await verifyRes.json();
    if (verifyRes.ok && verifyData.redirect) {
      window.location.href = verifyData.redirect;
    }
  } catch (e) {
    // User cancelled or no credential — fall through to password form
  }
})();
</script>
</body>
</html>`);
}

export async function handleAuthorizeGet(url, env) {
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const state = url.searchParams.get('state');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';

  if (responseType !== 'code') {
    return html('<p>Error: response_type must be "code"</p>', 400);
  }

  if (codeChallenge && codeChallengeMethod !== 'S256') {
    return html('<p>Error: Only S256 code_challenge_method is supported</p>', 400);
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

  const { authSessionId, csrfToken, authSessionToken } = await createAuthSession(env, {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallenge ? codeChallengeMethod : null,
  });

  return authorizePage(client.name, authSessionId, csrfToken, authSessionToken);
}

export async function handleAuthorizePost(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return html('<p>Error: Invalid request</p>', 400);
  }
  const csrfToken = form.get('csrf_token');
  const token = form.get('token');
  const authSessionId = form.get('auth_session_id');
  const authSessionToken = form.get('auth_session');

  if (!csrfToken || (!authSessionId && !authSessionToken)) {
    return html('<p>Error: Invalid request — please try again from the authorization link</p>', 400);
  }

  let authSession = await getAuthSession(env, authSessionId);
  if (!authSession || !constantTimeEqual(authSession.csrf_token || '', csrfToken || '')) {
    const signedSession = await verifyAuthSession(env, authSessionToken);
    const signedSessionFresh = signedSession
      && typeof signedSession.issued_at === 'number'
      && Date.now() - signedSession.issued_at <= CSRF_TTL * 1000;
    if (signedSessionFresh && constantTimeEqual(signedSession.csrf_token || '', csrfToken || '')) {
      authSession = signedSession;
    } else {
      authSession = null;
    }
  }
  if (!authSession || !constantTimeEqual(authSession.csrf_token || '', csrfToken || '')) {
    return html('<p>Error: Invalid request — please try again from the authorization link</p>', 400);
  }

  let client;
  try {
    const clientRaw = await env.PCP.get(`oauth:client:${authSession.client_id}`);
    if (!clientRaw) {
      return html('<p>Error: Invalid request</p>', 400);
    }
    client = JSON.parse(clientRaw);
  } catch {
    return html('<p>Error: Invalid request</p>', 400);
  }

  if (!client.redirect_uris.includes(authSession.redirect_uri)) {
    return html('<p>Error: Invalid request</p>', 400);
  }

  if (!constantTimeEqual(token, env.PCP_TOKEN)) {
    const {
      authSessionId: newAuthSessionId,
      csrfToken: newCsrf,
      authSessionToken: newAuthSessionToken,
    } = await createAuthSession(env, {
      client_id: authSession.client_id,
      redirect_uri: authSession.redirect_uri,
      state: authSession.state,
      code_challenge: authSession.code_challenge,
      code_challenge_method: authSession.code_challenge_method,
    });
    await env.PCP.delete(`auth:session:${authSessionId}`);
    return authorizePage(client.name, newAuthSessionId, newCsrf, newAuthSessionToken, 'Invalid token — please try again');
  }

  await env.PCP.delete(`auth:session:${authSessionId}`);

  const code = randomHex(32);
  await env.PCP.put(
    `oauth:code:${code}`,
    JSON.stringify({
      client_id: authSession.client_id,
      redirect_uri: authSession.redirect_uri,
      created_at: Date.now(),
      code_challenge: authSession.code_challenge || null,
      code_challenge_method: authSession.code_challenge_method || null,
    }),
    { expirationTtl: CODE_TTL },
  );

  const location = new URL(authSession.redirect_uri);
  location.searchParams.set('code', code);
  if (authSession.state) location.searchParams.set('state', authSession.state);

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

  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier } = params;

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

  if (!client.client_secret || !client_secret || !constantTimeEqual(client.client_secret, client_secret)) {
    return oauthError('invalid_client', 'Authentication failed', 401);
  }

  const codeKey = `oauth:code:${code}`;
  const codeRaw = await env.PCP.get(codeKey);
  if (!codeRaw) {
    return oauthError('invalid_grant', 'Authorization code expired or invalid');
  }

  let codeData;
  try {
    codeData = JSON.parse(codeRaw);
  } catch {
    return oauthError('invalid_grant', 'Authorization code expired or invalid');
  }

  if (codeData.client_id !== client_id || codeData.redirect_uri !== redirect_uri) {
    return oauthError('invalid_grant', 'Code does not match client or redirect_uri');
  }

  // PKCE verification (RFC 7636)
  if (codeData.code_challenge) {
    if (!code_verifier) {
      return oauthError('invalid_grant', 'code_verifier required');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier));
    const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (computed !== codeData.code_challenge) {
      return oauthError('invalid_grant', 'code_verifier mismatch');
    }
  }

  // Atomic single-use claim via Durable Object
  const doId = env.CODE_REDEMPTION.idFromName(code);
  const stub = env.CODE_REDEMPTION.get(doId);
  const claimRes = await stub.fetch(new Request('https://do/claim', { method: 'POST' }));
  const claimData = await claimRes.json();
  if (!claimData.ok) {
    return oauthError('invalid_grant', 'Authorization code already used');
  }

  await env.PCP.delete(codeKey);

  const accessToken = `pcp_oauth_${randomHex(32)}`;
  const tokenHash = await hashToken(accessToken);
  await env.PCP.put(
    `oauth:token:${tokenHash}`,
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

export async function handleRevoke(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let params;

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      params = Object.fromEntries(form.entries());
    } else if (contentType.includes('application/json')) {
      params = await request.json();
    } else {
      params = {};
    }
  } catch {
    return oauthError('invalid_request', 'Malformed request body');
  }

  const tokenToRevoke = params.token;
  if (!tokenToRevoke) {
    return oauthError('invalid_request', 'Missing token parameter');
  }

  // Authenticate: PCP_TOKEN (admin) or client_id + client_secret
  const authHeader = request.headers.get('Authorization');
  let authenticated = false;
  let authenticatedClientId = null;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && constantTimeEqual(parts[1], env.PCP_TOKEN)) {
      authenticated = true;
      // admin: authenticatedClientId stays null, can revoke any token
    }
  }

  if (!authenticated && params.client_id && params.client_secret) {
    try {
      const clientRaw = await env.PCP.get(`oauth:client:${params.client_id}`);
      if (clientRaw) {
        const client = JSON.parse(clientRaw);
        if (client.client_secret && params.client_secret && constantTimeEqual(client.client_secret, params.client_secret)) {
          authenticated = true;
          authenticatedClientId = params.client_id;
        }
      }
    } catch (err) {
      console.error('Revoke client lookup failed:', err.message || err);
    }
  }

  if (!authenticated) {
    return oauthError('invalid_client', 'Authentication failed', 401);
  }

  // Enforce client boundary: non-admin can only revoke own tokens
  const revokeHash = await hashToken(tokenToRevoke);
  // Check hashed key first, then legacy plaintext key
  let tokenRaw = await env.PCP.get(`oauth:token:${revokeHash}`);
  let legacyKey = null;
  if (!tokenRaw && tokenToRevoke.startsWith('pcp_oauth_')) {
    tokenRaw = await env.PCP.get(`oauth:token:${tokenToRevoke}`);
    if (tokenRaw) legacyKey = `oauth:token:${tokenToRevoke}`;
  }
  if (authenticatedClientId !== null && tokenRaw) {
    try {
      const tokenData = JSON.parse(tokenRaw);
      if (tokenData.client_id !== authenticatedClientId) {
        // RFC 7009: return 200 to avoid leaking token existence
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    } catch {
      // Corrupt token data — allow deletion as cleanup
    }
  }

  // RFC 7009: always return 200, even if token doesn't exist
  await env.PCP.delete(`oauth:token:${revokeHash}`);
  if (legacyKey) await env.PCP.delete(legacyKey);

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
