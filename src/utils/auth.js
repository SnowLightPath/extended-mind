export async function authenticateWithOAuth(request, env) {
  const header = request.headers.get('Authorization');
  if (!header) return { ok: false };
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return { ok: false };

  const token = parts[1];

  if (token === env.PCP_TOKEN) {
    return { ok: true, platform: 'claude-code' };
  }

  const tokenRaw = await env.PCP.get(`oauth:token:${token}`);
  if (tokenRaw) {
    const data = JSON.parse(tokenRaw);
    return { ok: true, platform: data.platform };
  }

  return { ok: false };
}
