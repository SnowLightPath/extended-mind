const MAX_SESSIONS = 20;
const MAX_CHANGELOG = 50;
const MAX_MESSAGE_BYTES = 50 * 1024;

export async function handlePut(args, env, platform, ctx) {
  const { message } = args;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    throw new Error('message must not be empty');
  }

  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    throw new Error('message exceeds 50KB limit');
  }

  const timestamp = new Date().toISOString();

  const activeRaw = await env.PCP.get('active');
  const active = activeRaw ? JSON.parse(activeRaw) : { sessions: [] };

  if (!active.sessions) active.sessions = [];
  active.sessions.push({ timestamp, platform, message });
  if (active.sessions.length > MAX_SESSIONS) {
    active.sessions = active.sessions.slice(-MAX_SESSIONS);
  }

  await env.PCP.put('active', JSON.stringify(active));

  const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
  ctx.waitUntil(asyncPostProcess(env, message, timestamp, platform, preview));

  return {
    content: [{ type: 'text', text: `Stored. (${timestamp})` }],
  };
}

async function asyncPostProcess(env, message, timestamp, platform, preview) {
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
}

async function commitToGitHub(env, message, timestamp, platform) {
  try {
    const { getFile, putFile } = await import('../services/github.js');
    const date = timestamp.split('T')[0];

    const sessionPath = `sessions/${date}_${platform}.md`;
    const existing = await getFile(env, sessionPath);
    const newEntry = `\n---\n_${timestamp}_\n\n${message}`;
    const sessionContent = existing
      ? existing.content + newEntry
      : `# Session: ${date} (${platform})\n${newEntry}`;
    await putFile(env, sessionPath, sessionContent, `log from ${platform} at ${timestamp}`);

    const active = await env.PCP.get('active');
    if (active) {
      await putFile(env, 'active.json', active, `active context mirror from ${platform}`);
    }

    console.log('GitHub commit:', sessionPath);
  } catch (err) {
    console.error('GitHub commit failed:', err.message);
  }
}

async function classifyAndUpdate(env, message, timestamp, platform) {
  try {
    const { classifyMessage } = await import('../services/classify.js');

    const activeRaw = await env.PCP.get('active');
    const active = JSON.parse(activeRaw || '{}');

    const result = await classifyMessage(env, message, active);

    // D6 fix: Re-read active to get latest state after Claude API call (~2s).
    // Merge only classify-owned fields to avoid overwriting concurrent put() sessions.
    const freshRaw = await env.PCP.get('active');
    const fresh = JSON.parse(freshRaw || '{}');

    if (result.top_of_mind && result.top_of_mind.length > 0) {
      fresh.top_of_mind = result.top_of_mind;
    }

    if (result.active_updates && result.active_updates.length > 0) {
      for (const update of result.active_updates) {
        applyUpdate(fresh, update.path, update.value);
      }
    }

    await env.PCP.put('active', JSON.stringify(fresh));

    if (result.contradictions && result.contradictions.length > 0) {
      const queueRaw = await env.PCP.get('review_queue');
      const queue = JSON.parse(queueRaw || '[]');
      for (const c of result.contradictions) {
        queue.push({
          timestamp,
          platform,
          type: 'contradiction',
          issue: c,
          source_preview: message.slice(0, 200),
        });
      }
      while (queue.length > 20) queue.shift();
      await env.PCP.put('review_queue', JSON.stringify(queue));
    }

    console.log('Classification:', {
      top_of_mind: result.top_of_mind?.length || 0,
      updates: result.active_updates?.length || 0,
      contradictions: result.contradictions?.length || 0,
    });
  } catch (err) {
    console.error('Classification failed:', err.message);
  }
}

function applyUpdate(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}
