const MAX_REQUESTS = 60;
const WINDOW_TTL = 60; // seconds
const FAILURE_WEIGHT = 5;

export async function checkRateLimit(env, ip, weight = 1) {
  const key = `rate:${ip}`;
  const raw = await env.PCP.get(key);
  const count = raw ? parseInt(raw) : 0;
  if (count >= MAX_REQUESTS) return false;
  await env.PCP.put(key, String(count + weight), { expirationTtl: WINDOW_TTL });
  return true;
}

export { FAILURE_WEIGHT };
