async function verifySignature(secret, body, signature) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected =
    'sha256=' +
    Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');

  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function processWebhook(payload, env) {
  const commits = payload.commits || [];
  const changedFiles = commits.flatMap((c) => [...(c.added || []), ...(c.modified || [])]);
  const sourceRepo = payload.repository?.full_name;

  if (!sourceRepo || sourceRepo !== env.GITHUB_REPO) {
    console.warn(`Webhook ignored: source repo "${sourceRepo}" does not match GITHUB_REPO "${env.GITHUB_REPO}"`);
    return [];
  }

  const results = [];

  if (changedFiles.includes('seed/core.yaml') && sourceRepo) {
    const { getFileFromRepo } = await import('../services/github.js');
    const file = await getFileFromRepo(env, sourceRepo, 'seed/core.yaml');
    if (file) {
      await env.PCP.put('core', file.content);
      await env.PCP.put('_core_sha', file.sha);
      const { invalidateCache } = await import('../utils/cache.js');
      await invalidateCache(env);
      results.push('core synced');
    }
  }

  if (changedFiles.includes('active.json')) {
    const { getFileFromRepo } = await import('../services/github.js');
    let file = await getFileFromRepo(env, sourceRepo, 'active.json');
    if (file) {
      try {
        const parsed = JSON.parse(file.content);
        delete parsed.sessions;
        file.content = JSON.stringify(parsed);
      } catch {
        results.push('active.json invalid JSON, skipped');
        file = null;
      }
    }
    if (file) {
      await env.PCP.put('active', file.content);
      const { invalidateCache } = await import('../utils/cache.js');
      await invalidateCache(env);
      results.push('active synced');
    }
  }

  console.log('Webhook:', results.length > 0 ? results.join(', ') : 'no relevant changes');
  return results;
}

const MAX_WEBHOOK_BODY = 5 * 1024 * 1024; // 5MB

export async function handleWebhook(request, env, ctx) {
  const contentLength = parseInt(request.headers.get('content-length') || '0');
  if (contentLength > MAX_WEBHOOK_BODY) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();
  if (body.length > MAX_WEBHOOK_BODY) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Webhook not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const signature = request.headers.get('x-hub-signature-256');
  const valid = await verifySignature(env.WEBHOOK_SECRET, body, signature);
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Webhook idempotency via X-GitHub-Delivery header
  const deliveryId = request.headers.get('x-github-delivery');
  if (deliveryId) {
    const idempKey = `webhook:delivery:${deliveryId}`;
    const seen = await env.PCP.get(idempKey);
    if (seen) {
      return new Response(JSON.stringify({ ok: true, deduplicated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await env.PCP.put(idempKey, '1', { expirationTtl: 86400 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  ctx.waitUntil(processWebhook(payload, env));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
