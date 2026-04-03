import { invalidateCache } from '../utils/cache.js';

async function hashKey(message, timestamp) {
  const data = new TextEncoder().encode(message + '|' + timestamp);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

const MAX_SESSIONS = 20;
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
  // Sessions write (separated from active)
  const sessionsRaw = await env.PCP.get('sessions');
  let sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];

  sessions.push({ timestamp, platform, message });
  if (sessions.length > MAX_SESSIONS) {
    sessions = sessions.slice(-MAX_SESSIONS);
  }
  await env.PCP.put('sessions', JSON.stringify(sessions));
  await invalidateCache(env);

  await Promise.allSettled([
    commitToGitHub(env, message, timestamp, platform),
    message.length >= MIN_CLASSIFY_LENGTH ? classifyAndUpdate(env, message, timestamp, platform) : Promise.resolve(),
  ]);
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
      classifyMessage(env, message, active, timestamp),
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

    await applyClassification(env, result, timestamp, message);
    if (result.new_conflicts?.length > 0 || result.tag_changes?.length > 0) {
      await env.PCP.put('_sweep_dirty', 'true');
    }
  } catch (err) {
    try {
      await enqueuePending(env, message, timestamp, platform);
    } catch {}
    console.error('Classification deferred (error):', err.message);
  }
}

export async function applyClassification(env, result, timestamp, message) {
  const freshRaw = await env.PCP.get('active');
  const active = JSON.parse(freshRaw || '{"entries":[],"conflicts":[]}');
  if (!Array.isArray(active.entries)) active.entries = [];
  if (!Array.isArray(active.conflicts)) active.conflicts = [];

  // Idempotent: skip if already processed
  active._processed = active._processed || [];
  const processId = await hashKey(message || '', timestamp);
  if (active._processed.includes(processId)) {
    console.log('Classification V2: skipped (duplicate)', processId);
    return;
  }

  let changed = false;
  const ENTRY_TTL_MS = 30 * 24 * 3600 * 1000;
  const eventTime = new Date(timestamp).getTime();
  const expiresAt = new Date(eventTime + ENTRY_TTL_MS).toISOString();

  // 1. tag_changes — includes active restoration (conflict → active with TTL reset)
  if (result.tag_changes?.length > 0) {
    for (const change of result.tag_changes) {
      const entry = active.entries.find(e => e.id === change.id);
      if (entry) {
        entry.tag = change.new_tag;
        if (change.new_tag === 'active') {
          entry.expires_at = new Date(Date.now() + ENTRY_TTL_MS).toISOString();
        }
        changed = true;
      }
    }
  }

  // 2. new_entries — generate UUIDs, build id map for $N replacement
  const idMap = {};
  if (result.new_entries?.length > 0) {
    for (let i = 0; i < result.new_entries.length; i++) {
      const ne = result.new_entries[i];
      const id = crypto.randomUUID();
      idMap[`$${i}`] = id;
      active.entries.push({
        id,
        date: timestamp,
        data: ne.data,
        tag: ne.tag || 'active',
        expires_at: expiresAt,
      });
    }
    changed = true;
  }

  // 3. new_conflicts — replace $N placeholders with actual UUIDs, reset TTL on conflict entries
  if (result.new_conflicts?.length > 0) {
    for (const nc of result.new_conflicts) {
      const resolvedIds = nc.ids.map(id => idMap[id] || id);
      active.conflicts.push({
        ids: resolvedIds,
        issue: nc.issue,
        created_at: new Date().toISOString(),
      });
      // Reset TTL on entries entering conflict so they don't expire before conflict resolves
      for (const eid of resolvedIds) {
        const entry = active.entries.find(e => e.id === eid);
        if (entry) {
          entry.expires_at = new Date(Date.now() + ENTRY_TTL_MS).toISOString();
        }
      }
    }
    changed = true;
  }

  // 4. resolved_conflicts — remove record, restore winners
  if (result.resolved_conflicts?.length > 0) {
    const staledIds = new Set((result.tag_changes || []).filter(c => c.new_tag === 'stale').map(c => c.id));
    for (const rc of result.resolved_conflicts) {
      const sortedIds = [...rc.ids].sort();
      active.conflicts = active.conflicts.filter(c => {
        const cSorted = [...c.ids].sort();
        return JSON.stringify(cSorted) !== JSON.stringify(sortedIds);
      });
      // Restore winners: entries in this conflict that weren't staled
      for (const eid of rc.ids) {
        if (staledIds.has(eid)) continue;
        const entry = active.entries.find(e => e.id === eid);
        if (entry && entry.tag === 'conflict') {
          entry.tag = 'active';
          entry.expires_at = new Date(Date.now() + ENTRY_TTL_MS).toISOString();
        }
      }
    }
    changed = true;
  }

  active._processed.push(processId);
  if (active._processed.length > 50) active._processed.shift();

  await env.PCP.put('active', JSON.stringify(active));
  if (changed) {
    await invalidateCache(env);
  }

  console.log('Classification V2:', {
    new_entries: result.new_entries?.length || 0,
    tag_changes: result.tag_changes?.length || 0,
    new_conflicts: result.new_conflicts?.length || 0,
    resolved_conflicts: result.resolved_conflicts?.length || 0,
  });
}

async function enqueuePending(env, message, timestamp, platform) {
  const raw = await env.PCP.get('pending_classify');
  const queue = raw ? JSON.parse(raw) : [];
  queue.push({ message: message.slice(0, 2000), timestamp, platform });
  while (queue.length > 10) queue.shift();
  await env.PCP.put('pending_classify', JSON.stringify(queue));
}

