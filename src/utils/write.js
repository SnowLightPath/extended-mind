export async function writeAction(env, action, params = {}) {
  const id = env.WRITE_SERIALIZER.idFromName('global');
  const stub = env.WRITE_SERIALIZER.get(id);
  const res = await stub.fetch(new Request('https://do/write', {
    method: 'POST',
    body: JSON.stringify({ action, ...params }),
  }));
  return res.json();
}
