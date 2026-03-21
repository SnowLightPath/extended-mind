import { authenticateWithOAuth } from './utils/auth.js';
import { tools } from './tools.js';
import { handleGet } from './handlers/get.js';
import { handlePut } from './handlers/put.js';
import { handleAuthorizeGet, handleAuthorizePost, handleToken } from './handlers/oauth.js';
const SERVER_INFO = { name: 'extended-mind', version: '1.0.0' };

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

    // Webhook (signature-verified when WEBHOOK_SECRET is set)
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
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
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
        const clientVersion = body.params?.protocolVersion || 'unknown';
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
              return rpcOk(body.id, await handleGet(env));
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
    try {
      const { getFile } = await import('./services/github.js');
      const file = await getFile(env, 'seed/core.yaml');
      if (!file) return;

      const lastSha = await env.PCP.get('_core_sha');
      if (file.sha !== lastSha) {
        await env.PCP.put('core', file.content);
        await env.PCP.put('_core_sha', file.sha);
        console.log('Core synced via cron (SHA changed)');
      }
    } catch (err) {
      console.error('Cron sync failed:', err.message);
    }
  },
};
