import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';

describe('CodeRedemption DO', () => {
  it('first claim succeeds', async () => {
    const id = env.CODE_REDEMPTION.idFromName('test-code-1');
    const stub = env.CODE_REDEMPTION.get(id);
    const res = await stub.fetch(new Request('https://do/claim', { method: 'POST' }));
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('second claim on same code fails', async () => {
    const id = env.CODE_REDEMPTION.idFromName('test-code-2');
    const stub = env.CODE_REDEMPTION.get(id);

    const res1 = await stub.fetch(new Request('https://do/claim', { method: 'POST' }));
    expect((await res1.json()).ok).toBe(true);

    const res2 = await stub.fetch(new Request('https://do/claim', { method: 'POST' }));
    const data2 = await res2.json();
    expect(data2.ok).toBe(false);
    expect(data2.error).toBe('already_claimed');
  });

  it('alarm clears storage', async () => {
    const id = env.CODE_REDEMPTION.idFromName('test-code-alarm');
    const stub = env.CODE_REDEMPTION.get(id);

    await stub.fetch(new Request('https://do/claim', { method: 'POST' }));
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // After alarm, storage is cleared — verify via runInDurableObject
    await runInDurableObject(stub, async (_, state) => {
      const claimed = await state.storage.get('claimed');
      expect(claimed).toBeUndefined();
    });
  });

  it('rejects non-POST methods', async () => {
    const id = env.CODE_REDEMPTION.idFromName('test-code-get');
    const stub = env.CODE_REDEMPTION.get(id);
    const res = await stub.fetch(new Request('https://do/claim', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});
