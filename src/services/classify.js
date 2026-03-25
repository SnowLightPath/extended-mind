const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/responses',
    defaultModel: 'gpt-5.4',
    keyName: 'OPENAI_API_KEY',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
    buildBody: (model, system, message, env) => ({
      model,
      reasoning: { effort: env.CLASSIFY_REASONING_EFFORT || 'medium' },
      input: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
      text: { format: { type: 'text' } },
      max_output_tokens: parseInt(env.CLASSIFY_MAX_TOKENS || '16384'),
    }),
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

export async function classifyMessage(env, message, currentActive) {
  const providerName = env.CLASSIFY_PROVIDER || 'openai';
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown classify provider: ${providerName}`);

  const model = env.CLASSIFY_MODEL || provider.defaultModel;
  const apiKey = env[provider.keyName];
  if (!apiKey) throw new Error(`Missing secret: ${provider.keyName}`);

  const system = buildSystemPrompt(currentActive);
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
    throw new Error(`${providerName}: empty classification response`);
  }
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

function buildSystemPrompt(currentActive) {
  return `You are a context classifier for a personal context protocol.
You receive a message that was stored verbatim. Your job is to extract metadata ONLY.
You NEVER modify the original message.

## Tasks

### 1. top_of_mind (required)
Extract 3-5 short tags (max 15 words each) representing current priorities, action items, or active concerns.
Compare with existing top_of_mind:
- Keep items still relevant
- Replace items superseded by new information
- Add new items from this message

### 2. active_updates (required)
Detect factual updates to active context:
- Project version changes (e.g., "v0.3.3 released")
- Team changes (e.g., "new member joined team_b")
- Colleague role changes
- Organizational changes
Return {path, value} pairs using dot notation.
ONLY include changes with clear, specific factual information. Do NOT infer or guess.

### 3. contradictions (required)
Compare message against current active context. Flag ONLY specific factual contradictions.

For each contradiction, return an object:
- "issue" (required): Human-readable description of the contradiction
- "path" (optional): Dot-notation path in active context where the conflict exists
- "expected" (optional): The value the message claims is correct

When path and expected are provided, the system can auto-resolve the contradiction
when active context is later updated to match. Provide them whenever the contradiction
maps to a specific active field.

Do NOT flag:
- Additions (new info not in active)
- Elaborations (more detail about existing info)
- Opinions or assessments

### 4. refs (required)
List related parts of active context using dot notation.

## Output: JSON ONLY. No markdown, no explanation.

{
  "top_of_mind": ["item 1", "item 2", "item 3"],
  "active_updates": [
    {"path": "projects.agent_framework.version", "value": "0.3.3"}
  ],
  "contradictions": [
    {"path": "projects.team_b.count", "expected": 5, "issue": "message says 5 members but active shows 3"},
    {"issue": "BRID-63 referenced but does not exist in Jira"}
  ],  // structured (path+expected) → auto-resolvable; issue-only → TTL expiry
  "refs": ["projects.agent_framework"]
}

Empty arrays if nothing found.

## Current active context
${JSON.stringify(currentActive, null, 2)}`;
}
