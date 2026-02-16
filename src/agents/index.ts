import { ToolLoopAgent, gateway, stepCountIs } from "ai";
import type { Message } from "discord.js";
import { join } from "node:path";
import { createDiscordHistoryTool } from "../tools/discord";
import { linearTool } from "./linear";
import { notionTool } from "./notion";

const systemPromptPath = join(import.meta.dir, "../prompts/agent/SYSTEM.md");

/** Cached system prompt, loaded once on first access. */
let systemPromptCache: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!systemPromptCache) {
    systemPromptCache = await Bun.file(systemPromptPath).text();
  }
  return systemPromptCache;
}

/** Create a main agent scoped to a Discord message for conversational context. */
export async function createAgent(message: Message) {
  const instructions = await loadSystemPrompt();
  return new ToolLoopAgent({
    model: gateway("anthropic/claude-sonnet-4"),
    instructions,
    tools: {
      linear: linearTool,
      notion: notionTool,
      discord_history: createDiscordHistoryTool(message),
    },
    stopWhen: stepCountIs(10),
  });
}
