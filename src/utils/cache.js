let memCache = null;
const MEM_TTL_MS = 60_000;

export function getMemCache() {
  if (memCache && Date.now() - memCache.ts < MEM_TTL_MS) return memCache.text;
  return null;
}

export function setMemCache(text) {
  memCache = { text, ts: Date.now() };
}

export function clearMemCache() {
  memCache = null;
}

export async function invalidateCache(env) {
  clearMemCache();
  await env.PCP.delete('cache:response');
}
