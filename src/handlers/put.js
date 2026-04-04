import { writeAction } from '../utils/write.js';

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

  const timestamp = new Date().toISOString();

  ctx.waitUntil(asyncWriteAndProcess(env, message, timestamp, platform));

  return {
    content: [{ type: 'text', text: `Stored. (${timestamp})` }],
  };
}

async function asyncWriteAndProcess(env, message, timestamp, platform) {
  await writeAction(env, 'append_session', { entry: { timestamp, platform, message } });

  await Promise.allSettled([
    commitToGitHub(env, message, timestamp, platform),
    message.length >= MIN_CLASSIFY_LENGTH ? classifyAndUpdate(env, message, timestamp, platform) : Promise.resolve(),
  ]);
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

async function commitToGitHub(env, message, timestamp, platform, retries = 1) {
  try {
    const { getFile, putFile } = await import('../services/github.js');
    const date = timestamp.split('T')[0];

    const yearMonth = date.slice(0, 7);
    const sessionPath = `sessions/${yearMonth}/${date}_${platform}.md`;
    const existing = await getFile(env, sessionPath);
    const newEntry = `\n---\n_${timestamp}_\n\n${message}`;
    const sessionContent = existing
      ? existing.content + newEntry
      : `# Session: ${date} (${platform})\n${newEntry}`;
    await putFile(env, sessionPath, sessionContent, `log from ${platform} at ${timestamp}`);

    // GitHub mirror (separate error handling to avoid session re-append on retry)
    try {
      await mirrorActiveJson(env, putFile, platform);
    } catch (mirrorErr) {
      if (mirrorErr.message.includes('409')) {
        try { await mirrorActiveJson(env, putFile, platform); } catch {}
      } else {
        console.error('GitHub active.json mirror failed:', mirrorErr.message);
      }
    }

    console.log('GitHub commit:', sessionPath);
  } catch (err) {
    if (retries > 0 && err.message.includes('409')) {
      return commitToGitHub(env, message, timestamp, platform, retries - 1);
    }
    console.error('GitHub commit failed (deferred):', err.message);
    try {
      await writeAction(env, 'enqueue_github', { entry: { message, timestamp, platform } });
    } catch {}
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
      await writeAction(env, 'enqueue_pending', { entry: { message, timestamp, platform } });
      console.log('Classification deferred (timeout)');
      return;
    }

    const applyResult = await writeAction(env, 'apply_classification', { result, timestamp, message });
    if (applyResult.new_entries > 0 || applyResult.new_conflicts > 0 || applyResult.tag_changes > 0) {
      await env.PCP.put('_sweep_dirty', 'true');
    }
  } catch (err) {
    try {
      await writeAction(env, 'enqueue_pending', { entry: { message, timestamp, platform } });
    } catch {}
    console.error('Classification deferred (error):', err.message);
  }
}

