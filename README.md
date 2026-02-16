# Purdue Hackers AI Bot

A Discord bot for Purdue Hackers that uses a multi-agent architecture to help members manage Linear issues and Notion docs through natural conversation.

Mention the bot in any channel to interact with it. It creates a thread, streams a response, and delegates work to specialized subagents:

- **Linear agent** — search, create, and update issues, projects, initiatives, documents, and more
- **Notion agent** — search, create, and update pages, databases, and comments

Built with [Bun](https://bun.sh), [discord.js](https://discord.js.org), and the [Vercel AI SDK](https://ai-sdk.dev).

## Architecture

```
                     ┌──────────────────┐
  @mention ────────▶ │   Orchestrator   │
                     │   ToolLoopAgent  │
                     └────────┬─────────┘
                              │
                   tool calls to subagents
                              │
               ┌──────────────┼─────────────┐
               ▼              ▼             ▼
        ┌────────────┐ ┌────────────┐ ┌───────────┐
        │   Linear   │ │   Notion   │ │   Tools   │
        │  ToolLoop  │ │  ToolLoop  │ │  (plain)  │
        └──────┬─────┘ └──────┬─────┘ └───────────┘
               │              │
         Linear API     Notion API
```

The bot is a multi-agent system built on the Vercel AI SDK's `ToolLoopAgent`. Each layer is a full agent loop that can reason and make multiple tool calls before returning.

1. **Orchestrator** — the top-level agent. It receives a Discord message, reads thread context, decides which subagents to call, and synthesizes a final response.

2. **Subagents** (Linear, Notion) — each subagent is exposed to the orchestrator as a single tool. Internally, each is its own `ToolLoopAgent` with a dedicated system prompt and a full set of API tools. Adding a new integration means adding a new subagent — the orchestrator doesn't need to know the details.

3. **Skill system** — subagents use progressive tool disclosure. Each starts with a small set of read-only base tools. To unlock write tools, the subagent calls `load_skill`, which reads a `SKILL.md` file and activates the associated tools for that step. This keeps the tool surface small until the agent actually needs to write.

## Setup

```bash
bun install
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `AI_GATEWAY_API_KEY` | API key for the AI gateway |
| `LINEAR_API_KEY` | Linear API key |
| `NOTION_TOKEN` | Notion integration token |

## Commands

```bash
bun run dev        # Start the bot
bun run lint       # Lint with oxlint
bun run format     # Format with oxfmt
bun run typecheck  # Type-check with tsc
```
