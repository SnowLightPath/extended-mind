export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function authenticateWithOAuth(request, env) {
  const header = request.headers.get('Authorization');
  if (!header) return { ok: false };
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return { ok: false };

  const token = parts[1];

  if (constantTimeEqual(token, env.PCP_TOKEN)) {
    return { ok: true, platform: 'claude-code' };
  }

  const tokenHash = await hashToken(token);
  const tokenRaw = await env.PCP.get(`oauth:token:${tokenHash}`);
  if (tokenRaw) {
    try {
      const data = JSON.parse(tokenRaw);
      return { ok: true, platform: data.platform };
    } catch {
      console.error('Corrupt oauth token data in KV:', token.slice(0, 8) + '...');
      return { ok: false };
    }
  }

  // Backward compat: try plaintext key (pre-hash migration) and migrate
  if (token.startsWith('pcp_oauth_')) {
    const legacyRaw = await env.PCP.get(`oauth:token:${token}`);
    if (legacyRaw) {
      try {
        const data = JSON.parse(legacyRaw);
        const TOKEN_TTL = 7776000; // 90 days — match oauth.js
        const elapsed = data.created_at ? Math.floor((Date.now() - data.created_at) / 1000) : 0;
        const ttl = Math.max(TOKEN_TTL - elapsed, 60);
        await env.PCP.put(`oauth:token:${tokenHash}`, legacyRaw, { expirationTtl: ttl });
        await env.PCP.delete(`oauth:token:${token}`);
        return { ok: true, platform: data.platform };
      } catch {
        return { ok: false };
      }
    }
  }

  return { ok: false };
}

export async function getAuthSession(env, authSessionId) {
  if (!authSessionId) return null;
  const raw = await env.PCP.get(`auth:session:${authSessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
