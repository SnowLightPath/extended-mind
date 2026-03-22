import { server } from '@passwordless-id/webauthn';
import { getAuthSession } from '../utils/auth.js';

const CHALLENGE_TTL = 300;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function enrollPage(clientId, redirectUri, state, csrfToken) {
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extended Mind — パスキー登録</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 1.3em; }
  p { color: #666; line-height: 1.5; }
  .btn { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; margin-top: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .btn:hover { background: #1d4ed8; }
  .skip { display: block; text-align: center; margin-top: 16px; color: #666; text-decoration: none; font-size: 0.9em; }
  .skip:hover { color: #333; }
</style>
</head>
<body>
<h1>Extended Mind</h1>
<p>次回から Touch ID でサインインできます。</p>
<button class="btn" id="registerBtn">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h2a5 5 0 010 10h-2m-6 0H7A5 5 0 017 7h2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
  パスキーを登録
</button>
<a href="#" class="skip" id="skipBtn">スキップ</a>
<script>
const clientId = ${JSON.stringify(clientId)};
const redirectUri = ${JSON.stringify(redirectUri)};
const state = ${JSON.stringify(state || '')};
const csrfToken = ${JSON.stringify(csrfToken)};

document.getElementById('registerBtn').addEventListener('click', async () => {
  try {
    const beginRes = await fetch('/oauth/authorize/webauthn/register/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state, csrf_token: csrfToken })
    });
    const beginData = await beginRes.json();
    if (!beginRes.ok) { alert(beginData.error || 'Error'); return; }

    const options = {
      publicKey: {
        challenge: Uint8Array.from(atob(beginData.challenge.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)),
        rp: { name: beginData.rp.name, id: beginData.rp.id },
        user: {
          id: Uint8Array.from(atob(beginData.user.id.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)),
          name: beginData.user.name,
          displayName: beginData.user.displayName
        },
        pubKeyCredParams: beginData.pubKeyCredParams,
        authenticatorSelection: beginData.authenticatorSelection,
        timeout: beginData.timeout,
        attestation: 'none'
      }
    };

    const credential = await navigator.credentials.create(options);
    const response = credential.response;

    function bufToBase64url(buf) {
      const bytes = new Uint8Array(buf);
      let str = '';
      for (const b of bytes) str += String.fromCharCode(b);
      return btoa(str).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
    }

    const registration = {
      id: credential.id,
      rawId: bufToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        attestationObject: bufToBase64url(response.attestationObject),
        clientDataJSON: bufToBase64url(response.clientDataJSON),
        authenticatorData: bufToBase64url(response.getAuthenticatorData()),
        publicKey: bufToBase64url(response.getPublicKey()),
        publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
        transports: response.getTransports ? response.getTransports() : []
      },
      user: { name: beginData.user.name, displayName: beginData.user.displayName }
    };

    const verifyRes = await fetch('/oauth/authorize/webauthn/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration, challenge_id: beginData.challenge_id, client_id: clientId, redirect_uri: redirectUri, state, csrf_token: csrfToken })
    });
    const verifyData = await verifyRes.json();
    if (verifyRes.ok && verifyData.redirect) {
      window.location.href = verifyData.redirect;
    } else {
      alert(verifyData.error || 'Registration failed');
    }
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Error: ' + e.message);
  }
});

document.getElementById('skipBtn').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const res = await fetch('/oauth/authorize/webauthn/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state, csrf_token: csrfToken })
  });
  const data = await res.json();
  if (res.ok && data.redirect) {
    window.location.href = data.redirect;
  }
});
</script>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function handleRegisterBegin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { auth_session_id, csrf_token } = body;

  // Auth session flow (from OAuth authorize page)
  if (auth_session_id) {
    const authSession = await getAuthSession(env, auth_session_id);
    if (!authSession || authSession.csrf_token !== csrf_token) {
      return jsonResponse({ error: 'Invalid auth session' }, 400);
    }
  } else if (csrf_token) {
    // Standalone /passkey flow (uses csrf: key)
    const csrfValid = await env.PCP.get(`csrf:${csrf_token}`);
    if (csrfValid === null) return jsonResponse({ error: 'Invalid CSRF token' }, 400);
  } else {
    return jsonResponse({ error: 'Missing authentication' }, 400);
  }

  const url = new URL(request.url);
  const rpId = url.hostname;
  const challenge = server.randomChallenge();
  const challengeId = randomHex(16);

  await env.PCP.put(
    `webauthn:challenge:${challengeId}`,
    JSON.stringify({ challenge, type: 'register', auth_session_id: auth_session_id || null }),
    { expirationTtl: CHALLENGE_TTL },
  );

  const userId = btoa('extended-mind-user')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return jsonResponse({
    challenge,
    challenge_id: challengeId,
    rp: { name: 'Extended Mind', id: rpId },
    user: { id: userId, name: 'Extended Mind User', displayName: 'Extended Mind User' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    timeout: 300000,
  });
}

