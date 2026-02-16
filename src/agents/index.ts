import { ToolLoopAgent, stepCountIs } from "ai";
import type { Message } from "discord.js";
import { join } from "node:path";
import { createModel } from "../utils/model";
import { createDiscordHistoryTool } from "../tools/discord";
import { createLinearTool } from "./linear";
import { createNotionTool } from "./notion";

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
  const userId = message.author.id;

  return new ToolLoopAgent({
    model: createModel(userId),
    instructions,
    tools: {
      linear: createLinearTool(userId),
      notion: createNotionTool(userId),
      discord_history: createDiscordHistoryTool(message),
    },
    stopWhen: stepCountIs(10),
  });
}
