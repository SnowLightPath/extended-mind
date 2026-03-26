import { invalidateCache } from '../utils/cache.js';

const MAX_SESSIONS = 20;
const MAX_CHANGELOG = 50;
const MAX_MESSAGE_BYTES = 50 * 1024;
const TTL_HOURS = 72;
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
  const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;

  ctx.waitUntil(asyncWriteAndProcess(env, message, timestamp, platform, preview));

  return {
    content: [{ type: 'text', text: `Stored. (${timestamp})` }],
  };
}

async function asyncWriteAndProcess(env, message, timestamp, platform, preview) {
  // Sessions write (separated from active)
  let sessionsRaw = await env.PCP.get('sessions');
  let sessions;

  if (sessionsRaw === null) {
    // Lazy migration: extract sessions from active
    const activeRaw = await env.PCP.get('active');
    const active = activeRaw ? JSON.parse(activeRaw) : {};
    sessions = active.sessions || [];
    if (active.sessions) {
      delete active.sessions;
      await env.PCP.put('active', JSON.stringify(active));
    }
  } else {
    sessions = JSON.parse(sessionsRaw);
  }

  sessions.push({ timestamp, platform, message });
  if (sessions.length > MAX_SESSIONS) {
    sessions = sessions.slice(-MAX_SESSIONS);
  }
  await env.PCP.put('sessions', JSON.stringify(sessions));
  await invalidateCache(env);

  await Promise.allSettled([
    updateChangelog(env, timestamp, preview),
    commitToGitHub(env, message, timestamp, platform),
    message.length >= 50 ? classifyAndUpdate(env, message, timestamp, platform) : Promise.resolve(),
  ]);
}

async function updateChangelog(env, timestamp, preview) {
  const changelogRaw = await env.PCP.get('changelog');
  const changelog = changelogRaw ? JSON.parse(changelogRaw) : [];
  changelog.unshift({ timestamp, preview });
  if (changelog.length > MAX_CHANGELOG) {
    changelog.length = MAX_CHANGELOG;
  }
  await env.PCP.put('changelog', JSON.stringify(changelog));
  await invalidateCache(env);
}

async function commitToGitHub(env, message, timestamp, platform) {
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

    // GitHub mirror: reconstruct full active with sessions
    const [activeRaw, sessionsRaw] = await Promise.all([
      env.PCP.get('active'),
      env.PCP.get('sessions'),
    ]);
    if (activeRaw) {
      const active = JSON.parse(activeRaw);
      active.sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
      await putFile(env, 'active.json', JSON.stringify(active, null, 2), `active context mirror from ${platform}`);
    }

    console.log('GitHub commit:', sessionPath);
  } catch (err) {
    console.error('GitHub commit failed:', err.message);
  }
}

async function classifyAndUpdate(env, message, timestamp, platform) {
  const deadline = Date.now() + DEADLINE_MS;

  try {
    const { classifyMessage } = await import('../services/classify.js');
    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw || '{}');

    const result = await Promise.race([
      classifyMessage(env, message, active),
      new Promise((resolve) => {
        const remaining = deadline - Date.now() - POST_PROCESS_MS;
        if (remaining <= 0) resolve(TIMED_OUT);
        else setTimeout(() => resolve(TIMED_OUT), remaining);
      }),
    ]);

    if (result === TIMED_OUT) {
      await enqueuePending(env, message, timestamp, platform);
      console.log('Classification deferred (timeout)');
      return;
    }

    await applyClassification(env, result, message, timestamp, platform);
    if (result.contradictions?.length > 0 || result.active_updates?.length > 0) {
      await env.PCP.put('_sweep_dirty', 'true');
    }
  } catch (err) {
    try {
      await enqueuePending(env, message, timestamp, platform);
    } catch {}
    console.error('Classification deferred (error):', err.message);
  }
}

export async function applyClassification(env, result, message, timestamp, platform) {
  const freshRaw = await env.PCP.get('active');
  const fresh = JSON.parse(freshRaw || '{}');

  if (result.top_of_mind?.length > 0) {
    fresh.top_of_mind = result.top_of_mind;
  }

  if (result.active_updates?.length > 0) {
    for (const update of result.active_updates) {
      if (update.path) applyUpdate(fresh, update.path, update.value);
    }
  }

  await env.PCP.put('active', JSON.stringify(fresh));
  await invalidateCache(env);

  // Auto-heal: structured contradictions → apply expected as update
  let healedCount = 0;
  if (result.contradictions?.length > 0) {
    for (const contradiction of result.contradictions) {
      if (typeof contradiction !== 'string' && contradiction.path && contradiction.expected !== undefined) {
        applyUpdate(fresh, contradiction.path, contradiction.expected);
        healedCount++;
      }
    }
    if (healedCount > 0) {
      await env.PCP.put('active', JSON.stringify(fresh));
      await invalidateCache(env);
    }
  }

  // Contradiction processing: TTL cleanup → add new → reactive resolve
  const freshQueueRaw = await env.PCP.get('review_queue');
  let freshQueue = JSON.parse(freshQueueRaw || '[]');

  const now = Date.now();
  const preFilterLen = freshQueue.length;
  freshQueue = freshQueue.filter((item) => {
    const expiry = item.expires_at
      ? new Date(item.expires_at).getTime()
      : item.timestamp
        ? new Date(item.timestamp).getTime() + TTL_HOURS * 3600000
        : Infinity;
    return expiry > now;
  });
  const ttlRemoved = preFilterLen - freshQueue.length;

  const beforeLen = freshQueue.length;

  if (result.contradictions?.length > 0) {
    for (const contradiction of result.contradictions) {
      const item = typeof contradiction === 'string' ? { issue: contradiction } : contradiction;
      freshQueue.push({
        timestamp,
        platform,
        type: 'contradiction',
        ...item,
        source_preview: message.slice(0, 200),
        expires_at: new Date(Date.now() + TTL_HOURS * 3600000).toISOString(),
      });
    }
  }

  // Reactive: auto-resolve structured contradictions whose expected value now matches active
  let resolvedCount = 0;
  freshQueue = freshQueue.filter((item) => {
    if (!item.path || item.expected === undefined) return true;
    const current = getNestedValue(fresh, item.path);
    if (JSON.stringify(current) === JSON.stringify(item.expected)) {
      resolvedCount++;
      return false;
    }
    return true;
  });

  const hasChanges = ttlRemoved > 0 || beforeLen !== freshQueue.length || (result.contradictions?.length > 0);
  if (hasChanges) {
    while (freshQueue.length > 20) freshQueue.shift();
    await env.PCP.put('review_queue', JSON.stringify(freshQueue));
    await invalidateCache(env);
  }

  console.log('Classification:', {
    top_of_mind: result.top_of_mind?.length || 0,
    updates: result.active_updates?.length || 0,
    contradictions: result.contradictions?.length || 0,
    healed: healedCount,
    resolved: resolvedCount,
    ttl_removed: ttlRemoved,
  });
}

async function enqueuePending(env, message, timestamp, platform) {
  const raw = await env.PCP.get('pending_classify');
  const queue = raw ? JSON.parse(raw) : [];
  queue.push({ message: message.slice(0, 2000), timestamp, platform });
  while (queue.length > 10) queue.shift();
  await env.PCP.put('pending_classify', JSON.stringify(queue));
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function applyUpdate(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
      if (value === null) return;
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  if (value === null) {
    delete current[keys[keys.length - 1]];
  } else {
    current[keys[keys.length - 1]] = value;
  }
}
