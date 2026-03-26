const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/responses',
    defaultModel: 'gpt-4.1-mini',
    keyName: 'OPENAI_API_KEY',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
    buildBody: (model, system, message, env) => {
      const body = {
        model,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: message },
        ],
        text: { format: { type: 'json_object' } },
        max_output_tokens: parseInt(env.CLASSIFY_MAX_TOKENS || '4096'),
      };
      const effort = env.CLASSIFY_REASONING_EFFORT;
      if (effort) {
        body.reasoning = { effort };
      }
      return body;
    },
    parseText: (data) => {
      const msg = data.output.find((o) => o.type === 'message');
      return msg?.content?.[0]?.text;
    },
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    keyName: 'ANTHROPIC_API_KEY',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (model, system, message, env) => ({
      model,
      max_tokens: parseInt(env.CLASSIFY_MAX_TOKENS || '4096'),
      system,
      messages: [{ role: 'user', content: message }],
    }),
    parseText: (data) => data.content[0].text,
  },
};

async function callProvider(env, system, message) {
  const providerName = env.CLASSIFY_PROVIDER || 'openai';
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown classify provider: ${providerName}`);

  const model = env.CLASSIFY_MODEL || provider.defaultModel;
  const apiKey = env[provider.keyName];
  if (!apiKey) throw new Error(`Missing secret: ${provider.keyName}`);

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: provider.buildHeaders(apiKey),
    body: JSON.stringify(provider.buildBody(model, system, message, env)),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${providerName} API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = provider.parseText(data);
  if (!text) {
    throw new Error(`${providerName}: empty response`);
  }

  try {
    return JSON.parse(text);
  } catch {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  }
}

export async function classifyMessage(env, message, currentActive) {
  return callProvider(env, buildSystemPrompt(currentActive), message);
}

export async function classifySweep(env, currentActive) {
  return callProvider(
    env,
    buildSweepPrompt(currentActive),
    'Review active context for internal consistency.',
  );
}

function buildSystemPrompt(currentActive) {
  const compact = compactForClassify(currentActive);
  return `Context classifier for a personal knowledge system.
Extract structured metadata from a log message. Never modify the original.

Return JSON:
- top_of_mind: 3-5 priority tags (max 15 words). Keep relevant, replace superseded, add new.
- active_updates: [{path, value}] for factual changes (dot notation). Explicit facts only. Set value to null to remove stale fields.
- contradictions: [{path, expected, issue}] when mappable to a context field. {issue} only when unmappable. Ignore additions, elaborations, opinions.
- refs: [path] related context paths.

Empty arrays when nothing found.

Context:
${JSON.stringify(compact)}`;
}

function buildSweepPrompt(currentActive) {
  const compact = compactForClassify(currentActive);
  return `Consistency reviewer for a personal knowledge system.
Review the context for internal contradictions, stale data, and outdated fields.

Return JSON:
- active_updates: [{path, value}] to fix stale values. Set value to null to remove outdated fields. High confidence only.
- contradictions: [{path, expected, issue}] for inconsistencies found.

Empty arrays when clean.

Context:
${JSON.stringify(compact)}`;
}

function compactForClassify(active) {
  if (!active || typeof active !== 'object') return {};
  return truncateDeep(active, 100);
}

function truncateDeep(obj, maxLen) {
  if (typeof obj === 'string') {
    return obj.length > maxLen ? obj.slice(0, maxLen) + '…' : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => truncateDeep(v, maxLen));
  if (typeof obj === 'object' && obj !== null) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateDeep(v, maxLen);
    }
    return out;
  }
  return obj;
}
