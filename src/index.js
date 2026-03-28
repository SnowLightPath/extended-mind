import { authenticateWithOAuth } from './utils/auth.js';
import { tools } from './tools.js';
import { handleGet } from './handlers/get.js';
import { handlePut } from './handlers/put.js';
import { handleAuthorizeGet, handleAuthorizePost, handleToken, handleRevoke } from './handlers/oauth.js';
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

function getPlatform(request, oauthPlatform) {
  if (oauthPlatform) return oauthPlatform;
  const sid = request.headers.get('mcp-session-id');
  if (!sid) return 'unknown';
  try {
    return JSON.parse(atob(sid)).p || 'unknown';
  } catch {
    return 'unknown';
  }
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

async function processPending(env) {
  try {
    const raw = await env.PCP.get('pending_classify');
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (queue.length === 0) return;

    const { classifyMessage } = await import('./services/classify.js');
    const { applyClassification } = await import('./handlers/put.js');

    const item = queue.shift();
    await env.PCP.put('pending_classify', JSON.stringify(queue));

    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw || '{}');

    const result = await classifyMessage(env, item.message, active);
    await applyClassification(env, result, item.message, item.timestamp, item.platform);

    console.log('Cron: classified pending from', item.platform, item.timestamp);
  } catch (err) {
    console.error('Cron classify failed:', err.message);
  }
}

async function consistencySweep(env) {
  try {
    // Only sweep when new data arrived via context_log
    const dirty = await env.PCP.get('_sweep_dirty');
    if (dirty !== 'true') return;

    const activeRaw = await env.PCP.get('active');
    if (!activeRaw) return;
    const active = JSON.parse(activeRaw);

    const { classifySweep } = await import('./services/classify.js');
    const { applyClassification } = await import('./handlers/put.js');

    const result = await classifySweep(env, active);

    if (result.active_updates?.length > 0 || result.contradictions?.length > 0) {
      await applyClassification(env, result, '[consistency sweep]', new Date().toISOString(), 'cron');
      console.log('Sweep:', {
        updates: result.active_updates?.length || 0,
        contradictions: result.contradictions?.length || 0,
      });
    }

    // Always clear after sweep — next context_log will re-set if needed
    await env.PCP.put('_sweep_dirty', 'false');
  } catch (err) {
    console.error('Sweep failed:', err.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Icon (no auth required)
    if (url.pathname === '/icon.svg' && request.method === 'GET') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="28" fill="#534AB7"/>
    <text x="64" y="72" text-anchor="middle" font-family="system-ui" font-size="48" font-weight="bold" fill="white">EM</text>
  </svg>`;
      return new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400',
        },
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
        logo_uri: `${issuer}/icon.svg`,
      });
    }

    // OAuth routes (no bearer auth required)
    if (url.pathname === '/oauth/authorize') {
      if (request.method === 'GET') return handleAuthorizeGet(url, env);
      if (request.method === 'POST') return handleAuthorizePost(request, env);
      return json({ error: 'Method not allowed' }, 405);
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
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
      const { handleRegisterBegin, handleRegisterVerify, handleAuthBegin, handleAuthVerify, handleSkip } = await import('./handlers/webauthn.js');
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
        case 'skip':
          return handleSkip(request, env);
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

    const auth = await authenticateWithOAuth(request, env);
    if (!auth.ok) {
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
        const sessionId = btoa(JSON.stringify({ p: auth.platform || platform }));
        const iconUrl = `${url.protocol}//${url.host}/icon.svg`;
        return rpcOk(
          body.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'extended-mind',
              version: '1.0.0',
              title: 'Extended Mind',
              icons: [{ src: iconUrl }],
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
              return rpcOk(body.id, await handlePut(args || {}, env, getPlatform(request, auth.platform), ctx));
            default:
              return rpcErr(body.id, -32602, `Unknown tool: ${name}`);
          }
        } catch (err) {
          return rpcOk(body.id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
      }

      default:
        return rpcErr(body.id, -32601, 'Method not found');
    }
  },

  async scheduled(event, env, ctx) {
    await Promise.allSettled([syncCore(env), processPending(env), consistencySweep(env)]);
  },
};
