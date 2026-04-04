function needsQuote(s, inFlow) {
  if (typeof s !== 'string') return false;
  if (s === '') return true;
  if (s === 'true' || s === 'false' || s === 'null') return true;
  if (/^\d/.test(s)) return true;
  if (inFlow && /[,{}[\]]/.test(s)) return true;
  if (/[\n\r\t]/.test(s)) return true;
  if (/: /.test(s) || /^[&*!|>'"%@`?-]/.test(s) || s.includes('#') || /[<>]/.test(s)) return true;
  return false;
}

function q(s, inFlow = false) {
  if (typeof s !== 'string') return String(s ?? 'null');
  if (!needsQuote(s, inFlow)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}"`;
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
  const pairs = Object.entries(obj).map(([k, v]) => `${q(k, true)}: ${flowValue(v)}`);
  return `{ ${pairs.join(', ')} }`;
}

function toYaml(value, indent = 0) {
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
      const k = q(key);
      if (val === null || val === undefined) return `${pad}${k}: null`;
      if (typeof val !== 'object') return `${pad}${k}: ${q(val)}`;

      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${k}: []`;
        const rendered = toYaml(val, indent + 1);
        if (rendered.startsWith('[')) return `${pad}${k}: ${rendered}`;
        return `${pad}${k}:\n${rendered}`;
      }

      if (isLeaf(val)) return `${pad}${k}: ${flowObject(val)}`;
      return `${pad}${k}:\n${toYaml(val, indent + 1)}`;
    })
    .join('\n');
}

const SECTION_KEYS = ['tone:', 'question_reading:', 'shape:', 'integrity:', 'intellectual:', 'lexical_avoid:', 'japanese:'];

function detectSection(trimmed) {
  for (const key of SECTION_KEYS) {
    if (trimmed.startsWith(key)) return key.slice(0, -1);
  }
  return null;
}

function extractInstructions(coreText) {
  if (!coreText) return null;

  const lines = coreText.split('\n');
  const data = { tone: [], question_reading: [], shape: [], integrity: [], intellectual: [], lexical_avoid: [], japanese: [] };
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
        if (text === '>' || text === '|') text = '';
        else if (text.startsWith('>')) text = text.slice(1).trim();
        data[current].push(text);
      } else if (indent > currentIndent + 2) {
        const last = data[current];
        if (last.length > 0) {
          last[last.length - 1] += (last[last.length - 1] ? ' ' : '') + trimmed;
        }
      }
    } else if (current === 'lexical_avoid') {
      if (trimmed.startsWith('- ')) {
        let text = trimmed.slice(2).trim();
        if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
        if (text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1);
        data.lexical_avoid.push(text);
      }
    } else if (current === 'japanese') {
      const match = trimmed.match(/^(?:writing|document|adaptation):\s*(.+)/);
      if (match) {
        const val = match[1].replace(/^["']|["']$/g, '');
        if (val) data.japanese.push(val);
      }
    }
  }

  const hasContent = Object.values(data).some((arr) => arr.length > 0);
  if (!hasContent) return null;

  const output = [];
  output.push('# INSTRUCTIONS');
  output.push('');

  if (data.tone.length > 0 || data.lexical_avoid.length > 0) {
    output.push('## Tone');
    for (const item of data.tone) output.push(`- ${item}`);
    for (const item of data.lexical_avoid) output.push(`- 禁止: ${item}`);
    output.push('');
  }

  if (data.question_reading.length > 0) {
    output.push('## Question reading');
    output.push(data.question_reading.join(' ').replace(/\s+/g, ' ').trim());
    output.push('');
  }

  const renderItems = (arr) => arr.map((s) => s.trim()).filter(Boolean);

  if (data.shape.length > 0) {
    const items = renderItems(data.shape);
    if (items.length > 0) {
      output.push('## Output shape');
      for (let i = 0; i < items.length; i++) output.push(`${i + 1}. ${items[i]}`);
      output.push('');
    }
  }

  if (data.integrity.length > 0) {
    const items = renderItems(data.integrity);
    if (items.length > 0) {
      output.push('## Integrity');
      for (let i = 0; i < items.length; i++) output.push(`${i + 1}. ${items[i]}`);
      output.push('');
    }
  }

  if (data.intellectual.length > 0) {
    const items = renderItems(data.intellectual);
    if (items.length > 0) {
      output.push('## Intellectual standards');
      for (let i = 0; i < items.length; i++) output.push(`${i + 1}. ${items[i]}`);
      output.push('');
    }
  }

  if (data.japanese.length > 0) {
    output.push('## Japanese');
    for (const item of data.japanese) output.push(`- ${item}`);
    output.push('');
  }

  return output.join('\n');
}

function toLocalIso(utcIso, timezone) {
  if (!timezone || !utcIso) return utcIso;
  try {
    const date = new Date(utcIso);
    if (isNaN(date.getTime())) return utcIso;

    const utcMs = date.getTime();
    const utcRef = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzRef = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    const offsetMs = tzRef.getTime() - utcRef.getTime();

    const local = new Date(utcMs + offsetMs);
    const iso = local.toISOString().slice(0, 23); // remove 'Z'

    const sign = offsetMs >= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMs / 60000);
    const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
    const mm = String(Math.round(absMin % 60)).padStart(2, '0');

    return `${iso}${sign}${hh}:${mm}`;
  } catch {
    return utcIso; // invalid timezone → fallback
  }
}

function convertTimestamps(obj, timezone) {
  if (!timezone || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => convertTimestamps(item, timezone));
  }
  const result = { ...obj };
  for (const key of ['timestamp', 'expires_at']) {
    if (typeof result[key] === 'string') {
      result[key] = toLocalIso(result[key], timezone);
    }
  }
  return result;
}

function sanitizeSectionContent(text) {
  return text.replace(/<\/?(?:instructions|core|active)>/gi, '');
}

export function assembleContext(core, active, sessions, timezone) {
  const sections = [];

  const instructions = extractInstructions(core);
  if (instructions) {
    sections.push('<instructions>');
    sections.push(sanitizeSectionContent(instructions));
    sections.push('</instructions>');
  }

  sections.push('');
  sections.push('<core>');
  if (core) {
    const lines = core.split('\n');
    let start = 0;
    while (start < lines.length && (lines[start].startsWith('#') || lines[start].trim() === '')) {
      start++;
    }
    sections.push(sanitizeSectionContent(lines.slice(start).join('\n').trim()));
  } else {
    sections.push('# No context loaded yet. Run seed to initialize.');
  }
  sections.push('</core>');

  sections.push('');
  try {
    const activeObj = active ? JSON.parse(active) || {} : {};
    const visibleEntries = (activeObj.entries || []).filter(e => e.tag !== 'stale');
    const localEntries = visibleEntries.map(e => ({
      id: e.id,
      date: toLocalIso(e.date, timezone) || e.date,
      data: e.data,
    }));
    const displayActive = { entries: localEntries };
    if (activeObj.conflicts && activeObj.conflicts.length > 0) {
      displayActive.conflicts = activeObj.conflicts.map(c => ({
        ids: c.ids,
        issue: c.issue,
      }));
    }
    const sessionsArr = sessions ? JSON.parse(sessions) : [];
    const localSessions = convertTimestamps(sessionsArr, timezone);
    displayActive.sessions = localSessions;
    sections.push(`<active>\n${sanitizeSectionContent(toYaml(displayActive))}\n</active>`);
  } catch {
    sections.push('<active>');
    sections.push('sessions: []');
    sections.push('</active>');
  }


  return sections.join('\n');
}
