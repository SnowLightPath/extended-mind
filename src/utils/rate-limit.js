const FAILURE_WEIGHT = 5;

export async function checkRateLimit(env, ip, weight = 1) {
  const id = env.WRITE_SERIALIZER.idFromName('global');
  const stub = env.WRITE_SERIALIZER.get(id);
  const res = await stub.fetch(new Request('https://do/write', {
    method: 'POST',
    body: JSON.stringify({ action: 'check_rate_limit', ip, weight }),
  }));
  const data = await res.json();
  return data.allowed;
}

export { FAILURE_WEIGHT };
