import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleRevoke } from '../src/handlers/oauth.js';

const CLIENT_A = 'revoke-client-a';
const CLIENT_B = 'revoke-client-b';
const SECRET_A = 'revoke-secret-a';
const SECRET_B = 'revoke-secret-b';
const PCP_TOKEN = env.PCP_TOKEN || 'test-pcp-token';

beforeAll(async () => {
  await env.PCP.put(`oauth:client:${CLIENT_A}`, JSON.stringify({
    name: 'Revoke Client A', client_secret: SECRET_A, redirect_uris: [],
  }));
  await env.PCP.put(`oauth:client:${CLIENT_B}`, JSON.stringify({
    name: 'Revoke Client B', client_secret: SECRET_B, redirect_uris: [],
  }));
});

function revokeRequest(token, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.bearer) headers['Authorization'] = `Bearer ${auth.bearer}`;
  const body = { token };
  if (auth.client_id) body.client_id = auth.client_id;
  if (auth.client_secret) body.client_secret = auth.client_secret;
  return new Request('https://host/oauth/revoke', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

describe('/oauth/revoke — client boundary', () => {
  it('client can revoke own token', async () => {
    const tokenValue = 'pcp_oauth_own_token_test';
    await env.PCP.put(`oauth:token:${tokenValue}`, JSON.stringify({ client_id: CLIENT_A, platform: 'test', created_at: Date.now() }));

    const res = await handleRevoke(revokeRequest(tokenValue, { client_id: CLIENT_A, client_secret: SECRET_A }), env);
    expect(res.status).toBe(200);
    const remaining = await env.PCP.get(`oauth:token:${tokenValue}`);
    expect(remaining).toBeNull();
  });

  it('client cannot revoke other client token — returns 200 but token persists', async () => {
    const tokenValue = 'pcp_oauth_cross_client_test';
    await env.PCP.put(`oauth:token:${tokenValue}`, JSON.stringify({ client_id: CLIENT_A, platform: 'test', created_at: Date.now() }));

    const res = await handleRevoke(revokeRequest(tokenValue, { client_id: CLIENT_B, client_secret: SECRET_B }), env);
    expect(res.status).toBe(200); // RFC 7009
    const remaining = await env.PCP.get(`oauth:token:${tokenValue}`);
    expect(remaining).not.toBeNull(); // Token still exists
  });

  it('PCP_TOKEN (admin) can revoke any token', async () => {
    const tokenValue = 'pcp_oauth_admin_revoke_test';
    await env.PCP.put(`oauth:token:${tokenValue}`, JSON.stringify({ client_id: CLIENT_A, platform: 'test', created_at: Date.now() }));

    const res = await handleRevoke(revokeRequest(tokenValue, { bearer: PCP_TOKEN }), env);
    expect(res.status).toBe(200);
    const remaining = await env.PCP.get(`oauth:token:${tokenValue}`);
    expect(remaining).toBeNull();
  });
});
