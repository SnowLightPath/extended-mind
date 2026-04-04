import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleClassifyMessage, handleGitHubMirrorMessage } from '../src/index.js';
import { hashIdempotencyKey } from '../src/handlers/put.js';
import { writeAction } from '../src/utils/write.js';

describe('handleClassifyMessage', () => {
  it('adds new entries to active', async () => {
    // Stub: classifyMessage is an external LLM call — we test the apply path
    // by calling writeAction directly (same as handleClassifyMessage does after classification)
    const result = { new_entries: [{ data: 'queue test fact' }] };
    const applyResult = await writeAction(env, 'apply_classification', {
      result, timestamp: '2026-05-01T00:00:00Z', message: 'queue test',
    });
    expect(applyResult.ok).toBe(true);
    expect(applyResult.new_entries).toBe(1);

    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw);
    expect(active.entries.some(e => e.data === 'queue test fact')).toBe(true);
  });

  it('is idempotent via _processed', async () => {
    const result = { new_entries: [{ data: 'idem queue fact' }] };
    const ts = '2026-05-02T00:00:00Z';
    const msg = 'idem queue msg';
    await writeAction(env, 'apply_classification', { result, timestamp: ts, message: msg });
    const dup = await writeAction(env, 'apply_classification', { result, timestamp: ts, message: msg });
    expect(dup.skipped).toBe(true);
  });
});

describe('hashIdempotencyKey', () => {
  it('produces different hashes for different messages at same timestamp', async () => {
    const ts = '2026-05-03T00:00:00.000Z';
    const h1 = await hashIdempotencyKey('message A', ts, 'claude-code');
    const h2 = await hashIdempotencyKey('message B', ts, 'claude-code');
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for same message on different platforms', async () => {
    const ts = '2026-05-03T00:00:00.000Z';
    const msg = 'same message';
    const h1 = await hashIdempotencyKey(msg, ts, 'chatgpt');
    const h2 = await hashIdempotencyKey(msg, ts, 'claude-code');
    expect(h1).not.toBe(h2);
  });

  it('produces same hash for identical inputs', async () => {
    const ts = '2026-05-03T00:00:00.000Z';
    const msg = 'identical';
    const h1 = await hashIdempotencyKey(msg, ts, 'chatgpt');
    const h2 = await hashIdempotencyKey(msg, ts, 'chatgpt');
    expect(h1).toBe(h2);
  });
});

describe('KV fallback — enqueue/dequeue still works', () => {
  it('enqueue_pending stores to KV', async () => {
    await writeAction(env, 'enqueue_pending', {
      entry: { message: 'fallback msg', timestamp: '2026-06-01T00:00:00Z', platform: 'test' },
    });
    const raw = await env.PCP.get('pending_classify');
    const queues = JSON.parse(raw);
    expect(queues.test.some(e => e.message === 'fallback msg')).toBe(true);
  });

  it('dequeue_pending returns stored item', async () => {
    const res = await writeAction(env, 'dequeue_pending');
    expect(res.item).not.toBeNull();
  });

  it('enqueue_github stores to KV', async () => {
    await writeAction(env, 'enqueue_github', {
      entry: { message: 'gh fallback', timestamp: '2026-06-02T00:00:00Z', platform: 'test' },
    });
    const res = await writeAction(env, 'dequeue_github');
    expect(res.item.message).toBe('gh fallback');
  });
});
