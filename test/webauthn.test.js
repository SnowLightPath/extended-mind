import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('WebAuthn route security', () => {
  it('/oauth/authorize/webauthn/skip returns 404', async () => {
    const res = await SELF.fetch('https://host/oauth/authorize/webauthn/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_session_id: 'fake', csrf_token: 'fake' }),
    });
    expect(res.status).toBe(404);
  });

  it('register/begin without csrf_token returns 400', async () => {
    const res = await SELF.fetch('https://host/oauth/authorize/webauthn/register/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing authentication');
  });

  it('register/begin with auth_session_id but no csrf_token returns 400', async () => {
    const res = await SELF.fetch('https://host/oauth/authorize/webauthn/register/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_session_id: 'some-session' }),
    });
    expect(res.status).toBe(400);
  });

  it('register/begin with invalid csrf_token returns 400', async () => {
    const res = await SELF.fetch('https://host/oauth/authorize/webauthn/register/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrf_token: 'invalid-token' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid CSRF token');
  });
});
