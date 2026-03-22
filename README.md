# ✦ Extended Mind

<p align="center">
  <img src="assets/banner.webp" alt="Extended Mind" width="600">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/SnowLightPath/extended-mind" alt="License"></a>
  <a href="https://github.com/SnowLightPath/extended-mind"><img src="https://img.shields.io/github/stars/SnowLightPath/extended-mind" alt="GitHub Stars"></a>
  <a href="https://github.com/SnowLightPath/extended-mind"><img src="https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/protocol-MCP-5A67D8" alt="MCP"></a>
</p>

**Your context, shared across every AI platform.**

Extended Mind is a Personal Context Protocol — a single MCP server that gives Claude, ChatGPT, Codex, and any MCP-compatible AI access to the same personal context.

Two tools. That's it.

```
context_get()  → returns who you are, what you're working on, what happened recently
context_log(m) → stores a message verbatim — the next AI on a different platform reads it
```

## 💡 Why

You switch between Claude Chat, Claude Code, ChatGPT, Codex. Each session starts from zero. Extended Mind fixes this: one server, one context, every platform.

```
☀️  Morning — Claude Code:  "Refactored the executor to use async"
               └→ context_log(summary)

🌤️ Afternoon — ChatGPT:   context_get()
               └→ "This morning you refactored the executor..."

🌙 Evening — Claude Chat:  context_get()
               └→ knows everything from today
```

## 🏗️ Architecture

```
+---------------+  +---------------+  +---------------+
|  Claude Chat  |  |    ChatGPT    |  |     Codex     |
|  Claude Code  |  |  (OAuth MCP)  |  |               |
+-------+-------+  +-------+-------+  +-------+-------+
        |                   |                  |
        +-------------------+------------------+
                            |
                POST /mcp (Streamable HTTP)
                            |
                  +---------+---------+
                  |    Cloudflare     |
                  |      Worker       |
                  |                   |
                  |  context_get ---->| KV read (~3ms)
                  |  context_log ---->| KV write (~3ms)
                  |                   |   +-> Claude classify (async)
                  |                   |   +-> GitHub backup (async)
                  +-------------------+
```

- **⚡ KV** — hot storage for all reads/writes
- **📦 GitHub** — async version history backup (your private data repo)
- **🔍 Claude API** — classifies logged messages, extracts priorities, detects contradictions
- **🔑 WebAuthn** — passkey authentication (Touch ID / Face ID) on OAuth authorize
- **🔗 OAuth 2.0** — authorization code flow for ChatGPT / Claude Chat, with `/oauth/revoke` (RFC 7009)

## 🚀 Quick Start

### 1. Deploy

```bash
git clone https://github.com/SnowLightPath/extended-mind.git
cd extended-mind
npm install

# Create KV namespace
npx wrangler kv namespace create PCP
# → Copy the ID into wrangler.toml

# Set secrets
npx wrangler secret put PCP_TOKEN         # your bearer token (generate any 64-char hex)
npx wrangler secret put GITHUB_TOKEN      # GitHub PAT with repo scope
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SECRET    # GitHub webhook HMAC-SHA256 secret

# Configure wrangler.toml
# - Set KV namespace ID
# - Set GITHUB_REPO to your private data repo (e.g., "yourname/my-mind")

npx wrangler deploy
```

### 2. Create your data repo

Create a **private** GitHub repository for your personal context data (e.g., `yourname/my-mind`). This is where the Worker backs up `core.yaml`, `active.json`, and session logs.

Add a webhook in the data repo (Settings → Webhooks):

| Field | Value |
|-------|-------|
| Payload URL | `https://your-worker.workers.dev/webhook` |
| Content type | `application/json` |
| Secret | Same value as `WEBHOOK_SECRET` (required — webhook is rejected without it) |
| Events | Just the push event |

This enables automatic core sync: when you push changes to `seed/core.yaml`, the webhook notifies the Worker, which updates KV. A cron trigger also runs as a fallback every 5 minutes.

### 3. Seed your context

Edit `seed/core.yaml` with your identity. Copy `seed/active.example.json` to `seed/active.json` and edit with your work context. Place these in your private data repo (not this repo), then:

```bash
node seed/seed-kv.js
```

This writes 4 initial KV keys (`core`, `active`, `changelog`, `review_queue`). Additional keys (OAuth tokens, CSRF tokens, WebAuthn credentials) are created at runtime. **Initial setup only** — re-running resets everything and wipes the active context that AI clients have built up.

### 4. Update core

Core is the human-owned layer — identity, ontology, interaction rules. AI clients cannot write to it.

```bash
# Edit seed/core.yaml, then:
git add seed/core.yaml
git commit -m "your change description"
git push
```

The webhook fires → Worker fetches → KV updated. No wrangler commands needed.

### 5. Connect your AI clients

