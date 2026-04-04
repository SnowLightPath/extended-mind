import { authenticateWithOAuth, constantTimeEqual } from './utils/auth.js';
import { checkRateLimit, FAILURE_WEIGHT } from './utils/rate-limit.js';
import { tools } from './tools.js';
import { handleGet } from './handlers/get.js';
import { handlePut } from './handlers/put.js';
import { handleAuthorizeGet, handleAuthorizePost, handleToken, handleRevoke } from './handlers/oauth.js';
export { CodeRedemption } from './do/code-redemption.js';
export { WriteSerializer } from './do/write-serializer.js';
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function rpcOk(id, result, extraHeaders = {}) {
  return json({ jsonrpc: '2.0', id, result }, 200, extraHeaders);
}

function rpcErr(id, code, message) {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}

const PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

async function signSessionId(env, payload) {
  const data = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.PCP_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigHex = Array.from(new Uint8Array(sig)).slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(data + '.' + sigHex);
}

async function verifySessionId(env, sid) {
  try {
    const decoded = atob(sid);
    const dotIdx = decoded.lastIndexOf('.');
    if (dotIdx === -1) return null;
    const data = decoded.slice(0, dotIdx);
    const sig = decoded.slice(dotIdx + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.PCP_TOKEN),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    const expectedHex = Array.from(new Uint8Array(expected)).slice(0, 16)
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (!constantTimeEqual(sig, expectedHex)) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function getPlatform(request, env, oauthPlatform) {
  if (oauthPlatform && PLATFORM_RE.test(oauthPlatform)) return oauthPlatform;
  if (oauthPlatform) return 'unknown';
  const sid = request.headers.get('mcp-session-id');
  if (!sid) return 'unknown';
  const payload = await verifySessionId(env, sid);
  if (payload && payload.p && PLATFORM_RE.test(payload.p)) return payload.p;
  return 'unknown';
}

async function syncCore(env) {
  try {
    const { getFile } = await import('./services/github.js');
    const file = await getFile(env, 'seed/core.yaml');
    if (!file) return;

    const lastSha = await env.PCP.get('_core_sha');
    if (file.sha !== lastSha) {
      await env.PCP.put('core', file.content);
      await env.PCP.put('_core_sha', file.sha);
      const { invalidateCache } = await import('./utils/cache.js');
      await invalidateCache(env);
      console.log('Core synced via cron (SHA changed)');
    }
  } catch (err) {
    console.error('Cron core sync failed:', err.message);
  }
}

// Queue consumer handlers (exported for testability)
export async function handleClassifyMessage(env, { message, timestamp, platform }) {
  const { classifyMessage } = await import('./services/classify.js');
  const { writeAction } = await import('./utils/write.js');
  const activeRaw = await env.PCP.get('active');
  const active = JSON.parse(activeRaw || '{"entries":[],"conflicts":[]}');
  const result = await classifyMessage(env, message, active, timestamp);
  await writeAction(env, 'apply_classification', { result, timestamp, message });
  if (result.new_entries?.length > 0 || result.new_conflicts?.length > 0 || result.tag_changes?.length > 0) {
    await env.PCP.put('_sweep_dirty', 'true');
  }
}

export async function handleGitHubMessage(env, { message, timestamp, platform }) {
  const { getFile, putFile } = await import('./services/github.js');
  const { mirrorActiveJson, hashIdempotencyKey } = await import('./handlers/put.js');
  const date = timestamp.split('T')[0];
  const yearMonth = date.slice(0, 7);
  const sessionPath = `sessions/${yearMonth}/${date}_${platform}.md`;
  const existing = await getFile(env, sessionPath);
  const sha = existing?.sha ?? null;

  const idempotencyKey = await hashIdempotencyKey(message, timestamp, platform);
  const marker = `<!-- ${idempotencyKey} -->`;
  if (existing?.content.includes(marker)) return;

  const newEntry = `\n---\n${marker}\n_${timestamp}_\n\n${message}`;
  const content = existing
    ? existing.content + newEntry
    : `# Session: ${date} (${platform})\n${newEntry}`;
  await putFile(env, sessionPath, content, `log from ${platform} at ${timestamp} (deferred)`, sha);
  await mirrorActiveJson(env, putFile, platform);
}

export async function handleGitHubMirrorMessage(env, { platform }) {
  const { putFile } = await import('./services/github.js');
  const { mirrorActiveJson } = await import('./handlers/put.js');
  await mirrorActiveJson(env, putFile, platform);
}

// KV fallback drain — moves stale KV items into Queues
async function drainKvFallback(env) {
  const { writeAction } = await import('./utils/write.js');
  // peek → send → dequeue: item stays in KV until Queue accepts it
  for (const [peekAction, dequeueAction, queue, isMirror] of [
    ['peek_pending', 'dequeue_pending', env.QUEUE_CLASSIFY, false],
    ['peek_github', 'dequeue_github', env.QUEUE_GITHUB, false],
    ['peek_github_mirror', 'dequeue_github_mirror', env.QUEUE_GITHUB_MIRROR, true],
  ]) {
    try {
      const res = await writeAction(env, peekAction);
      const item = isMirror ? res.platform : res.item;
      if (!item) continue;
      const payload = isMirror ? { platform: item } : item;
      await queue.send(payload);
      // Only dequeue after successful send
      await writeAction(env, dequeueAction);
    } catch (err) {
      // Item stays in KV — will retry next cron cycle
      console.error(`KV drain ${peekAction} failed:`, err.message);
    }
  }
}

async function consistencySweep(env) {
  try {
    const { writeAction } = await import('./utils/write.js');

    // GC step via DO (serialized read-modify-write)
    const gcResult = await writeAction(env, 'gc_active');
    if (gcResult.changed) {
      console.log('GC:', { entries: gcResult.entries, conflicts: gcResult.conflicts });
    }
    if (gcResult.needResweep) {
      await env.PCP.put('_sweep_dirty', 'true');
    }

    // LLM consistency check (only when dirty)
    const dirty = await env.PCP.get('_sweep_dirty');
    if (dirty !== 'true') return;

    const { classifySweep } = await import('./services/classify.js');
    const freshRaw = await env.PCP.get('active');
    if (!freshRaw) return;
    const freshActive = JSON.parse(freshRaw);

    const result = await classifySweep(env, freshActive);
    const hasChanges = result.tag_changes?.length > 0 || result.new_conflicts?.length > 0 || result.resolved_conflicts?.length > 0;
    if (hasChanges) {
      const applyResult = await writeAction(env, 'apply_classification', { result, timestamp: new Date().toISOString(), message: '[consistency sweep]' });
      console.log('Sweep:', { tag_changes: result.tag_changes?.length || 0, new_conflicts: result.new_conflicts?.length || 0 });
    }

    await env.PCP.put('_sweep_dirty', 'false');
  } catch (err) {
    console.error('Sweep failed:', err.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Icons (no auth required)
    if (url.pathname === '/icon.svg' && request.method === 'GET') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="28" fill="#534AB7"/>
    <text x="64" y="72" text-anchor="middle" font-family="system-ui" font-size="48" font-weight="bold" fill="white">EM</text>
  </svg>`;
      return new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
      });
    }
    if (url.pathname === '/icon.png' && request.method === 'GET') {
      const b64 = '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';
      const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new Response(buf, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Webhook (WEBHOOK_SECRET required, signature-verified)
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const { handleWebhook } = await import('./handlers/webhook.js');
      return handleWebhook(request, env, ctx);
    }

    // OAuth discovery (no auth required)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const issuer = `${url.protocol}//${url.host}`;
      return json({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        logo_uri: `${issuer}/icon.svg`,
      });
    }

    // Rate limit auth-related POST routes (OAuth, passkey, WebAuthn)
    if (request.method === 'POST' && (
      url.pathname === '/oauth/authorize' ||
      url.pathname === '/oauth/revoke' ||
      url.pathname === '/passkey' ||
      url.pathname.startsWith('/oauth/authorize/webauthn/')
    )) {
      const authIp = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!await checkRateLimit(env, authIp)) {
        return json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
      }
    }

    // OAuth routes (no bearer auth required)
    if (url.pathname === '/oauth/authorize') {
      if (request.method === 'GET') return handleAuthorizeGet(url, env);
      if (request.method === 'POST') return handleAuthorizePost(request, env);
      return json({ error: 'Method not allowed' }, 405);
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const tokenIp = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!await checkRateLimit(env, tokenIp)) {
        return json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
      }
      return handleToken(request, env);
    }
    if (url.pathname === '/oauth/revoke' && request.method === 'POST') {
      return handleRevoke(request, env);
    }
    // Passkey enrollment page (GET: public form, POST: PCP_TOKEN verified in handler)
    if (url.pathname === '/passkey') {
      if (request.method === 'GET') {
        const { passkeyManagePage } = await import('./handlers/webauthn.js');
        return passkeyManagePage();
      }
      if (request.method === 'POST') {
        const { handlePasskeyEnroll } = await import('./handlers/webauthn.js');
        return handlePasskeyEnroll(request, env);
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    if (url.pathname.startsWith('/oauth/authorize/webauthn/') && request.method === 'POST') {
      const { handleRegisterBegin, handleRegisterVerify, handleAuthBegin, handleAuthVerify } = await import('./handlers/webauthn.js');
      const sub = url.pathname.replace('/oauth/authorize/webauthn/', '');
      switch (sub) {
        case 'register/begin':
          return handleRegisterBegin(request, env);
        case 'register/verify':
          return handleRegisterVerify(request, env);
        case 'auth/begin':
          return handleAuthBegin(request, env);
        case 'auth/verify':
          return handleAuthVerify(request, env);
        default:
          return json({ error: 'Not found' }, 404);
      }
    }

    // MCP route
    if (url.pathname !== '/mcp') {
      return json({ error: 'Not found' }, 404);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    if (!await checkRateLimit(env, clientIp)) {
      return json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
    }

    const auth = await authenticateWithOAuth(request, env);
    if (!auth.ok) {
      await checkRateLimit(env, clientIp, FAILURE_WEIGHT);
      return json({ error: 'Unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return rpcErr(null, -32700, 'Parse error');
    }

    if (!body.jsonrpc || !body.method) {
      return rpcErr(body?.id ?? null, -32600, 'Invalid request');
    }

    switch (body.method) {
      case 'initialize': {
        const platform = body.params?.clientInfo?.name || 'unknown';
        const sessionId = await signSessionId(env, { p: auth.platform || platform });
        const baseUrl = `${url.protocol}//${url.host}`;
        return rpcOk(
          body.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'extended-mind',
              version: '2.0.0',
              title: 'Extended Mind',
              icons: [
                { src: `${baseUrl}/icon.png`, mimeType: 'image/png' },
                { src: `${baseUrl}/icon.svg`, mimeType: 'image/svg+xml' },
              ],
            },
          },
          { 'Mcp-Session-Id': sessionId },
        );
      }

      case 'notifications/initialized':
        return new Response(null, { status: 202 });

      case 'tools/list':
        return rpcOk(body.id, { tools });

      case 'tools/call': {
        const { name, arguments: args } = body.params || {};
        try {
          switch (name) {
            case 'context_get':
              return rpcOk(body.id, await handleGet(env, ctx));
            case 'context_log':
              return rpcOk(body.id, await handlePut(args || {}, env, await getPlatform(request, env, auth.platform), ctx));
            default:
              return rpcErr(body.id, -32602, `Unknown tool: ${name}`);
          }
        } catch (err) {
          console.error('RPC error:', err);
          const safeMessages = ['message must not be empty', 'message exceeds 50KB limit'];
          const text = safeMessages.includes(err.message) ? `Error: ${err.message}` : 'Error: Internal error';
          return rpcOk(body.id, {
            content: [{ type: 'text', text }],
            isError: true,
          });
        }
      }

      default:
        return rpcErr(body.id, -32601, 'Method not found');
    }
  },

  async scheduled(event, env, ctx) {
    await syncCore(env);
    await drainKvFallback(env);
    await consistencySweep(env);
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        switch (batch.queue) {
          case 'pending-classify':
            await handleClassifyMessage(env, msg.body);
            break;
          case 'pending-github':
            await handleGitHubMessage(env, msg.body);
            break;
          case 'pending-github-mirror':
            await handleGitHubMirrorMessage(env, msg.body);
            break;
        }
        msg.ack();
      } catch (err) {
        console.error(`Queue ${batch.queue} failed:`, err.message);
        msg.retry();
      }
    }
  },
};
