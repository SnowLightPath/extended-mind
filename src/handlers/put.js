import { writeAction } from '../utils/write.js';

async function enqueueWithFallback(env, queue, doAction, payload) {
  try {
    await queue.send(payload);
  } catch {
    // Mirror action expects { platform }, others expect { entry }
    const fallbackPayload = doAction === 'enqueue_github_mirror' ? payload : { entry: payload };
    await writeAction(env, doAction, fallbackPayload);
  }
}

const MAX_MESSAGE_BYTES = 50 * 1024;
const MIN_CLASSIFY_LENGTH = 50;
const DEADLINE_MS = 25_000;
const POST_PROCESS_MS = 3_000;
const TIMED_OUT = Symbol('timeout');

export async function handlePut(args, env, platform, ctx) {
  const { message } = args;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    throw new Error('message must not be empty');
  }

  if (message.length * 4 > MAX_MESSAGE_BYTES) {
    if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
      throw new Error('message exceeds 50KB limit');
    }
  }

  // Strip non-printable control characters (preserve newlines, tabs, carriage returns)
  const sanitized = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const timestamp = new Date().toISOString();

  ctx.waitUntil(asyncWriteAndProcess(env, sanitized, timestamp, platform));

  return {
    content: [{ type: 'text', text: `Stored. (${timestamp})` }],
  };
}

async function asyncWriteAndProcess(env, message, timestamp, platform) {
  await writeAction(env, 'append_session', { entry: { timestamp, platform, message } });

  // Session commit and classification run in parallel
  const [sessionResult, classifyResult] = await Promise.allSettled([
    commitSessionToGitHub(env, message, timestamp, platform),
    message.length >= MIN_CLASSIFY_LENGTH ? classifyAndUpdate(env, message, timestamp, platform) : Promise.resolve(),
  ]);

  // Mirror active.json AFTER classification completes (so it includes new entries)
  try {
    const { putFile } = await import('../services/github.js');
    await mirrorActiveJson(env, putFile, platform);
  } catch (err) {
    console.error('active.json mirror failed (deferred):', err.message);
    await enqueueWithFallback(env, env.QUEUE_GITHUB_MIRROR, 'enqueue_github_mirror', { platform });
  }
}


export async function hashIdempotencyKey(message, timestamp, platform) {
  const data = new TextEncoder().encode(message + '|' + timestamp + '|' + platform);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function mirrorActiveJson(env, putFile, platform) {
  const [activeRaw, sessionsRaw] = await Promise.all([
    env.PCP.get('active'),
    env.PCP.get('sessions'),
  ]);
  if (activeRaw) {
    const active = JSON.parse(activeRaw);
    active.sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
    await putFile(env, 'active.json', JSON.stringify(active, null, 2), `active context mirror from ${platform}`);
  }
}

async function commitSessionToGitHub(env, message, timestamp, platform, retries = 1) {
  try {
    const { getFile, putFile } = await import('../services/github.js');
    const date = timestamp.split('T')[0];

    const yearMonth = date.slice(0, 7);
    const sessionPath = `sessions/${yearMonth}/${date}_${platform}.md`;
    const existing = await getFile(env, sessionPath);
    const sha = existing?.sha ?? null;
    const idempotencyKey = await hashIdempotencyKey(message, timestamp, platform);
    const marker = `<!-- ${idempotencyKey} -->`;
    if (existing?.content.includes(marker)) {
      console.log('GitHub commit: skipped (duplicate)', sessionPath);
      return;
    }
    const newEntry = `\n---\n${marker}\n_${timestamp}_\n\n${message}`;
    const sessionContent = existing
      ? existing.content + newEntry
      : `# Session: ${date} (${platform})\n${newEntry}`;
    await putFile(env, sessionPath, sessionContent, `log from ${platform} at ${timestamp}`, sha);

    console.log('GitHub commit:', sessionPath);
  } catch (err) {
    if (retries > 0 && err.message.includes('409')) {
      return commitSessionToGitHub(env, message, timestamp, platform, retries - 1);
    }
    console.error('GitHub session commit failed (deferred):', err.message);
    await enqueueWithFallback(env, env.QUEUE_GITHUB, 'enqueue_github', { message, timestamp, platform });
  }
}

async function classifyAndUpdate(env, message, timestamp, platform) {
  const deadline = Date.now() + DEADLINE_MS;

  try {
    const { classifyMessage } = await import('../services/classify.js');
    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw || '{}');

    const result = await Promise.race([
      classifyMessage(env, message, active, timestamp),
      new Promise((resolve) => {
        const remaining = deadline - Date.now() - POST_PROCESS_MS;
        if (remaining <= 0) resolve(TIMED_OUT);
        else setTimeout(() => resolve(TIMED_OUT), remaining);
      }),
    ]);

    if (result === TIMED_OUT) {
      await enqueueWithFallback(env, env.QUEUE_CLASSIFY, 'enqueue_pending', { message, timestamp, platform });
      console.log('Classification deferred (timeout)');
      return;
    }

    const applyResult = await writeAction(env, 'apply_classification', { result, timestamp, message });
    if (applyResult.new_entries > 0 || applyResult.new_conflicts > 0 || applyResult.tag_changes > 0) {
      await env.PCP.put('_sweep_dirty', 'true');
    }
  } catch (err) {
    await enqueueWithFallback(env, env.QUEUE_CLASSIFY, 'enqueue_pending', { message, timestamp, platform });
    console.error('Classification deferred (error):', err.message);
  }
}

