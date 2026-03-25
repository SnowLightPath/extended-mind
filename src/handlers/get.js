import { assembleContext } from '../utils/yaml.js';
import { getMemCache, setMemCache } from '../utils/cache.js';

export async function handleGet(env, ctx) {
  // Layer 2: isolate in-memory cache (~1ms)
  const mem = getMemCache();
  if (mem) {
    return { content: [{ type: 'text', text: mem }] };
  }

  // Layer 1: KV pre-computed cache (~3-5ms)
  const cached = await env.PCP.get('cache:response');
  if (cached) {
    setMemCache(cached);
    return { content: [{ type: 'text', text: cached }] };
  }

  // Cache miss: full rebuild (~30ms)
  const [core, active, sessions, changelog, reviewQueue] = await Promise.all([
    env.PCP.get('core'),
    env.PCP.get('active'),
    env.PCP.get('sessions'),
    env.PCP.get('changelog'),
    env.PCP.get('review_queue'),
  ]);

  const yaml = assembleContext(core, active, sessions, changelog, reviewQueue, env.TIMEZONE);
  setMemCache(yaml);

  // Async: write KV cache for other isolates
  if (ctx) {
    ctx.waitUntil(env.PCP.put('cache:response', yaml, { expirationTtl: 3600 }));
  }

  return { content: [{ type: 'text', text: yaml }] };
}