export async function handleRegisterVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { registration, challenge_id } = body;

  const challengeRaw = await env.PCP.get(`webauthn:challenge:${challenge_id}`);
  if (!challengeRaw) return jsonResponse({ error: 'Challenge expired' }, 400);

  let challengeData;
  try {
    challengeData = JSON.parse(challengeRaw);
  } catch {
    return jsonResponse({ error: 'Invalid challenge' }, 400);
  }
  await env.PCP.delete(`webauthn:challenge:${challenge_id}`);

  if (challengeData.type !== 'register') return jsonResponse({ error: 'Wrong challenge type' }, 400);

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  let registrationInfo;
  try {
    registrationInfo = await server.verifyRegistration(registration, {
      challenge: challengeData.challenge,
      origin,
      userVerified: true,
      domain: url.hostname,
    });
  } catch (e) {
    return jsonResponse({ error: 'Verification failed: ' + e.message }, 400);
  }

  await env.PCP.put(
    `webauthn:credential:${registrationInfo.credential.id}`,
    JSON.stringify({
      publicKey: registrationInfo.credential.publicKey,
      algorithm: registrationInfo.credential.algorithm,
      counter: registrationInfo.authenticator.counter,
      transports: registrationInfo.credential.transports,
      registered_at: new Date().toISOString(),
    }),
  );

  // Standalone registration (no OAuth redirect)
  const authSession = challengeData.auth_session_id
    ? await getAuthSession(env, challengeData.auth_session_id)
    : null;

  if (!authSession || !authSession.redirect_uri) {
    return jsonResponse({ ok: true, credential_id: registrationInfo.credential.id });
  }

  const code = randomHex(32);
  await env.PCP.put(
    `oauth:code:${code}`,
    JSON.stringify({
      client_id: authSession.client_id,
      redirect_uri: authSession.redirect_uri,
      created_at: Date.now(),
    }),
    { expirationTtl: 600 },
  );

  const location = new URL(authSession.redirect_uri);
  location.searchParams.set('code', code);
  if (authSession.state) location.searchParams.set('state', authSession.state);
  await env.PCP.delete(`auth:session:${challengeData.auth_session_id}`);

  return jsonResponse({ redirect: location.toString() });
}

export async function handleAuthVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { authentication, challenge_id } = body;

  const challengeRaw = await env.PCP.get(`webauthn:challenge:${challenge_id}`);
  if (!challengeRaw) return jsonResponse({ error: 'Challenge expired' }, 400);

  let challengeData;
  try {
    challengeData = JSON.parse(challengeRaw);
  } catch {
    return jsonResponse({ error: 'Invalid challenge' }, 400);
  }
  await env.PCP.delete(`webauthn:challenge:${challenge_id}`);

  if (challengeData.type !== 'authenticate') return jsonResponse({ error: 'Wrong challenge type' }, 400);

  const credentialRaw = await env.PCP.get(`webauthn:credential:${authentication.id}`);
  if (!credentialRaw) return jsonResponse({ error: 'Unknown credential' }, 400);

  let credentialData;
  try {
    credentialData = JSON.parse(credentialRaw);
  } catch {
    return jsonResponse({ error: 'Invalid credential data' }, 400);
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  let authInfo;
  try {
    authInfo = await server.verifyAuthentication(
      authentication,
      { id: authentication.id, publicKey: credentialData.publicKey, algorithm: credentialData.algorithm, transports: credentialData.transports },
      { challenge: challengeData.challenge, origin, userVerified: true, counter: credentialData.counter, domain: url.hostname },
    );
  } catch (e) {
    return jsonResponse({ error: 'Verification failed: ' + e.message }, 400);
  }

  await env.PCP.put(
    `webauthn:credential:${authentication.id}`,
    JSON.stringify({ ...credentialData, counter: authInfo.counter }),
  );

  const authSession = await getAuthSession(env, challengeData.auth_session_id);
  if (!authSession) return jsonResponse({ error: 'Invalid auth session' }, 400);

  const code = randomHex(32);
  await env.PCP.put(
    `oauth:code:${code}`,
    JSON.stringify({
      client_id: authSession.client_id,
      redirect_uri: authSession.redirect_uri,
      created_at: Date.now(),
    }),
    { expirationTtl: 600 },
  );

  const location = new URL(authSession.redirect_uri);
  location.searchParams.set('code', code);
  if (authSession.state) location.searchParams.set('state', authSession.state);
  await env.PCP.delete(`auth:session:${challengeData.auth_session_id}`);

  return jsonResponse({ redirect: location.toString() });
}

export async function handleAuthBegin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { auth_session_id } = body;
  const authSession = await getAuthSession(env, auth_session_id);
  if (!authSession) return jsonResponse({ error: 'Invalid auth session' }, 400);

  const challenge = server.randomChallenge();
  const challengeId = randomHex(16);

  await env.PCP.put(
    `webauthn:challenge:${challengeId}`,
    JSON.stringify({ challenge, type: 'authenticate', auth_session_id }),
    { expirationTtl: CHALLENGE_TTL },
  );

  return jsonResponse({
    challenge,
    challenge_id: challengeId,
    timeout: 300000,
    rpId: new URL(request.url).hostname,
    userVerification: 'required',
  });
}

