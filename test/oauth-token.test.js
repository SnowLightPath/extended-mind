import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleToken } from '../src/handlers/oauth.js';

const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';
const SECRET_A = 'secret-a';
const SECRET_B = 'secret-b';
const REDIRECT = 'https://example.com/callback';

beforeAll(async () => {
  await env.PCP.put(`oauth:client:${CLIENT_A}`, JSON.stringify({
    name: 'Test Client A', client_secret: SECRET_A, redirect_uris: [REDIRECT],
  }));
  await env.PCP.put(`oauth:client:${CLIENT_B}`, JSON.stringify({
    name: 'Test Client B', client_secret: SECRET_B, redirect_uris: [REDIRECT],
  }));
});

function makeCode(clientId = CLIENT_A) {
  const code = crypto.randomUUID();
  return { code, data: { client_id: clientId, redirect_uri: REDIRECT, created_at: Date.now() } };
}

async function storeCode(code, data) {
  await env.PCP.put(`oauth:code:${code}`, JSON.stringify(data));
}

function tokenRequest(params) {
  return new Request('https://host/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', ...params }),
  });
}

describe('/oauth/token — authorization code exchange', () => {
  it('exchanges valid code for access token', async () => {
    const { code, data } = makeCode();
    await storeCode(code, data);

    const res = await handleToken(tokenRequest({
      code, client_id: CLIENT_A, client_secret: SECRET_A, redirect_uri: REDIRECT,
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^pcp_oauth_/);
    expect(body.token_type).toBe('Bearer');
  });

  it('rejects second use of same code (DO single-use)', async () => {
    const { code, data } = makeCode();
    await storeCode(code, data);

    const req = () => tokenRequest({ code, client_id: CLIENT_A, client_secret: SECRET_A, redirect_uri: REDIRECT });
    const res1 = await handleToken(req(), env);
    expect(res1.status).toBe(200);

    const res2 = await handleToken(req(), env);
    const body2 = await res2.json();
    expect(body2.error).toBe('invalid_grant');
  });

  it('rejects code from wrong client_id (binding check)', async () => {
    const { code, data } = makeCode(CLIENT_A);
    await storeCode(code, data);

    const res = await handleToken(tokenRequest({
      code, client_id: CLIENT_B, client_secret: SECRET_B, redirect_uri: REDIRECT,
    }), env);
    const body = await res.json();
    expect(body.error).toBe('invalid_grant');
  });

  it('wrong client cannot burn code — original client can still redeem', async () => {
    const { code, data } = makeCode(CLIENT_A);
    await storeCode(code, data);

    // Client B tries to redeem Client A's code — rejected at binding check
    const resBurn = await handleToken(tokenRequest({
      code, client_id: CLIENT_B, client_secret: SECRET_B, redirect_uri: REDIRECT,
    }), env);
    expect((await resBurn.json()).error).toBe('invalid_grant');

    // Client A can still redeem
    const resA = await handleToken(tokenRequest({
      code, client_id: CLIENT_A, client_secret: SECRET_A, redirect_uri: REDIRECT,
    }), env);
    expect(resA.status).toBe(200);
    expect((await resA.json()).access_token).toMatch(/^pcp_oauth_/);
  });

  it('rejects wrong client_secret', async () => {
    const { code, data } = makeCode();
    await storeCode(code, data);

    const res = await handleToken(tokenRequest({
      code, client_id: CLIENT_A, client_secret: 'wrong', redirect_uri: REDIRECT,
    }), env);
    expect(res.status).toBe(401);
  });
});
