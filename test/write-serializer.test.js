import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

function doFetch(action, params = {}) {
  const id = env.WRITE_SERIALIZER.idFromName('global');
  const stub = env.WRITE_SERIALIZER.get(id);
  return stub.fetch(new Request('https://do/write', {
    method: 'POST',
    body: JSON.stringify({ action, ...params }),
  }));
}

async function doAction(action, params = {}) {
  const res = await doFetch(action, params);
  return res.json();
}

describe('WriteSerializer DO — append_session', () => {
  it('appends a session entry to KV', async () => {
    await doAction('append_session', { entry: { timestamp: '2026-01-01T00:00:00Z', platform: 'test', message: 'hello' } });
    const raw = await env.PCP.get('sessions');
    const sessions = JSON.parse(raw);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[sessions.length - 1].message).toBe('hello');
  });

  it('trims to MAX_SESSIONS (20)', async () => {
    for (let i = 0; i < 22; i++) {
      await doAction('append_session', { entry: { timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, platform: 'test', message: `msg-${i}` } });
    }
    const raw = await env.PCP.get('sessions');
    const sessions = JSON.parse(raw);
    expect(sessions.length).toBe(20);
    expect(sessions[sessions.length - 1].message).toBe('msg-21');
  });
});

describe('WriteSerializer DO — apply_classification', () => {
  it('adds new entries to active', async () => {
    const result = { new_entries: [{ data: 'test fact', tag: 'active' }] };
    const data = await doAction('apply_classification', { result, timestamp: '2026-01-02T00:00:00Z', message: 'test input' });
    expect(data.ok).toBe(true);
    expect(data.new_entries).toBe(1);

    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw);
    expect(active.entries.some(e => e.data === 'test fact')).toBe(true);
  });

  it('is idempotent via _processed dedup', async () => {
    const result = { new_entries: [{ data: 'dedup fact' }] };
    const ts = '2026-01-03T00:00:00Z';
    const msg = 'dedup test';
    await doAction('apply_classification', { result, timestamp: ts, message: msg });
    const data2 = await doAction('apply_classification', { result, timestamp: ts, message: msg });
    expect(data2.skipped).toBe(true);

    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw);
    const matches = active.entries.filter(e => e.data === 'dedup fact');
    expect(matches.length).toBe(1);
  });
});

describe('WriteSerializer DO — pending queue (per-platform)', () => {
  it('enqueues per-platform without dropping', async () => {
    for (let i = 0; i < 7; i++) {
      await doAction('enqueue_pending', { entry: { message: `m-${i}`, timestamp: `2026-02-01T00:00:${String(i).padStart(2, '0')}Z`, platform: 'chatgpt' } });
    }
    const raw = await env.PCP.get('pending_classify');
    const queues = JSON.parse(raw);
    expect(queues.chatgpt.length).toBe(7);
    expect(queues.chatgpt[0].message).toBe('m-0');
  });

  it('different platforms retain independent queues', async () => {
    await doAction('enqueue_pending', { entry: { message: 'a', timestamp: '2026-02-02T00:00:00Z', platform: 'claude-code' } });
    const raw = await env.PCP.get('pending_classify');
    const queues = JSON.parse(raw);
    expect(queues['claude-code'].length).toBe(1);
    expect(queues.chatgpt.length).toBe(7);
  });

  it('dequeue returns oldest across all platforms', async () => {
    // claude-code entry has timestamp 2026-02-02, chatgpt entries start at 2026-02-01
    const data = await doAction('dequeue_pending');
    expect(data.item).not.toBeNull();
    expect(data.item.platform).toBe('chatgpt');
  });
});

describe('WriteSerializer DO — gc_active', () => {
  it('removes stale entries past TTL', async () => {
    const pastDate = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    const active = {
      entries: [
        { id: 'expired-1', date: '2026-01-01', data: 'old', tag: 'active', expires_at: pastDate },
        { id: 'fresh-1', date: '2026-04-01', data: 'new', tag: 'active', expires_at: new Date(Date.now() + 86400000).toISOString() },
      ],
      conflicts: [],
    };
    await env.PCP.put('active', JSON.stringify(active));

    const result = await doAction('gc_active');
    expect(result.changed).toBe(true);
    expect(result.entries).toBe(1);

    const activeRaw = await env.PCP.get('active');
    const updated = JSON.parse(activeRaw);
    expect(updated.entries.length).toBe(1);
    expect(updated.entries[0].id).toBe('fresh-1');
  });
});

describe('WriteSerializer DO — github pending queue', () => {
  it('enqueues and dequeues github items', async () => {
    await doAction('enqueue_github', { entry: { message: 'gh-msg', timestamp: '2026-03-01T00:00:00Z', platform: 'test' } });
    const data = await doAction('dequeue_github');
    expect(data.item).not.toBeNull();
    expect(data.item.message).toBe('gh-msg');
  });

  it('returns null when queue is empty', async () => {
    // Drain any remaining items
    let data;
    do {
      data = await doAction('dequeue_github');
    } while (data.item);
    const empty = await doAction('dequeue_github');
    expect(empty.item).toBeNull();
  });
});