export async function handleSkip(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { auth_session_id, csrf_token } = body;
  const authSession = await getAuthSession(env, auth_session_id);
  if (!authSession || authSession.csrf_token !== csrf_token) {
    return jsonResponse({ error: 'Invalid auth session' }, 400);
  }

  const code = randomHex(32);
  await env.PCP.put(
    `oauth:code:${code}`,
    JSON.stringify({
      client_id: authSession.client_id,
      redirect_uri: authSession.redirect_uri,
      created_at: Date.now(),
    }),
    { expirationTtl: 600 },
  );

  const location = new URL(authSession.redirect_uri);
  location.searchParams.set('code', code);
  if (authSession.state) location.searchParams.set('state', authSession.state);
  await env.PCP.delete(`auth:session:${auth_session_id}`);

  return jsonResponse({ redirect: location.toString() });
}

function passkeyManagePage() {
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extended Mind — パスキー管理</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 1.3em; }
  p { color: #666; line-height: 1.5; }
  .error { color: #c00; font-size: 0.9em; margin-bottom: 12px; }
  .success { color: #16a34a; font-size: 0.9em; margin-bottom: 12px; }
  label { display: block; font-size: 0.9em; margin-bottom: 4px; color: #555; }
  input[type=password] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; box-sizing: border-box; }
  .btn { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; margin-top: 16px; }
  .btn:hover { background: #1d4ed8; }
  .btn:disabled { background: #93c5fd; cursor: not-allowed; }
  #step2 { display: none; }
</style>
</head>
<body>
<h1>Extended Mind — パスキー管理</h1>
<div id="step1">
<p>PCP Token を入力してパスキーを登録します。</p>
<label for="token">PCP Token</label>
<input type="password" id="token" required placeholder="Enter your PCP token">
<button class="btn" id="authBtn">認証</button>
<div id="authError" class="error" style="display:none;margin-top:8px;"></div>
</div>
<div id="step2">
<p>Touch ID でパスキーを登録します。</p>
<button class="btn" id="registerBtn">パスキーを登録</button>
<div id="regMsg" style="display:none;margin-top:8px;"></div>
</div>
<script>
document.getElementById('authBtn').addEventListener('click', async () => {
  const token = document.getElementById('token').value;
  if (!token) return;
  const res = await fetch('/passkey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'auth', token })
  });
  const data = await res.json();
  if (!res.ok) {
    const el = document.getElementById('authError');
    el.textContent = data.error || 'Authentication failed';
    el.style.display = 'block';
    return;
  }
  window._passkeySession = data.session_token;
  document.getElementById('step1').style.display = 'none';
  document.getElementById('step2').style.display = 'block';
});

document.getElementById('registerBtn').addEventListener('click', async () => {
  try {
    const beginRes = await fetch('/oauth/authorize/webauthn/register/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrf_token: window._passkeySession })
    });
    const beginData = await beginRes.json();
    if (!beginRes.ok) { alert(beginData.error || 'Error'); return; }

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

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(beginData.challenge),
        rp: { name: beginData.rp.name, id: beginData.rp.id },
        user: {
          id: b64urlToBytes(beginData.user.id),
          name: beginData.user.name,
          displayName: beginData.user.displayName
        },
        pubKeyCredParams: beginData.pubKeyCredParams,
        authenticatorSelection: beginData.authenticatorSelection,
        timeout: beginData.timeout,
        attestation: 'none'
      }
    });

    const response = credential.response;
    const registration = {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        attestationObject: bytesToB64url(response.attestationObject),
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        authenticatorData: bytesToB64url(response.getAuthenticatorData()),
        publicKey: bytesToB64url(response.getPublicKey()),
        publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
        transports: response.getTransports ? response.getTransports() : []
      },
      user: { name: beginData.user.name, displayName: beginData.user.displayName }
    };

    const verifyRes = await fetch('/oauth/authorize/webauthn/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration, challenge_id: beginData.challenge_id })
    });
    const verifyData = await verifyRes.json();
    const el = document.getElementById('regMsg');
    if (verifyRes.ok) {
      el.className = 'success';
      el.textContent = 'パスキーを登録しました。次回から Touch ID でサインインできます。';
    } else {
      el.className = 'error';
      el.textContent = verifyData.error || 'Registration failed';
    }
    el.style.display = 'block';
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Error: ' + e.message);
  }
});
</script>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function handlePasskeyEnroll(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (body.action === 'auth') {
    if (body.token !== env.PCP_TOKEN) {
      return jsonResponse({ error: 'Invalid token' }, 401);
    }
    const sessionToken = randomHex(16);
    await env.PCP.put(`csrf:${sessionToken}`, '{}', { expirationTtl: 600 });
    return jsonResponse({ session_token: sessionToken });
  }

  return jsonResponse({ error: 'Unknown action' }, 400);
}

export { enrollPage, passkeyManagePage, handlePasskeyEnroll };
