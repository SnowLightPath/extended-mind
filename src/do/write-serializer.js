import { invalidateCache } from '../utils/cache.js';

const MAX_SESSIONS = 20;
const ENTRY_TTL_MS = 30 * 24 * 3600 * 1000;
const CONFLICT_TTL_MS = 72 * 3600 * 1000;
const MAX_PENDING_WARN_THRESHOLD = 50;

async function hashKey(message, timestamp) {
  const data = new TextEncoder().encode(message + '|' + timestamp);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class WriteSerializer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const body = await request.json();
    switch (body.action) {
      case 'append_session': return this.appendSession(body);
      case 'apply_classification': return this.applyClassification(body);
      case 'gc_active': return this.gcActive();
      case 'enqueue_pending': return this.enqueuePending(body);
      case 'dequeue_pending': return this.dequeuePending();
      case 'enqueue_github': return this.enqueueGitHub(body);
      case 'dequeue_github': return this.dequeueGitHub();
      case 'enqueue_github_mirror': return this.enqueueGitHubMirror(body);
      case 'dequeue_github_mirror': return this.dequeueGitHubMirror();
      case 'peek_pending': return this.peekPending();
      case 'peek_github': return this.peekGitHub();
      case 'peek_github_mirror': return this.peekGitHubMirror();
      default: return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  }

  async appendSession({ entry }) {
    const raw = await this.env.PCP.get('sessions');
    let sessions = raw ? JSON.parse(raw) : [];
    sessions.push(entry);
    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(-MAX_SESSIONS);
    }
    await this.env.PCP.put('sessions', JSON.stringify(sessions));
    await invalidateCache(this.env);
    return Response.json({ ok: true });
  }

  async applyClassification({ result, timestamp, message }) {
    const freshRaw = await this.env.PCP.get('active');
    const active = JSON.parse(freshRaw || '{"entries":[],"conflicts":[]}');
    if (!Array.isArray(active.entries)) active.entries = [];
    if (!Array.isArray(active.conflicts)) active.conflicts = [];

    active._processed = active._processed || [];
    const processId = await hashKey(message || '', timestamp);
    if (active._processed.includes(processId)) {
      return Response.json({ ok: true, skipped: true });
    }

    let changed = false;
    const eventTime = new Date(timestamp).getTime();
    const expiresAt = new Date(eventTime + ENTRY_TTL_MS).toISOString();

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

    if (result.new_conflicts?.length > 0) {
      for (const nc of result.new_conflicts) {
        const resolvedIds = nc.ids.map(id => idMap[id] || id);
        active.conflicts.push({
          ids: resolvedIds,
          issue: nc.issue,
          created_at: new Date().toISOString(),
        });
        for (const eid of resolvedIds) {
          const entry = active.entries.find(e => e.id === eid);
          if (entry) {
            entry.expires_at = new Date(Date.now() + ENTRY_TTL_MS).toISOString();
          }
        }
      }
      changed = true;
    }

    if (result.resolved_conflicts?.length > 0) {
      const staledIds = new Set((result.tag_changes || []).filter(c => c.new_tag === 'stale').map(c => c.id));
      for (const rc of result.resolved_conflicts) {
        const sortedIds = [...rc.ids].sort();
        active.conflicts = active.conflicts.filter(c => {
          const cSorted = [...c.ids].sort();
          return JSON.stringify(cSorted) !== JSON.stringify(sortedIds);
        });
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

    await this.env.PCP.put('active', JSON.stringify(active));
    if (changed) {
      await invalidateCache(this.env);
    }

    return Response.json({
      ok: true,
      changed,
      new_entries: result.new_entries?.length || 0,
      tag_changes: result.tag_changes?.length || 0,
      new_conflicts: result.new_conflicts?.length || 0,
      resolved_conflicts: result.resolved_conflicts?.length || 0,
    });
  }

  async gcActive() {
    const activeRaw = await this.env.PCP.get('active');
    if (!activeRaw) return Response.json({ ok: true, changed: false });
    const active = JSON.parse(activeRaw);

    const now = Date.now();
    let changed = false;
    let needResweep = false;

    for (const entry of active.entries) {
      if (entry.tag !== 'stale' && entry.expires_at && new Date(entry.expires_at).getTime() < now) {
        entry.tag = 'stale';
        changed = true;
      }
    }

    const beforeLen = active.entries.length;
    active.entries = active.entries.filter(e => e.tag !== 'stale');
    if (active.entries.length !== beforeLen) changed = true;

    if (active.conflicts?.length > 0) {
      const entryIds = new Set(active.entries.map(e => e.id));
      const beforeConflicts = active.conflicts.length;
      active.conflicts = active.conflicts.filter(c => {
        if (c.created_at && new Date(c.created_at).getTime() + CONFLICT_TTL_MS < now) return false;
        if (c.ids.some(id => !entryIds.has(id))) return false;
        return true;
      });
      if (active.conflicts.length !== beforeConflicts) changed = true;
    }

    const stillConflictedIds = new Set((active.conflicts || []).flatMap(c => c.ids));
    for (const entry of active.entries) {
      if (entry.tag === 'conflict' && !stillConflictedIds.has(entry.id)) {
        entry.tag = 'active';
        entry.expires_at = new Date(now + ENTRY_TTL_MS).toISOString();
        changed = true;
        needResweep = true;
      }
    }

    if (changed) {
      await this.env.PCP.put('active', JSON.stringify(active));
      await invalidateCache(this.env);
    }

    return Response.json({
      ok: true,
      changed,
      needResweep,
      entries: active.entries.length,
      conflicts: active.conflicts?.length || 0,
    });
  }

  async enqueuePending({ entry }) {
    const raw = await this.env.PCP.get('pending_classify');
    const queues = raw ? JSON.parse(raw) : {};
    // Migrate legacy array format
    if (Array.isArray(queues)) {
      const migrated = {};
      for (const item of queues) {
        const key = item.platform || 'unknown';
        if (!migrated[key]) migrated[key] = [];
        migrated[key].push({ message: item.message, timestamp: item.timestamp });
      }
      return this._enqueueTo(migrated, entry);
    }
    return this._enqueueTo(queues, entry);
  }

  async _enqueueTo(queues, entry) {
    const key = entry.platform || 'unknown';
    if (!queues[key]) queues[key] = [];
    queues[key].push({ message: entry.message || '', timestamp: entry.timestamp });
    if (queues[key].length > MAX_PENDING_WARN_THRESHOLD) {
      console.warn('pending_classify queue large:', key, queues[key].length);
    }
    await this.env.PCP.put('pending_classify', JSON.stringify(queues));
    return Response.json({ ok: true });
  }

  async dequeuePending() {
    const raw = await this.env.PCP.get('pending_classify');
    if (!raw) return Response.json({ item: null });
    let queues = JSON.parse(raw);
    // Migrate legacy array format
    if (Array.isArray(queues)) {
      if (queues.length === 0) return Response.json({ item: null });
      const item = queues.shift();
      await this.env.PCP.put('pending_classify', JSON.stringify(queues));
      return Response.json({ item });
    }
    let oldest = null;
    let oldestKey = null;
    for (const [key, items] of Object.entries(queues)) {
      if (items.length > 0 && (!oldest || items[0].timestamp < oldest.timestamp)) {
        oldest = items[0];
        oldestKey = key;
      }
    }
    if (!oldest) return Response.json({ item: null });
    queues[oldestKey].shift();
    if (queues[oldestKey].length === 0) delete queues[oldestKey];
    await this.env.PCP.put('pending_classify', JSON.stringify(queues));
    return Response.json({ item: { ...oldest, platform: oldestKey } });
  }

  async enqueueGitHub({ entry }) {
    const raw = await this.env.PCP.get('pending_github');
    const queue = raw ? JSON.parse(raw) : [];
    queue.push(entry);
    if (queue.length > 50) {
      console.warn('pending_github queue large:', queue.length);
    }
    await this.env.PCP.put('pending_github', JSON.stringify(queue));
    return Response.json({ ok: true });
  }

  async dequeueGitHub() {
    const raw = await this.env.PCP.get('pending_github');
    if (!raw) return Response.json({ item: null });
    const queue = JSON.parse(raw);
    if (queue.length === 0) return Response.json({ item: null });
    const item = queue.shift();
    await this.env.PCP.put('pending_github', JSON.stringify(queue));
    return Response.json({ item });
  }

  async enqueueGitHubMirror({ platform }) {
    const raw = await this.env.PCP.get('pending_github_mirror');
    const queue = raw ? JSON.parse(raw) : [];
    // Deduplicate — only one pending mirror per platform
    if (!queue.includes(platform)) {
      queue.push(platform);
    }
    await this.env.PCP.put('pending_github_mirror', JSON.stringify(queue));
    return Response.json({ ok: true });
  }

  async dequeueGitHubMirror() {
    const raw = await this.env.PCP.get('pending_github_mirror');
    if (!raw) return Response.json({ platform: null });
    const queue = JSON.parse(raw);
    if (queue.length === 0) return Response.json({ platform: null });
    const platform = queue.shift();
    await this.env.PCP.put('pending_github_mirror', JSON.stringify(queue));
    return Response.json({ platform });
  }

  // Peek methods — read without removing (for safe drain)
  async peekPending() {
    const raw = await this.env.PCP.get('pending_classify');
    if (!raw) return Response.json({ item: null });
    let queues = JSON.parse(raw);
    if (Array.isArray(queues)) {
      return Response.json({ item: queues[0] || null });
    }
    let oldest = null;
    let oldestKey = null;
    for (const [key, items] of Object.entries(queues)) {
      if (items.length > 0 && (!oldest || items[0].timestamp < oldest.timestamp)) {
        oldest = items[0];
        oldestKey = key;
      }
    }
    return Response.json({ item: oldest ? { ...oldest, platform: oldestKey } : null });
  }

  async peekGitHub() {
    const raw = await this.env.PCP.get('pending_github');
    if (!raw) return Response.json({ item: null });
    const queue = JSON.parse(raw);
    return Response.json({ item: queue[0] || null });
  }

  async peekGitHubMirror() {
    const raw = await this.env.PCP.get('pending_github_mirror');
    if (!raw) return Response.json({ platform: null });
    const queue = JSON.parse(raw);
    return Response.json({ platform: queue[0] || null });
  }
}