**🟠 Claude Code** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "extended-mind": {
      "url": "https://your-worker.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_PCP_TOKEN"
      }
    }
  }
}
```

Global setting — all projects get access. Add `"mcp__extended-mind"` to `permissions.allow` to auto-approve.

**🟠 Claude Chat** — Settings → Connectors → Add custom connector:

| Field | Value |
|-------|-------|
| Remote MCP Server URL | `https://your-worker.workers.dev/mcp` |
| OAuth Client ID | Your registered client ID |
| OAuth Client Secret | Your registered client secret |

**🔵 ChatGPT** — Settings → Apps → Create app (native MCP, not Custom GPT):

| Field | Value |
|-------|-------|
| MCP Server URL | `https://your-worker.workers.dev/mcp` |
| Authentication | OAuth |
| Auth URL | `https://your-worker.workers.dev/oauth/authorize` |
| Token URL | `https://your-worker.workers.dev/oauth/token` |

**🔵 Codex** — two steps:

1. Settings → MCP servers → Connect a custom MCP:

| Field | Value |
|-------|-------|
| URL | `https://your-worker.workers.dev/mcp` |
| Bearer token env var | `MCP_BEARER_TOKEN` |

2. Add to `~/.zshrc` or `~/.bashrc`:

```bash
export MCP_BEARER_TOKEN="YOUR_PCP_TOKEN"
```

Codex reads the env var from the shell, not from the MCP settings UI. Restart shell and start a new thread.

### 6. Verify

```bash
# Get context
curl -s -X POST https://your-worker.workers.dev/mcp \
  -H "Authorization: Bearer $PCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"context_get","arguments":{}}}' \
  | jq -r '.result.content[0].text'

# Log a message
curl -s -X POST https://your-worker.workers.dev/mcp \
  -H "Authorization: Bearer $PCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"context_log","arguments":{"message":"Testing Extended Mind setup"}}}'
```

## 📐 How It Works

**Your context has two layers:**

| Layer | What | Who edits | How |
|-------|------|-----------|-----|
| **🔒 Core** | Identity, ontology, interaction rules | You only | Edit `seed/core.yaml` → git push → webhook → KV |
| **📝 Active** | Team, projects, priorities, recent sessions | AI clients | `context_log()` → KV + GitHub + classification |

When an AI calls `context_log`:
1. Message stored **verbatim** in KV (sync, ~3ms)
2. Claude API classifies in the background — updates priorities, flags contradictions
3. GitHub gets an async backup commit

When an AI calls `context_get`:
- Returns everything as a single YAML document (~2500-3000 tokens)
- The AI now knows who you are, what you're working on, and what happened across all platforms

## 🔐 Security

- **WebAuthn Passkeys** — Touch ID / Face ID / security key authentication on the OAuth authorize page. Register at `/passkey`, then use Conditional UI (browser auto-suggests passkey on the token input field)
- **XSS Protection** — all dynamic values in OAuth HTML are entity-encoded
- **CSRF Protection** — one-time tokens on the authorize form
- **Token TTL** — OAuth tokens expire after 90 days (re-auth required)
- **Token Revocation** — `POST /oauth/revoke` (RFC 7009) to invalidate compromised tokens
- **Webhook Signature** — HMAC-SHA256 verification required (`WEBHOOK_SECRET`)
- **Constant-time Comparison** — client secret verification resistant to timing attacks

## 🔄 Development: Design-Doc Loop

This project uses **[Design-Doc Loop (DDL)](https://github.com/SnowLightPath/DDL)** — a human-LLM collaborative development methodology where a living design document (`design.md`) serves as shared cognition between sessions.

The name "Extended Mind" comes from the [Extended Mind thesis](https://doi.org/10.1093/analys/58.1.7) (Clark & Chalmers, 1998), which argues that cognitive processes extend beyond the brain into the environment. In DDL, `design.md` functions as Otto's notebook — an external artifact that is constitutive of the design process, not merely a record of it.

**The loop:** Draft (experience first) → Realize (design → code) → Reflect (code → design)

| Command | What it does |
|---------|-------------|
| `/draft` | Design the experience before writing code |
| `/realize` | Implement what `design.md` describes |
| `/reflect` | Detect drift between code and design, reconcile |
| `/refactoring` | Audit code quality against detection targets |
| `/docs` | Audit and fix documentation |
| `/commit` | Verify, commit, push, deploy |

Each command runs through phases with `+++DETECT` targets that catch violations automatically and `+++STOP` gates that require human approval before proceeding.

> `design.md` is gitignored — it's working notes, not a deliverable. Code is the source of truth.

### References

- Clark, A. & Chalmers, D. (1998). "The Extended Mind." *Analysis*, 58(1), 7–19. [doi:10.1093/analys/58.1.7](https://doi.org/10.1093/analys/58.1.7)
- [Design-Doc Loop (DDL)](https://github.com/SnowLightPath/DDL) — Human-LLM collaborative development methodology

## 🔀 Data Separation

Extended Mind uses two repositories:

| Repo | Visibility | Purpose |
|------|-----------|---------|
| `extended-mind` | Public | Source code (this repo) |
| Your data repo | **Private** | Context data synced by the Worker (`core.yaml`, `active.json`, sessions) |

Your personal context never touches the code repository.

## ⚖️ License

[MIT](LICENSE)
