export const tools = [
  {
    name: 'context_get',
    description:
      'Retrieve your full personal context — identity, active work state, recent changes, and pending reviews. Call this at the start of every conversation to understand who you are working with and what is in progress. No parameters needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'Get personal context',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    is_consequential: false,
  },
  {
    name: 'context_log',
    description:
      'Log a context message from this conversation. The message is logged exactly as you write it — verbatim, no editing. Write a summary that a different AI on a different platform can read tomorrow and fully understand what happened.\n\nWriting guidelines:\n- Include ALL proper nouns (people, projects, tools, orgs)\n- Include ALL numbers, dates, versions\n- Include reasoning and rationale, not just decisions\n- Include action items with responsible parties\n- Write in the language the conversation used',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Natural language context message to store',
        },
      },
      required: ['message'],
    },
    annotations: {
      title: 'Log context message',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    is_consequential: false,
  },
];
