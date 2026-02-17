import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { join } from "node:path";
import { createModel } from "../utils/model";
import { createDiscordHistoryTool } from "../tools/discord";
import { createDiscordTool } from "./discord";
import { createDocumentationTool } from "./documentation";
import { createLinearTool } from "./linear";
import { createNotionTool } from "./notion";

const organizerPromptPath = join(import.meta.dir, "../prompts/agent/SYSTEM.md");
const publicPromptPath = join(import.meta.dir, "../prompts/agent/SYSTEM_PUBLIC.md");

/** Cached system prompts, loaded once on first access. */
let organizerPromptCache: string | null = null;
let publicPromptCache: string | null = null;

async function loadOrganizerPrompt(): Promise<string> {
  if (!organizerPromptCache) {
    organizerPromptCache = await Bun.file(organizerPromptPath).text();
  }
  return organizerPromptCache;
}

async function loadPublicPrompt(): Promise<string> {
  if (!publicPromptCache) {
    publicPromptCache = await Bun.file(publicPromptPath).text();
  }
  return publicPromptCache;
}

/** Create a main agent scoped to a Discord message for conversational context. */
export async function createAgent(
  message: Message,
  thread: GuildTextBasedChannel,
  recentMessages?: string,
  organizerMode: boolean = false,
) {
  const baseInstructions = organizerMode
    ? await loadOrganizerPrompt()
    : await loadPublicPrompt();

  const userId = message.author.id;
  const userName = message.author.displayName ?? message.author.username;
  const executionContext = [
    "```yaml",
    "user:",
    `  name: ${JSON.stringify(userName)}`,
    `  id: "${userId}"`,
    "channel:",
    `  id: "${message.channel.id}"`,
    "```",
  ].join("\n");
  const parts = [baseInstructions, `<execution_context>\n${executionContext}\n</execution_context>`];
  if (recentMessages) parts.push(recentMessages);
  const instructions = parts.join("\n\n");

  const tools: ToolSet = organizerMode
    ? {
        linear: createLinearTool(userId),
        notion: createNotionTool(userId),
        discord: createDiscordTool(message, thread),
        discord_history: createDiscordHistoryTool(message),
      }
    : {
        documentation: createDocumentationTool(userId),
        discord_history: createDiscordHistoryTool(message),
      };

  return new ToolLoopAgent({
    model: createModel(userId),
    instructions,
    tools,
    stopWhen: stepCountIs(10),
  });
}
