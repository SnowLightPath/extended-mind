const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

export async function classifyMessage(env, message, currentActive) {
  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: buildSystemPrompt(currentActive),
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0].text;
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
Compare message against current active context. Flag ONLY specific factual contradictions:
- Number mismatches (e.g., message says "5人" but active says 3)
- Version conflicts
- Role conflicts
- Implicit arithmetic contradictions (e.g., "2 new members joined" when team count doesn't reflect this)

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
    "Message says team_b has 5 members but active shows 3"
  ],
  "refs": ["projects.agent_framework"]
}

Empty arrays if nothing found.

## Current active context
${JSON.stringify(currentActive, null, 2)}`;
}
