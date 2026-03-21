function needsQuote(s, inFlow) {
  if (typeof s !== 'string') return false;
  if (s === '') return true;
  if (s === 'true' || s === 'false' || s === 'null') return true;
  if (/^\d/.test(s)) return true;
  if (inFlow && /[,{}[\]]/.test(s)) return true;
  if (/: /.test(s) || /^[&*!|>'"%@`?-]/.test(s) || s.includes('#')) return true;
  return false;
}

function q(s, inFlow = false) {
  if (typeof s !== 'string') return String(s ?? 'null');
  if (!needsQuote(s, inFlow)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isLeaf(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return true;
  return Object.values(obj).every(
    (v) =>
      typeof v !== 'object' ||
      v === null ||
      (Array.isArray(v) && v.every((item) => typeof item !== 'object' || item === null)),
  );
}

function flowValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return q(v, true);
  if (Array.isArray(v)) {
    return `[${v.map((item) => (typeof item === 'string' ? q(item, true) : String(item))).join(', ')}]`;
  }
  return JSON.stringify(v);
}

function flowObject(obj) {
  const pairs = Object.entries(obj).map(([k, v]) => `${k}: ${flowValue(v)}`);
  return `{ ${pairs.join(', ')} }`;
}

export function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);

  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return q(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';

    if (value.every((v) => typeof v !== 'object' || v === null)) {
      const totalLen = value.reduce((n, v) => n + String(v).length, 0);
      if (totalLen < 60) {
        return `[${value.map((v) => (typeof v === 'string' ? q(v, true) : String(v))).join(', ')}]`;
      }
      return value.map((v) => `${pad}- ${q(v)}`).join('\n');
    }

    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          if (isLeaf(item)) {
            return `${pad}- ${flowObject(item)}`;
          }
          const entries = Object.entries(item);
          const lines = entries.map(([k, v], i) => {
            const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
            if (typeof v === 'object' && v !== null && !isLeaf(v)) {
              return `${prefix}${k}:\n${toYaml(v, indent + 2)}`;
            }
            const rendered =
              typeof v === 'object' && v !== null
                ? isLeaf(v)
                  ? flowObject(v)
                  : toYaml(v, indent + 2)
                : toYaml(v, indent + 2);
            return `${prefix}${k}: ${rendered}`;
          });
          return lines.join('\n');
        }
        return `${pad}- ${toYaml(item, indent + 1)}`;
      })
      .join('\n');
  }

  if (isLeaf(value) && indent > 0) {
    return flowObject(value);
  }

  return Object.entries(value)
    .map(([key, val]) => {
      if (val === null || val === undefined) return `${pad}${key}: null`;
      if (typeof val !== 'object') return `${pad}${key}: ${q(val)}`;

      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${key}: []`;
        const rendered = toYaml(val, indent + 1);
        if (rendered.startsWith('[')) return `${pad}${key}: ${rendered}`;
        return `${pad}${key}:\n${rendered}`;
      }

      if (isLeaf(val)) return `${pad}${key}: ${flowObject(val)}`;
      return `${pad}${key}:\n${toYaml(val, indent + 1)}`;
    })
    .join('\n');
}

export function assembleContext(core, active, changelog, reviewQueue) {
  const sections = [];

  sections.push('---');
  sections.push('# CORE (read-only — human-edited only)');
  if (core) {
    const lines = core.split('\n');
    let start = 0;
    while (start < lines.length && (lines[start].startsWith('#') || lines[start].trim() === '')) {
      start++;
    }
    sections.push(lines.slice(start).join('\n').trim());
  } else {
    sections.push('# No context loaded yet. Run seed to initialize.');
  }

  sections.push('');
  sections.push('---');
  sections.push('# ACTIVE CONTEXT');
  if (active) {
    sections.push(toYaml(JSON.parse(active)));
  } else {
    sections.push('sessions: []');
  }

  sections.push('');
  sections.push('---');
  sections.push('# RECENT CHANGES (last 7 days)');
  if (changelog) {
    const changes = JSON.parse(changelog);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = changes.filter((c) => new Date(c.timestamp).getTime() > weekAgo);
    sections.push(recent.length > 0 ? toYaml({ changes: recent }) : 'changes: []');
  } else {
    sections.push('changes: []');
  }

  if (reviewQueue) {
    const queue = JSON.parse(reviewQueue);
    if (queue.length > 0) {
      sections.push('');
      sections.push('---');
      sections.push('# PENDING REVIEW');
      sections.push(toYaml({ review_queue: queue }));
    }
  }

  return sections.join('\n');
}
