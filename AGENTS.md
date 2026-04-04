# Extended Mind

## Protocol

→ DDL-PROTOCOL
→ Read `.Codex/commands/DDL-PROTOCOL-SKILL.md` before executing any command

## Commands

| Command | Intent |
|---------|--------|
| `/draft` | Write the user-side experience first |
| `/realize` | Write code based on design principles |
| `/reflect` | Update documents based on implementation |
| `/commit` | Git commit |
| `/docs` | Audit and fix documentation |
| `/refactoring` | Audit and fix code quality |

## Structure

- `design.md` - Design Document (PCP detailed specification)
- `seed/core.yaml` - Initial core context (human identity + ontology)
- `seed/active.template.json` - Initial active context template (work state)

## Detection Targets

Every command defines its own D1–D7. Cross-cutting targets below apply globally.

+++DETECT:
  G1: Vague Intent — Task description lacks measurable outcome
  G2: Scope Creep — Change touches files outside stated scope
  G3: Principle Violation — Action contradicts design.md principles
  G4: Missing Validation — No verification step after mutation
  G5: Leaked Specifics — Project-specific paths/commands hardcoded in framework files
  G6: Silent Failure — Error swallowed without user notification
  G7: Unreviewed Mutation — Shared artifact changed without +++STOP
  G8: Compression Violation — put() message rewritten or restructured by server
  G9: Core Write Violation — AI client writes to core layer

## Behavior

### On session start

1. Read `AGENTS.md` (this file)
2. Read `design.md` if it exists — extract scopes, principles, validation commands
3. If Extended Mind MCP is configured and `EM_ENABLED` env var is set: call `context_get()`

### On any task

1. Identify which scopes (from `design.md`) are affected
2. Run the command's Phase sequence
3. Scan for Detection Targets at each phase boundary

### On completion

1. Summarize what changed (files, lines, scopes)
2. List any Detection Targets that fired
3. Suggest next command if applicable (`/draft` → `/realize` → `/reflect`)
4. If `EM_ENABLED` and significant decisions: call `context_log()` via Extended Mind

## Extended Mind Integration (opt-in)

This repo can integrate with Extended Mind MCP for cross-platform context sharing.
To enable, set `EM_ENABLED=1` in your environment before starting the agent.
Without this flag, `context_get()` and `context_log()` calls are skipped.

## Project Context

Extended Mind is a Personal Context Protocol — an MCP server (Cloudflare Worker) that shares context across all AI platforms. Two tools only: `context_get()` and `context_log(message)`.

> `seed/` contains anonymized templates only. Real data (identity, team, projects) lives in the user's private data repo.

### Key Principles (from design.md)
- **Verbatim storage** — put() messages are never rewritten
- **Compression happens once** — only client AI summarizes, server never re-compresses
- **KV primary, Git backup** — Cloudflare KV is hot store, GitHub is async version history
- **Human owns core** — only human can edit core.yaml (in the private data repo, not this repo)
- **All AI clients use MCP** — Codex Chat, Codex, ChatGPT (native MCP via apps), Codex
- **Streamable HTTP** — single /mcp endpoint, MCP spec 2025-03-26

### Stack
- Cloudflare Worker + KV
- GitHub (your private data repo)
- LLM API (write classification, provider configurable via CLASSIFY_PROVIDER)

### Secrets (set via wrangler)
```bash
npx wrangler secret put PCP_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put OPENAI_API_KEY      # when CLASSIFY_PROVIDER=openai
npx wrangler secret put ANTHROPIC_API_KEY   # when CLASSIFY_PROVIDER=anthropic
npx wrangler secret put WEBHOOK_SECRET
```

## Two-Repo System

- ExtendedMind (~/Dashboard/ExtendedMind): Cloudflare Workers server code — public
- MyMind (~/Dashboard/MyMind): data files only — private, no Cloudflare operations

### Constraints
- MyMind contains no wrangler calls, no KV operations, no Cloudflare tooling
- For KV seeding, use ExtendedMind/seed/seed-kv-real.js --data-dir ~/Dashboard/MyMind/seed
- Session logs go into sessions/YYYY-MM/ subdirectories
- core.yaml is human-edited only — read it, never write it

### When editing code
State what you will change and why before touching any file.
Scope changes to the stated task only — do not refactor, add comments,
or add error handling unless explicitly asked.

### When editing data
active.json and sessions/ are Worker-managed. Do not edit them manually.
seed/core.yaml changes require a git commit and push to take effect via webhook.

## Git Identity

This is a public repo under `SnowLightPath`. All commits must use:
```
user.name:  SnowLightPath
user.email: SnowLightPath@users.noreply.github.com
```
commit.md D7 checks against this identity.

## Constraints

+++NEVER: Hardcode paths or commands — scopes and validation come from design.md
+++NEVER: Auto-proceed past a +++STOP
+++NEVER: Spawn agents for single-scope tasks — swarm is optional
+++NEVER: Add AI attribution to commits or generated code
+++NEVER: Rewrite or restructure content passed to context_log — store verbatim
+++NEVER: Reference "Custom GPT" — ChatGPT uses native MCP via apps, not Custom GPT
+++NEVER: Auto-edit seed/core.yaml — Core changes are human-only via git push
