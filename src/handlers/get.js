import { assembleContext } from '../utils/yaml.js';
import { getMemCache, setMemCache } from '../utils/cache.js';

export async function handleGet(env, ctx) {
  const mem = getMemCache();
  if (mem) {
    return { content: [{ type: 'text', text: mem }] };
  }

  const cached = await env.PCP.get('cache:response');
  if (cached) {
    setMemCache(cached);
    return { content: [{ type: 'text', text: cached }] };
  }

  const [core, activeRaw, sessions] = await Promise.all([
    env.PCP.get('core'),
    env.PCP.get('active'),
    env.PCP.get('sessions'),
  ]);

  const yaml = assembleContext(core, activeRaw, sessions, env.TIMEZONE);
  setMemCache(yaml);

  if (ctx) {
    ctx.waitUntil(env.PCP.put('cache:response', yaml, { expirationTtl: 3600 }));
  }

  return { content: [{ type: 'text', text: yaml }] };
}
