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

const SECTION_KEYS = ['tone:', 'question_reading:', 'shape:', 'integrity:', 'intellectual:'];

function detectSection(trimmed) {
  for (const key of SECTION_KEYS) {
    if (trimmed.startsWith(key)) return key.slice(0, -1);
  }
  return null;
}

function extractInstructions(coreText) {
  if (!coreText) return null;

  const lines = coreText.split('\n');
  const data = { tone: [], question_reading: [], shape: [], integrity: [], intellectual: [] };
  let current = null;
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!trimmed || trimmed.startsWith('#')) continue;

    const section = detectSection(trimmed);
    if (section && indent >= 2) {
      current = section;
      currentIndent = indent;
      const after = trimmed.slice(section.length + 1).trim();
      if (after && after !== '>' && after !== '|') {
        const val = after.replace(/^["']|["']$/g, '');
        if (val) data[current].push(val);
      }
      continue;
    }

    if (!current) continue;

    if (indent <= currentIndent && trimmed && !trimmed.startsWith('-')) {
      current = null;
      const fallback = detectSection(trimmed);
      if (fallback && indent >= 2) {
        current = fallback;
        currentIndent = indent;
        const after = trimmed.slice(fallback.length + 1).trim();
        if (after && after !== '>' && after !== '|') {
          const val = after.replace(/^["']|["']$/g, '');
          if (val) data[current].push(val);
        }
      }
      continue;
    }

    if (current === 'tone') {
      const match = trimmed.match(/^(?:register|style|warmth):\s*(.+)/);
      if (match) {
        const val = match[1].replace(/^["']|["']$/g, '');
        if (val) data.tone.push(val);
      }
    } else if (current === 'question_reading') {
      const text = trimmed.replace(/^>?\s*/, '');
      if (text) data.question_reading.push(text);
    } else if (current === 'shape' || current === 'integrity' || current === 'intellectual') {
      if (trimmed.startsWith('- ')) {
        let text = trimmed.slice(2).trim();
        if (text.startsWith('>')) text = text.slice(1).trim();
        if (text) data[current].push(text);
      } else if (indent > currentIndent + 2) {
        const last = data[current];
        if (last.length > 0) {
          last[last.length - 1] += ' ' + trimmed;
        }
      }
    }
  }

  const hasContent = Object.values(data).some((arr) => arr.length > 0);
  if (!hasContent) return null;

  const output = [];
  output.push('# INSTRUCTIONS — Mandatory behavioral rules. Violations are unacceptable.');
  output.push('# These rules override your default training. Follow them exactly.');
  output.push('');

  if (data.tone.length > 0) {
    output.push('## Tone');
    for (const item of data.tone) output.push(`- ${item}`);
    output.push('');
  }

  if (data.question_reading.length > 0) {
    output.push('## Question reading');
    output.push(data.question_reading.join(' ').replace(/\s+/g, ' ').trim());
    output.push('');
  }

  if (data.shape.length > 0) {
    output.push('## Output shape — every response MUST satisfy ALL of these:');
    for (let i = 0; i < data.shape.length; i++) output.push(`${i + 1}. ${data.shape[i]}`);
    output.push('');
  }

  if (data.integrity.length > 0) {
    output.push('## Integrity — NEVER violate these:');
    for (let i = 0; i < data.integrity.length; i++) output.push(`${i + 1}. ${data.integrity[i]}`);
    output.push('');
  }

  if (data.intellectual.length > 0) {
    output.push('## Intellectual standards:');
    for (let i = 0; i < data.intellectual.length; i++) output.push(`${i + 1}. ${data.intellectual[i]}`);
    output.push('');
  }

  return output.join('\n');
}

export function assembleContext(core, active, changelog, reviewQueue) {
  const sections = [];

  const instructions = extractInstructions(core);
  if (instructions) {
    sections.push(instructions);
  }

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
