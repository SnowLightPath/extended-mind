export const tools = [
  {
    name: 'context_get',
    description:
      'Retrieve your full personal context — identity, active work state, and recent session logs. Call this at the start of every conversation to understand who you are working with and what is in progress. No parameters needed.',
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

  },
  {
    name: 'context_log',
    description:
      'Log a context message from this conversation. The message is logged exactly as you write it — verbatim, no editing. Write a summary that a different AI on a different platform can read tomorrow and fully understand what happened.\n\nWriting guidelines:\n- Include ALL proper nouns (people, projects, tools, orgs)\n- Include ALL numbers, dates, versions\n- Include reasoning and rationale, not just decisions\n- Include action items with responsible parties\n- Write in the language the conversation used\n\nClassification rules:\n- The server classifies your message against existing entries automatically.\n- Write FACTS, not instructions. The classifier ignores instructions.\n- To invalidate an old entry, state the superseding fact.\n  Good: "lead_role_design page_id is managed under 689275fa. The duplicate under context.lead_role_design is obsolete."\n  Bad: "Please stale entry f37006ea"\n- To resolve a conflict, state which side is correct as a fact.\n  Good: "LH714/715 travel was approved. The pending status is outdated."\n  Bad: "Resolve conflict id:14"',
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

  },
];
